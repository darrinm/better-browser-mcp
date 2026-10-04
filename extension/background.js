// Chrome Debug Bridge — MV3 service worker.
//
// Connects to a local MCP server over WebSocket and executes commands against
// browser tabs using the Chrome DevTools Protocol (chrome.debugger) and
// chrome.scripting.
//
// Protocol (JSON over WebSocket):
//   request:  { id, method, params }
//   response: { id, result } | { id, error: { message } }

import { charKey, parseChord, parseModifiers, macEditingCommands } from "./keys.js";
import { loadBlocklist, blockedBy } from "./blocklist.js";
import {
  readPageInFrame, locateRefInFrame, iframeOffsetInFrame, setInputInFrame, markFileInputInFrame,
  pageTextInFrame, installIndicator, setIndicatorVisible, removeIndicator,
} from "./frame-scripts.js";

const BRIDGE_URL = "ws://127.0.0.1:9333";
const CDP_VERSION = "1.3";
const MAX_ELEMENTS_PER_FRAME = 3000;
const IS_MAC = navigator.userAgent.includes("Mac");

let ws = null;
let reconnectDelay = 1000;

// Per-tab state: { attached, console: [], network: Map<requestId, entry>,
// frames: Map<childFrameId, { parent, index }> }
const tabs = new Map();

function tabState(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, { attached: false, console: [], network: new Map(), frames: new Map() });
  }
  return tabs.get(tabId);
}

// Tabs where the user pressed Stop (or cancelled the debugging banner).
// Persisted in session storage so a service-worker restart can't forget it.
let stoppedTabs = new Set();
const stoppedReady = chrome.storage.session.get("stoppedTabs").then((r) => {
  stoppedTabs = new Set(r.stoppedTabs || []);
});
function saveStopped() {
  return chrome.storage.session.set({ stoppedTabs: [...stoppedTabs] });
}

const blocklistReady = loadBlocklist();
chrome.storage.onChanged.addListener((changes, area) => {
  if ("blockedUrlPatterns" in changes && (area === "local" || area === "managed")) loadBlocklist();
});

// ---------------------------------------------------------------------------
// WebSocket bridge
// ---------------------------------------------------------------------------

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(BRIDGE_URL);

  ws.onopen = () => {
    reconnectDelay = 1000;
    send({ hello: "chrome-debug-bridge", version: chrome.runtime.getManifest().version });
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id === undefined || !msg.method) return;
    try {
      const result = await handle(msg.method, msg.params || {});
      send({ id: msg.id, result: result === undefined ? {} : result });
    } catch (err) {
      send({ id: msg.id, error: { message: String(err && err.message ? err.message : err) } });
    }
  };

  ws.onclose = () => {
    ws = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Keep the service worker alive and the socket connected. An offscreen
// document (not subject to MV3's ~30s SW idle kill) pings us every 20s, which
// resets the SW idle timer; WebSocket activity helps too (Chrome 116+), and
// the alarm is a last-resort reconnect path.
async function ensureKeepalive() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Keeps the service worker alive so the bridge WebSocket stays connected.",
    });
  } catch {
    // Racing a concurrent createDocument is fine — one of them wins.
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.keepalive) {
    send({ ping: Date.now() });
    connect();
  } else if (msg.stopAutomation && sender.tab) {
    stopTab(sender.tab.id);
  }
});

function startup() {
  ensureKeepalive();
  connect();
}

chrome.alarms.create("bridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "bridge-reconnect") startup(); });
chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);
startup();

// ---------------------------------------------------------------------------
// Stop / resume
// ---------------------------------------------------------------------------

async function stopTab(tabId) {
  stoppedTabs.add(tabId);
  await saveStopped();
  await runInFrame(tabId, 0, removeIndicator, []);
  const state = tabState(tabId);
  if (state.attached) {
    state.attached = false;
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
  chrome.action.setBadgeText({ tabId, text: "■" }).catch(() => {});
  chrome.action.setTitle({ tabId, title: "Automation stopped — click to allow it again on this tab" }).catch(() => {});
}

// Clicking the toolbar icon on a stopped tab allows automation there again.
chrome.action.onClicked.addListener(async (tab) => {
  if (!stoppedTabs.delete(tab.id)) return;
  await saveStopped();
  chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
  chrome.action.setTitle({ tabId: tab.id, title: "Chrome Debug Bridge" }).catch(() => {});
});

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

async function attach(tabId) {
  const state = tabState(tabId);
  if (state.attached) return;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (err) {
    // After a service-worker restart we may still hold the attachment.
    if (!/already attached/i.test(String(err.message))) throw err;
  }
  state.attached = true;
  await cdp(tabId, "Runtime.enable");
  await cdp(tabId, "Page.enable");
  await cdp(tabId, "Page.setLifecycleEventsEnabled", { enabled: true });
  await cdp(tabId, "Network.enable");
  await cdp(tabId, "Log.enable");
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (!tabId || !tabs.has(tabId)) return;
  tabState(tabId).attached = false;
  runInFrame(tabId, 0, removeIndicator, []);
  // The user dismissed Chrome's "is debugging this browser" banner: treat it
  // like pressing Stop.
  if (reason === "canceled_by_user") stopTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  if (stoppedTabs.delete(tabId)) saveStopped();
});

// Re-show the indicator after each page load on tabs we're driving.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete" && tabs.get(tabId)?.attached && !stoppedTabs.has(tabId)) {
    runInFrame(tabId, 0, installIndicator, []);
  }
});

// Buffer console and network events per tab.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;
  const state = tabState(tabId);

  if (method === "Runtime.consoleAPICalled") {
    state.console.push({
      level: params.type,
      text: params.args.map(formatRemoteObject).join(" "),
      timestamp: params.timestamp,
    });
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails;
    state.console.push({
      level: "error",
      text: d.exception ? formatRemoteObject(d.exception) : d.text,
      timestamp: params.timestamp,
    });
  } else if (method === "Log.entryAdded") {
    const e = params.entry;
    state.console.push({ level: e.level, text: e.text, source: e.source, timestamp: e.timestamp });
  } else if (method === "Network.requestWillBeSent") {
    state.network.set(params.requestId, {
      url: params.request.url,
      method: params.request.method,
      type: params.type,
      status: null,
      error: null,
      startTime: params.timestamp,
    });
  } else if (method === "Network.responseReceived") {
    const e = state.network.get(params.requestId);
    if (e) {
      e.status = params.response.status;
      e.mimeType = params.response.mimeType;
    }
  } else if (method === "Network.loadingFailed") {
    const e = state.network.get(params.requestId);
    if (e) e.error = params.errorText;
  } else if (method === "Page.javascriptDialogOpening") {
    // Auto-respond so modal dialogs can never wedge the bridge: let
    // beforeunload proceed (accept = leave the page), dismiss everything
    // else. Either way, surface it in the console buffer for the agent.
    const accept = params.type === "beforeunload";
    state.console.push({
      level: "info",
      text: `[${params.type} dialog auto-${accept ? "accepted" : "dismissed"}] ${params.message || ""}`,
      timestamp: Date.now(),
    });
    cdp(tabId, "Page.handleJavaScriptDialog", { accept }).catch(() => {});
  }

  if (state.console.length > 2000) state.console.splice(0, state.console.length - 2000);
  if (state.network.size > 2000) {
    const firstKey = state.network.keys().next().value;
    state.network.delete(firstKey);
  }
});

function formatRemoteObject(obj) {
  if (obj.type === "string") return obj.value;
  if (obj.value !== undefined) return JSON.stringify(obj.value);
  if (obj.description) return obj.description;
  return obj.type;
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function mouse(tabId, type, x, y, extra = {}) {
  return cdp(tabId, "Input.dispatchMouseEvent", { type, x, y, pointerType: "mouse", ...extra });
}

async function pressKey(tabId, def, modifiers, commands = []) {
  // Ctrl/Cmd chords are shortcuts, not typing: don't insert the character.
  const text = modifiers & (2 | 4) ? undefined : def.text;
  const event = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  };
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown", ...event, text, unmodifiedText: text, commands,
  });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...event });
}

// Resolve a target given as { ref } or { x, y } to viewport coordinates.
async function resolvePoint(tabId, { ref, x, y }, label = "target") {
  if (ref !== undefined) return refToPoint(tabId, ref);
  if (x === undefined || y === undefined) throw new Error(`Provide ${label} as a ref, or both x and y.`);
  return { x, y };
}

// The indicator's Stop button sits above the page, so hide it while the
// agent clicks or captures the screen.
async function withIndicatorHidden(tabId, fn) {
  await runInFrame(tabId, 0, setIndicatorVisible, [false]);
  try {
    return await fn();
  } finally {
    await runInFrame(tabId, 0, setIndicatorVisible, [true]);
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const handlers = {
  // --- tabs ---------------------------------------------------------------

  async "tabs.context"() {
    const all = await chrome.tabs.query({});
    return {
      tabs: all.map((t) => {
        const info = { id: t.id, windowId: t.windowId, active: t.active, url: t.url, title: t.title };
        if (stoppedTabs.has(t.id)) info.stopped = true;
        if (blockedBy(t.url)) info.blocked = true;
        return info;
      }),
    };
  },

  async "tabs.create"({ url }) {
    const tab = await chrome.tabs.create({ url: url ? normalizeUrl(url) : "about:blank" });
    return { tabId: tab.id };
  },

  async "tabs.close"({ tabId }) {
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },

  async "window.resize"({ tabId, width, height }) {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { state: "normal", width, height });
    const win = await chrome.windows.get(tab.windowId);
    return { width: win.width, height: win.height };
  },

  // --- navigation ----------------------------------------------------------

  async "page.navigate"({ tabId, url }) {
    await attach(tabId);
    // Listen before navigating so a fast (cached) load can't fire unseen, and
    // match on loaderId so a load from an earlier navigation or a subframe
    // can't satisfy the wait.
    const loaded = new Set();
    let want = null;
    let wake = () => {};
    const listener = (source, method, params) => {
      if (source.tabId !== tabId || method !== "Page.lifecycleEvent" || params.name !== "load") return;
      loaded.add(params.loaderId);
      if (want && loaded.has(want)) wake();
    };
    chrome.debugger.onEvent.addListener(listener);
    try {
      const res = await cdp(tabId, "Page.navigate", { url: normalizeUrl(url) });
      if (res.errorText) throw new Error(`Navigation failed: ${res.errorText}`);
      // No loaderId means a same-document navigation (e.g. #hash), which
      // fires no load event.
      if (res.loaderId && !loaded.has(res.loaderId)) {
        want = res.loaderId;
        await new Promise((resolve) => {
          wake = resolve;
          setTimeout(resolve, 15000);
        });
      }
    } finally {
      chrome.debugger.onEvent.removeListener(listener);
    }
    await sleep(300); // let post-load scripts run
    const tab = await chrome.tabs.get(tabId);
    const pattern = blockedBy(tab.url);
    if (pattern) throw new Error(`Navigation ended on a blocked page (${tab.url} matches "${pattern}").`);
    return { url: tab.url, title: tab.title };
  },

  async "page.goBack"({ tabId }) {
    await attach(tabId);
    const { currentIndex, entries } = await cdp(tabId, "Page.getNavigationHistory");
    if (currentIndex > 0) {
      // A back-forward-cache restore or a same-document entry fires no load
      // event, so accept those as completion too.
      const loaded = waitForEvent(tabId, (method, params) =>
        method === "Page.loadEventFired" ||
        method === "Page.navigatedWithinDocument" ||
        (method === "Page.frameNavigated" && params.type === "BackForwardCacheRestore"), 15000);
      await cdp(tabId, "Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id });
      await loaded;
    }
    return {};
  },

  // --- screenshot ----------------------------------------------------------

  async "page.screenshot"({ tabId, format = "jpeg", quality = 80 }) {
    await attach(tabId);
    const params = { format, fromSurface: true };
    if (format === "jpeg") params.quality = quality;
    const { data } = await withIndicatorHidden(tabId, () => cdp(tabId, "Page.captureScreenshot", params));
    return { format, base64: data };
  },

  // --- input ---------------------------------------------------------------

  async "input.click"({ tabId, x, y, ref, button = "left", clickCount = 1, modifiers }) {
    await attach(tabId);
    const mods = parseModifiers(modifiers);
    return withIndicatorHidden(tabId, async () => {
      const p = await resolvePoint(tabId, { ref, x, y });
      await mouse(tabId, "mouseMoved", p.x, p.y, { modifiers: mods });
      for (let i = 1; i <= clickCount; i++) {
        await mouse(tabId, "mousePressed", p.x, p.y, { button, clickCount: i, modifiers: mods });
        await mouse(tabId, "mouseReleased", p.x, p.y, { button, clickCount: i, modifiers: mods });
      }
      return { clicked: p };
    });
  },

  async "input.hover"({ tabId, x, y, ref }) {
    await attach(tabId);
    const p = await resolvePoint(tabId, { ref, x, y });
    await mouse(tabId, "mouseMoved", p.x, p.y);
    return { hovered: p };
  },

  async "input.drag"({ tabId, from, to, modifiers }) {
    await attach(tabId);
    const mods = parseModifiers(modifiers);
    return withIndicatorHidden(tabId, async () => {
      const a = await resolvePoint(tabId, from || {}, "from");
      const b = await resolvePoint(tabId, to || {}, "to");
      // HTML5 drag-and-drop doesn't run off synthetic mouse events alone, so
      // intercept the drag Chrome starts and replay it as drag events (the
      // same approach Puppeteer uses). Pointer-based drags (sliders, canvas,
      // sortable lists) just see the mouse moves.
      let dragData = null;
      const onDrag = (source, method, params) => {
        if (source.tabId === tabId && method === "Input.dragIntercepted") dragData = params.data;
      };
      chrome.debugger.onEvent.addListener(onDrag);
      await cdp(tabId, "Input.setInterceptDrags", { enabled: true });
      try {
        await mouse(tabId, "mouseMoved", a.x, a.y, { modifiers: mods });
        await mouse(tabId, "mousePressed", a.x, a.y, { button: "left", clickCount: 1, modifiers: mods });
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          const x = a.x + ((b.x - a.x) * i) / steps;
          const y = a.y + ((b.y - a.y) * i) / steps;
          await mouse(tabId, "mouseMoved", x, y, { button: "left", buttons: 1, modifiers: mods });
          await sleep(16);
        }
        if (dragData) {
          for (const type of ["dragEnter", "dragOver", "drop"]) {
            await cdp(tabId, "Input.dispatchDragEvent", { type, x: b.x, y: b.y, data: dragData, modifiers: mods });
          }
        }
        await mouse(tabId, "mouseReleased", b.x, b.y, { button: "left", clickCount: 1, modifiers: mods });
      } finally {
        chrome.debugger.onEvent.removeListener(onDrag);
        await cdp(tabId, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
      }
      return { from: a, to: b, html5Drag: !!dragData };
    });
  },

  async "input.type"({ tabId, text }) {
    await attach(tabId);
    // Type character by character with real keyDown/keyUp events so pages
    // that listen for keystrokes (autocomplete, hotkeys, per-key validation)
    // react. Characters with no US-keyboard key (emoji, accents, CJK) fall
    // back to insertText. Commands are pipelined; CDP preserves their order.
    const sends = [];
    for (const ch of text) {
      const def = charKey(ch);
      if (!def) {
        sends.push(cdp(tabId, "Input.insertText", { text: ch }));
        continue;
      }
      const event = {
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        modifiers: def.shift ? 8 : 0,
      };
      sends.push(cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...event, text: def.text, unmodifiedText: def.text }));
      sends.push(cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...event }));
    }
    await Promise.all(sends);
    return {};
  },

  async "input.key"({ tabId, key, repeat = 1 }) {
    await attach(tabId);
    const { def, modifiers } = parseChord(key);
    const commands = IS_MAC ? macEditingCommands(def, modifiers) : [];
    for (let i = 0; i < repeat; i++) await pressKey(tabId, def, modifiers, commands);
    return {};
  },

  async "input.scroll"({ tabId, x, y, ref, deltaX = 0, deltaY = 0 }) {
    await attach(tabId);
    if (ref !== undefined) {
      // Scrolling to a ref brings it to the middle of the viewport.
      return { scrolledTo: await refToPoint(tabId, ref) };
    }
    if (x === undefined || y === undefined) {
      const m = await cdp(tabId, "Page.getLayoutMetrics");
      x = Math.floor(m.cssVisualViewport.clientWidth / 2);
      y = Math.floor(m.cssVisualViewport.clientHeight / 2);
    }
    await mouse(tabId, "mouseWheel", x, y, { deltaX, deltaY });
    return {};
  },

  // --- page content ----------------------------------------------------------

  async "page.read"({ tabId, filter = "interactive", fullPage = false, ref, maxDepth = 15, maxChars = 50000, query }) {
    await attach(tabId);
    const opts = {
      filter,
      viewportOnly: !fullPage,
      maxDepth,
      query: query ? String(query).toLowerCase() : null,
      focusRef: null,
      maxElements: MAX_ELEMENTS_PER_FRAME,
    };
    // Walk every frame (including cross-origin iframes) in the extension's
    // isolated world, where closed shadow roots are reachable.
    const [results, frameInfo] = await Promise.all([
      chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: readPageInFrame, args: [opts] }),
      chrome.webNavigation.getAllFrames({ tabId }),
    ]);
    const byFrame = new Map();
    for (const r of results) if (r.result) byFrame.set(r.frameId, r.result);

    let startFrame = 0;
    if (ref) {
      const { frameId, localRef } = parseRef(ref);
      startFrame = frameId;
      const focused = await runInFrame(tabId, frameId, readPageInFrame, [{ ...opts, viewportOnly: false, focusRef: localRef }]);
      if (!focused) throw new Error(staleRefMessage(ref));
      if (focused.error) throw new Error(focused.error);
      byFrame.set(frameId, focused);
    }
    const main = byFrame.get(0);
    if (!main || !byFrame.has(startFrame)) {
      throw new Error("Could not read the page (chrome:// pages and the Web Store can't be scripted).");
    }

    // Match each child frame to its parent's <iframe> placeholder by its
    // index in the parent's window.frames.
    const childAt = new Map();
    for (const f of frameInfo || []) {
      const r = byFrame.get(f.frameId);
      if (f.parentFrameId >= 0 && r && r.selfIndex >= 0) childAt.set(`${f.parentFrameId}:${r.selfIndex}`, f.frameId);
    }

    // Splice child frames in where their <iframe> appears. Only frames
    // reachable through visible iframes are included, so hidden iframes
    // can't inject content into the outline.
    const state = tabState(tabId);
    const lines = [];
    let truncated = false;
    const seen = new Set();
    const emit = (frameId, offset) => {
      seen.add(frameId);
      const r = byFrame.get(frameId);
      truncated ||= r.truncated;
      for (const e of r.elements) {
        const pad = "  ".repeat(e.depth + offset);
        if (e.childIndex !== undefined) {
          const childId = childAt.get(`${frameId}:${e.childIndex}`);
          if (childId === undefined || seen.has(childId)) continue;
          state.frames.set(childId, { parent: frameId, index: e.childIndex });
          const child = byFrame.get(childId);
          lines.push(`${pad}iframe${e.name ? ` "${quote(e.name)}"` : ""} [frame ${childId}] src=${child.url}`);
          emit(childId, e.depth + offset + 1);
        } else {
          lines.push(...renderEntry(e, pad, frameId));
        }
      }
    };
    emit(startFrame, 0);

    const header = [`Page: ${main.title}`, `URL: ${main.url}`, `Viewport: ${main.viewport.width}x${main.viewport.height}`];
    if (!fullPage && !query && !ref) header.push("(Only elements in the viewport are shown; pass fullPage: true for the whole page.)");
    let body = lines.join("\n");
    if (!body) body = query ? `No elements matching "${query}".` : "(no matching elements)";
    if (truncated) body += "\n[some elements omitted: element or depth limit reached — use ref to focus on a subtree]";
    if (body.length > maxChars) {
      const cut = Math.max(0, body.lastIndexOf("\n", maxChars));
      body = `${body.slice(0, cut)}\n[output truncated at ${cut} of ${body.length} characters — pass a larger maxChars, or use ref to focus]`;
    }
    return { text: `${header.join("\n")}\n\n${body}` };
  },

  async "page.text"({ tabId, maxChars = 50000 }) {
    await attach(tabId);
    const r = await runInFrame(tabId, 0, pageTextInFrame, []);
    if (!r) throw new Error("Could not read the page text.");
    let text = r.text;
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[truncated at ${maxChars} of ${r.text.length} characters]`;
    return { text: `Page: ${r.title}\nURL: ${r.url}\n\n${text}` };
  },

  async "page.eval"({ tabId, expression }) {
    await attach(tabId);
    const { result, exceptionDetails } = await cdp(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (exceptionDetails) {
      const msg = exceptionDetails.exception
        ? formatRemoteObject(exceptionDetails.exception)
        : exceptionDetails.text;
      throw new Error(msg);
    }
    return { value: result.value !== undefined ? result.value : formatRemoteObject(result) };
  },

  async "form.input"({ tabId, ref, value }) {
    await attach(tabId);
    const { frameId, localRef } = parseRef(ref);
    const out = await runInFrame(tabId, frameId, setInputInFrame, [localRef, String(value)]);
    if (!out || out.error) throw new Error((out && out.error) || staleRefMessage(ref));
    return out;
  },

  async "form.upload"({ tabId, ref, files }) {
    await attach(tabId);
    const { frameId, localRef } = parseRef(ref);
    // Refs live in the isolated world, so tag the element with a one-time
    // attribute and find it from CDP, which needs a DOM node id.
    const token = crypto.randomUUID();
    const mark = await runInFrame(tabId, frameId, markFileInputInFrame, [localRef, token]);
    if (!mark || mark.error) throw new Error((mark && mark.error) || staleRefMessage(ref));
    try {
      await cdp(tabId, "DOM.getDocument", { depth: -1, pierce: true });
      const { searchId, resultCount } = await cdp(tabId, "DOM.performSearch", {
        query: `[data-dbg-upload="${token}"]`,
        includeUserAgentShadowDOM: true,
      });
      try {
        if (!resultCount) {
          throw new Error("Couldn't reach that file input from the page's DevTools session (it may be in a cross-origin iframe).");
        }
        const { nodeIds } = await cdp(tabId, "DOM.getSearchResults", { searchId, fromIndex: 0, toIndex: 1 });
        await cdp(tabId, "DOM.setFileInputFiles", { files, nodeId: nodeIds[0] });
      } finally {
        cdp(tabId, "DOM.discardSearchResults", { searchId }).catch(() => {});
      }
    } finally {
      await runInFrame(tabId, frameId, markFileInputInFrame, [localRef, null]);
    }
    return { uploaded: files.length };
  },

  // --- diagnostics -----------------------------------------------------------

  async "console.read"({ tabId, pattern, limit = 100 }) {
    await attach(tabId);
    let entries = tabState(tabId).console;
    if (pattern) {
      const re = new RegExp(pattern);
      entries = entries.filter((e) => re.test(e.text));
    }
    return { messages: entries.slice(-limit) };
  },

  async "network.read"({ tabId, pattern, limit = 100 }) {
    await attach(tabId);
    let entries = [...tabState(tabId).network.values()];
    if (pattern) {
      const re = new RegExp(pattern);
      entries = entries.filter((e) => re.test(e.url));
    }
    return { requests: entries.slice(-limit) };
  },

  // --- development -----------------------------------------------------------

  async "extension.reload"() {
    // Reload this (unpacked) extension from disk. Respond first; the socket
    // drops when the service worker restarts, then reconnects.
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: true };
  },
};

// Gate every command on the stop state and the blocklist, and keep the
// indicator up on tabs being driven.
async function handle(method, params) {
  const h = handlers[method];
  if (!h) throw new Error(`Unknown method: ${method}`);
  await Promise.all([stoppedReady, blocklistReady]);

  if ((method === "tabs.create" || method === "page.navigate") && params.url) {
    if (isOwnPage(params.url)) throw new Error(OWN_PAGE_ERROR);
    const pattern = blockedBy(normalizeUrl(params.url));
    if (pattern) {
      throw new Error(`${params.url} is blocked by the user's site blocklist ("${pattern}"). Don't try to reach it another way.`);
    }
  }

  const { tabId } = params;
  if (tabId !== undefined && method !== "tabs.close") {
    if (stoppedTabs.has(tabId)) {
      throw new Error(
        "The user pressed Stop on this tab. Don't continue on it unless they ask you to; " +
        "they can re-enable it by clicking the extension's toolbar icon on that tab."
      );
    }
    const tab = await chrome.tabs.get(tabId);
    if (isOwnPage(tab.url)) throw new Error(OWN_PAGE_ERROR);
    const pattern = blockedBy(tab.url);
    if (pattern && method !== "page.navigate") {
      throw new Error(`This tab is on a blocked site (${tab.url} matches "${pattern}"). Navigate it elsewhere or use another tab.`);
    }
    if (method !== "window.resize") runInFrame(tabId, 0, installIndicator, []);
  }
  return h(params);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The extension's own pages (options, offscreen) hold the blocklist; an agent
// that could drive them could edit it, so they're off limits.
const OWN_PAGE_ERROR = "The bridge extension's own pages can't be automated.";
function isOwnPage(url) {
  return String(url || "").startsWith(chrome.runtime.getURL(""));
}

// "example.com" -> "https://example.com"; leaves URLs with a scheme alone.
function normalizeUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

const quote = (s) => String(s).replace(/"/g, '\\"');

// Render one outline entry as text lines, like:  button "Sign in" [ref4]
function renderEntry(e, pad, frameId) {
  const ref = frameId === 0 ? e.ref : `${e.ref}@f${frameId}`;
  let line = `${pad}${e.role}`;
  if (e.name) line += ` "${quote(e.name)}"`;
  line += ` [${ref}]`;
  if (e.type && !["text", "submit", "button"].includes(e.type)) line += ` type=${e.type}`;
  if (e.href) line += ` href="${quote(e.href)}"`;
  if (e.placeholder) line += ` placeholder="${quote(e.placeholder)}"`;
  if (e.value !== undefined) line += ` value="${quote(e.value)}"`;
  if (e.checked !== undefined) line += e.checked ? " (checked)" : " (unchecked)";
  if (e.expanded !== undefined) line += e.expanded ? " (expanded)" : " (collapsed)";
  if (e.disabled) line += " (disabled)";
  const lines = [line];
  for (const o of e.options || []) lines.push(`${pad}  option "${quote(o.text)}"${o.selected ? " (selected)" : ""}`);
  return lines;
}

// Resolves true when a CDP event matching predicate arrives on the tab, or
// false on timeout. Call before triggering the event so it can't be missed.
function waitForEvent(tabId, predicate, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    function listener(source, method, params) {
      if (source.tabId === tabId && predicate(method, params || {})) done(true);
    }
    function done(ok) {
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      resolve(ok);
    }
    chrome.debugger.onEvent.addListener(listener);
  });
}

// Run a function in one frame's isolated world and return its result.
async function runInFrame(tabId, frameId, func, args) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args });
    return res ? res.result : undefined;
  } catch {
    return undefined; // frame gone, navigated, or not scriptable
  }
}

// Refs are "ref12" in the main frame and "ref12@f7" in frame 7.
function parseRef(ref) {
  const m = /^(ref\d+)(?:@f(\d+))?$/.exec(String(ref));
  if (!m) throw new Error(`Malformed ref "${ref}" — use a ref from read_page.`);
  return { localRef: m[1], frameId: m[2] ? Number(m[2]) : 0 };
}

function staleRefMessage(ref) {
  return `Stale or unknown ref "${ref}" — call read_page again to refresh refs.`;
}

// Resolve a ref to top-level viewport coordinates of the element's center.
// Input.dispatchMouseEvent hit-tests from the top level, so a click at these
// coordinates lands inside (even cross-origin) iframes.
async function refToPoint(tabId, ref) {
  // A scrollIntoView inside a cross-origin iframe propagates to the parent
  // page asynchronously, so the first measurement can predate the parent's
  // scroll. Re-measure until two readings agree.
  let prev = null;
  for (let i = 0; i < 6; i++) {
    const p = await measureRef(tabId, ref);
    if (prev && Math.abs(p.x - prev.x) < 1 && Math.abs(p.y - prev.y) < 1) return p;
    prev = p;
    if (i === 0 && parseRef(ref).frameId === 0) return p; // same-process: already settled
    await sleep(50);
  }
  return prev;
}

// One measurement: scroll the element into view inside its own frame, then
// add each ancestor iframe's content-box offset on the way up to the main
// frame.
async function measureRef(tabId, ref) {
  const { frameId, localRef } = parseRef(ref);
  const p = await runInFrame(tabId, frameId, locateRefInFrame, [localRef]);
  if (!p) throw new Error(staleRefMessage(ref));
  let { x, y } = p;
  const frames = tabState(tabId).frames;
  for (let f = frameId; f !== 0; ) {
    const link = frames.get(f);
    if (!link) throw new Error(staleRefMessage(ref));
    const off = await runInFrame(tabId, link.parent, iframeOffsetInFrame, [link.index]);
    if (!off) throw new Error(staleRefMessage(ref));
    x += off.x;
    y += off.y;
    f = link.parent;
  }
  return { x, y };
}
