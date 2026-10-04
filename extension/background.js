// Browser Driver MCP — MV3 service worker.
//
// Talks to a native messaging host (server/native-host.js), which relays
// commands from local MCP servers, and executes them against browser tabs
// using the Chrome DevTools Protocol (chrome.debugger) and chrome.scripting.
// The MCP server maps Claude in Chrome's tool set onto the methods below.
//
// Protocol (JSON messages over the native messaging port):
//   request:  { id, method, params }
//   response: { id, result } | { id, error: { message } }
//   events:   { event, ... }   (hello, pairing.accepted; from the host: ready)
//   chunks:   { chunk: { id, index, count, data } }  (host -> extension
//             messages over Chrome's 1 MB limit, split by the host)

import { charKey, parseChord, parseModifiers, macEditingCommands } from "./keys.js";
import {
  readPageInFrame, locateRefInFrame, iframeOffsetInFrame, setInputInFrame, markFileInputInFrame,
  pageTextInFrame, installIndicator, setIndicatorVisible, removeIndicator,
} from "./frame-scripts.js";
import { encodeGif, decodeImage, toPng } from "./gif.js";

const CDP_VERSION = "1.3";
const MAX_ELEMENTS = 10000;
const IS_MAC = navigator.userAgent.includes("Mac");
const GROUP_TITLE = "MCP";
const GROUP_COLOR = "cyan"; // closest of Chrome's fixed group colors to the electric-blue glow

// Per-tab state: { attached, domain, console: [], network: Map<requestId, entry>,
// frames: Map<childFrameId, { parent, index }> }
const tabs = new Map();

function tabState(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, { attached: false, domain: null, console: [], network: new Map(), frames: new Map() });
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

// ---------------------------------------------------------------------------
// Native messaging bridge
// ---------------------------------------------------------------------------

async function identity() {
  let { deviceId } = await chrome.storage.local.get("deviceId");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId });
  }
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const brand = brands.map((b) => b.brand).find((b) => !/not.*brand|chromium/i.test(b)) || "Chromium";
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform;
  return { deviceId, name: brand, platform };
}

// The native messaging host (server/native-host.js), which the MCP server
// installs and registers. Chrome launches it on connectNative and only lets
// the extension IDs in its manifest connect.
const HOST_NAME = "com.github.darrinm.browser_driver_mcp";

// Version of the extension <-> server message protocol; must match PROTOCOL
// in server/transport.js. Bump both on incompatible changes.
const PROTOCOL = 1;

// What the welcome page shows: whether the host is reachable, and how many
// MCP clients are attached to it.
const hostStatus = { connected: false, error: null, version: null, clients: 0 };

let port = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const chunks = new Map(); // id -> parts[] for messages the host split up

function connect() {
  if (port) return;
  clearTimeout(reconnectTimer);
  let p;
  try {
    p = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    showHostProblem(String(err && err.message ? err.message : err));
    scheduleReconnect();
    return;
  }
  port = p;
  p.onMessage.addListener(onHostMessage);
  p.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : "the native host exited";
    if (port === p) port = null;
    Object.assign(hostStatus, { connected: false, error: reason, clients: 0 });
    showHostProblem(reason);
    scheduleReconnect();
  });
  identity().then((id) => send({ event: "hello", version: chrome.runtime.getManifest().version, protocol: PROTOCOL, ...id }));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

async function onHostMessage(msg) {
  if (msg.chunk) {
    const { id, index, count, data } = msg.chunk;
    const parts = chunks.get(id) || new Array(count);
    parts[index] = data;
    chunks.set(id, parts);
    if (parts.filter((x) => x !== undefined).length < count) return;
    chunks.delete(id);
    msg = JSON.parse(parts.join(""));
  }
  if (msg.event === "ready") {
    reconnectDelay = 1000;
    Object.assign(hostStatus, { connected: true, error: null, version: msg.version || null });
    clearHostProblem();
    return;
  }
  if (msg.event === "clients") {
    hostStatus.clients = msg.count;
    return;
  }
  if (msg.id === undefined || !msg.method) return;
  try {
    const result = await handle(msg.method, msg.params || {});
    send({ id: msg.id, result: result === undefined ? {} : result });
  } catch (err) {
    send({ id: msg.id, error: { message: String(err && err.message ? err.message : err) } });
  }
}

function send(obj) {
  if (!port) return;
  try {
    port.postMessage(obj);
  } catch {
    // The port died between the check and the send; onDisconnect reconnects.
  }
}

// A red "!" on the toolbar icon while the native host can't be reached.
function showHostProblem(reason) {
  chrome.action.setBadgeBackgroundColor({ color: "#c0392b" }).catch(() => {});
  chrome.action.setBadgeText({ text: "!" }).catch(() => {});
  chrome.action.setTitle({
    title: `Browser Driver MCP isn't connected yet (${reason}). Click for setup help.`,
  }).catch(() => {});
}

function clearHostProblem() {
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
  chrome.action.setTitle({ title: "Browser Driver MCP" }).catch(() => {});
}

// Keep the service worker alive and the host connected. An open native
// messaging port extends the worker's lifetime; an offscreen document (not
// subject to MV3's ~30s idle kill) also pings every 20s, and the alarm is a
// last-resort reconnect path.
async function ensureKeepalive() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Keeps the service worker alive so the native messaging bridge stays connected.",
    });
  } catch {
    // Racing a concurrent createDocument is fine — one of them wins.
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.keepalive) {
    send({ ping: Date.now() });
    connect();
  } else if (msg.stopAutomation && sender.tab) {
    stopTab(sender.tab.id);
  } else if (msg.type === "status" && sender.id === chrome.runtime.id && !sender.tab?.url?.startsWith("http")) {
    // From the welcome page: report status, and retry the host right away
    // rather than waiting out the backoff, so setup feels instant.
    if (!port) {
      reconnectDelay = 1000;
      connect();
    }
    sendResponse({
      ...hostStatus,
      extensionVersion: chrome.runtime.getManifest().version,
      protocol: PROTOCOL,
      extensionId: chrome.runtime.id,
    });
  }
});

function startup() {
  ensureKeepalive();
  connect();
}

chrome.alarms.create("bridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "bridge-reconnect") startup(); });
chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener((details) => {
  startup();
  if (details.reason === "install") openWelcome();
});
startup();

// The setup/status page: opened on install and from the toolbar icon.
async function openWelcome() {
  const url = chrome.runtime.getURL("welcome.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// ---------------------------------------------------------------------------
// Browser pairing (switch_browser)
// ---------------------------------------------------------------------------

chrome.notifications.onButtonClicked.addListener((id) => acceptPairing(id));
chrome.notifications.onClicked.addListener((id) => acceptPairing(id));

function acceptPairing(notificationId) {
  if (!notificationId.startsWith("pairing:")) return;
  chrome.notifications.clear(notificationId);
  send({ event: "pairing.accepted", requestId: notificationId.slice("pairing:".length) });
}

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

// Clicking the toolbar icon on a stopped tab allows automation there again;
// anywhere else it opens the setup/status page.
chrome.action.onClicked.addListener(async (tab) => {
  if (!stoppedTabs.delete(tab.id)) {
    openWelcome();
    return;
  }
  await saveStopped();
  chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
  chrome.action.setTitle({ tabId: tab.id, title: "Browser Driver MCP" }).catch(() => {});
});

// ---------------------------------------------------------------------------
// MCP tab group: the tabs the agent may use, like Claude in Chrome's.
// ---------------------------------------------------------------------------

async function getGroup() {
  const { mcpGroupId } = await chrome.storage.session.get("mcpGroupId");
  let group = null;
  if (mcpGroupId !== undefined && mcpGroupId !== null) {
    try {
      group = await chrome.tabGroups.get(mcpGroupId);
    } catch {
      // Chrome removes a group when its last tab closes.
    }
  }
  // Session storage is lost when the extension is reloaded or reinstalled;
  // adopt an existing group by title rather than starting a second one.
  if (!group) {
    [group = null] = await chrome.tabGroups.query({ title: GROUP_TITLE });
    if (!group) return null;
    await chrome.storage.session.set({ mcpGroupId: group.id });
  }
  // Restyle a group created under an older name or color.
  if (group.title !== GROUP_TITLE || group.color !== GROUP_COLOR) {
    group = await chrome.tabGroups.update(group.id, { title: GROUP_TITLE, color: GROUP_COLOR });
  }
  return group;
}

async function createGroup(windowId, tabId) {
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
  await chrome.storage.session.set({ mcpGroupId: groupId });
  return chrome.tabGroups.get(groupId);
}

async function groupTabs(group) {
  if (!group) return [];
  const all = await chrome.tabs.query({ groupId: group.id });
  return all.map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active }));
}

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
  try {
    state.domain = new URL((await chrome.tabs.get(tabId)).url).hostname;
  } catch {}
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

// Buffer console and network events per tab. Like Claude in Chrome, both
// buffers only cover the current domain: they reset when the main frame
// navigates to a different host.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;
  const state = tabState(tabId);

  if (method === "Page.frameNavigated" && !params.frame.parentId) {
    let host = null;
    try { host = new URL(params.frame.url).hostname; } catch {}
    if (host !== state.domain) {
      state.domain = host;
      state.console = [];
      state.network.clear();
    }
  } else if (method === "Runtime.consoleAPICalled") {
    state.console.push({
      level: params.type,
      text: params.args.map(formatRemoteObject).join(" "),
      timestamp: params.timestamp,
    });
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails;
    state.console.push({
      level: "exception",
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
      timestamp: params.wallTime ? Math.round(params.wallTime * 1000) : Date.now(),
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
  if (state.network.size > 2000) state.network.delete(state.network.keys().next().value);
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
async function resolvePoint(tabId, { ref, x, y }, label = "coordinate") {
  if (ref !== undefined && ref !== null) return refToPoint(tabId, ref);
  if (x === undefined || y === undefined) throw new Error(`Provide ${label} or ref.`);
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

// The visual viewport in CSS pixels — the coordinate frame for every click,
// screenshot and zoom — plus the device pixel ratio.
async function viewport(tabId) {
  const m = await cdp(tabId, "Page.getLayoutMetrics");
  const v = m.cssVisualViewport;
  const { result } = await cdp(tabId, "Runtime.evaluate", { expression: "devicePixelRatio", returnByValue: true });
  return { x: v.pageX, y: v.pageY, width: Math.round(v.clientWidth), height: Math.round(v.clientHeight), dpr: result.value || 1 };
}

// Capture a region of the page (in viewport CSS pixels) at `zoom` output
// pixels per CSS pixel. Returns the image and its actual dimensions.
async function capture(tabId, vp, region, zoom, quality = 80) {
  const params = {
    format: "jpeg",
    quality,
    fromSurface: true,
    // clip.scale multiplies with the device pixel ratio, so divide it out.
    clip: { x: vp.x + region.x, y: vp.y + region.y, width: region.width, height: region.height, scale: zoom / vp.dpr },
  };
  const { data } = await withIndicatorHidden(tabId, () => cdp(tabId, "Page.captureScreenshot", params));
  const bmp = await decodeImage(data, "image/jpeg");
  return { base64: data, mime: "image/jpeg", width: bmp.width, height: bmp.height };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const handlers = {
  // --- tab group -----------------------------------------------------------

  async "group.context"({ createIfEmpty = false }) {
    let group = await getGroup();
    if (!group && createIfEmpty) {
      const win = await chrome.windows.create({ url: "about:blank", focused: true });
      group = await createGroup(win.id, win.tabs[0].id);
    }
    return { groupId: group ? group.id : null, title: group ? group.title : null, tabs: await groupTabs(group) };
  },

  async "group.createTab"({ url }) {
    let group = await getGroup();
    let tab;
    if (!group) {
      const win = await chrome.windows.create({ url: url || "about:blank", focused: true });
      tab = win.tabs[0];
      group = await createGroup(win.id, tab.id);
    } else {
      tab = await chrome.tabs.create({ windowId: group.windowId, url: url || "about:blank", active: true });
      await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] });
    }
    return { tabId: tab.id, tabs: await groupTabs(group) };
  },

  async "group.closeTab"({ tabId }) {
    await chrome.tabs.remove(tabId);
    return { closed: tabId, tabs: await groupTabs(await getGroup()) };
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
    if (url === "back" || url === "forward") {
      const { currentIndex, entries } = await cdp(tabId, "Page.getNavigationHistory");
      const target = entries[currentIndex + (url === "back" ? -1 : 1)];
      if (!target) throw new Error(`Can't go ${url}: no ${url === "back" ? "previous" : "next"} page in history.`);
      // A back-forward-cache restore or a same-document entry fires no load
      // event, so accept those as completion too.
      const loaded = waitForEvent(tabId, (method, params) =>
        method === "Page.loadEventFired" ||
        method === "Page.navigatedWithinDocument" ||
        (method === "Page.frameNavigated" && params.type === "BackForwardCacheRestore"), 15000);
      await cdp(tabId, "Page.navigateToHistoryEntry", { entryId: target.id });
      await loaded;
    } else {
      const dest = normalizeUrl(url);
      try {
        new URL(dest);
      } catch {
        throw new Error(`Invalid URL: "${url}". Could not parse as a valid URL.`);
      }
      // Listen before navigating so a fast (cached) load can't fire unseen,
      // and match on loaderId so a load from an earlier navigation or a
      // subframe can't satisfy the wait.
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
        const res = await cdp(tabId, "Page.navigate", { url: dest });
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
    }
    await sleep(300); // let post-load scripts run
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url, title: tab.title };
  },

  // --- screenshots -----------------------------------------------------------

  async "page.screenshot"({ tabId, scale = 1 }) {
    await attach(tabId);
    const vp = await viewport(tabId);
    const img = await capture(tabId, vp, { x: 0, y: 0, width: vp.width, height: vp.height }, scale);
    return { ...img, frameWidth: vp.width, frameHeight: vp.height };
  },

  async "page.zoom"({ tabId, region, scale = 1 }) {
    await attach(tabId);
    if (!Array.isArray(region) || region.length !== 4) throw new Error("zoom needs region [x0, y0, x1, y1].");
    const [x0, y0, x1, y1] = region.map(Number);
    const width = x1 - x0;
    const height = y1 - y0;
    if (!(width > 0 && height > 0)) throw new Error("zoom region must have x1 > x0 and y1 > y0.");
    const vp = await viewport(tabId);
    // Magnify small regions (up to 4x, at least device resolution) so details
    // are legible, aiming for ~1024px on the long side.
    const zoom = Math.min(4, Math.max(vp.dpr, 1024 / Math.max(width, height))) * scale;
    const img = await capture(tabId, vp, { x: x0, y: y0, width, height }, zoom, 90);
    return { ...img, frameWidth: vp.width, frameHeight: vp.height };
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
      return { x: p.x, y: p.y };
    });
  },

  async "input.hover"({ tabId, x, y, ref }) {
    await attach(tabId);
    const p = await resolvePoint(tabId, { ref, x, y });
    await mouse(tabId, "mouseMoved", p.x, p.y);
    return { x: p.x, y: p.y };
  },

  async "input.drag"({ tabId, from, to, modifiers }) {
    await attach(tabId);
    const mods = parseModifiers(modifiers);
    return withIndicatorHidden(tabId, async () => {
      const a = await resolvePoint(tabId, from || {}, "start_coordinate");
      const b = await resolvePoint(tabId, to || {}, "coordinate");
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
      return { from: a, to: b };
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

  // Space-separated keys or chords, e.g. "Backspace Backspace Delete" or
  // "cmd+a", optionally repeated.
  async "input.keys"({ tabId, text, repeat = 1 }) {
    await attach(tabId);
    const chords = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (!chords.length) throw new Error("key action needs text naming the key(s) to press.");
    const parsed = chords.map(parseChord); // validate everything before pressing anything
    for (let r = 0; r < repeat; r++) {
      for (const { def, modifiers } of parsed) {
        await pressKey(tabId, def, modifiers, IS_MAC ? macEditingCommands(def, modifiers) : []);
      }
    }
    return { pressed: chords.length * repeat };
  },

  async "input.scroll"({ tabId, x, y, direction, amount = 3 }) {
    await attach(tabId);
    if (x === undefined || y === undefined) {
      const vp = await viewport(tabId);
      x = Math.floor(vp.width / 2);
      y = Math.floor(vp.height / 2);
    }
    const tick = 100 * amount;
    const deltaX = direction === "left" ? -tick : direction === "right" ? tick : 0;
    const deltaY = direction === "up" ? -tick : direction === "down" ? tick : 0;
    if (!deltaX && !deltaY) throw new Error('scroll_direction must be "up", "down", "left" or "right".');
    await mouse(tabId, "mouseWheel", x, y, { deltaX, deltaY });
    await sleep(150); // let smooth scrolling settle before the next screenshot
    return {};
  },

  async "input.scrollTo"({ tabId, ref }) {
    await attach(tabId);
    return refToPoint(tabId, ref);
  },

  // --- page content ----------------------------------------------------------

  async "page.read"({ tabId, filter = "all", depth = 15, ref_id, max_chars = 50000 }) {
    await attach(tabId);
    const { byFrame, startFrame, childAt } = await readFrames(tabId, { filter, maxDepth: depth, query: null }, ref_id);
    const state = tabState(tabId);
    const lines = [];
    let truncated = false;
    const seen = new Set();
    const emit = (frameId, offset) => {
      seen.add(frameId);
      const r = byFrame.get(frameId);
      truncated ||= r.truncated;
      for (const e of r.elements) {
        const pad = " ".repeat(e.depth + offset);
        if (e.childIndex !== undefined) {
          const childId = childAt.get(`${frameId}:${e.childIndex}`);
          if (childId === undefined || seen.has(childId)) continue;
          state.frames.set(childId, { parent: frameId, index: e.childIndex });
          lines.push(`${pad}iframe${e.name ? ` "${quote(e.name)}"` : ""} src="${quote(byFrame.get(childId).url)}"`);
          emit(childId, e.depth + offset + 1);
        } else {
          lines.push(...renderEntry(e, pad, frameId));
        }
      }
    };
    emit(startFrame, 0);
    const main = byFrame.get(0) || byFrame.get(startFrame);
    let content = lines.join("\n");
    const focus = ref_id ? "use a smaller depth or focus on a more specific child element" : "use ref_id or a smaller depth to focus";
    if (truncated) content += `\n[truncated — the page is very large; ${focus}]`;
    if (content.length > max_chars) {
      const total = content.length;
      const cut = Math.max(0, content.lastIndexOf("\n", max_chars));
      content = `${content.slice(0, cut)}\n[output truncated at ${max_chars} of ${total} characters. Pass a larger max_chars (default 50000) to see more, or ${focus}.]`;
    }
    return { text: content, viewport: main.viewport };
  },

  async "page.find"({ tabId, query }) {
    await attach(tabId);
    const { byFrame, childAt } = await readFrames(tabId, { filter: "all", maxDepth: 1000, query: String(query) }, null);
    // Only frames reachable through visible iframes count.
    const state = tabState(tabId);
    const matches = [];
    const visit = (frameId) => {
      for (const e of byFrame.get(frameId).elements) {
        if (e.childIndex !== undefined) {
          const childId = childAt.get(`${frameId}:${e.childIndex}`);
          if (childId === undefined) continue;
          state.frames.set(childId, { parent: frameId, index: e.childIndex });
          visit(childId);
        } else {
          matches.push({ e, frameId });
        }
      }
    };
    visit(0);
    matches.sort((a, b) => b.e.score - a.e.score);
    if (!matches.length) return { text: `No elements found matching "${query}".` };
    const lines = matches.slice(0, 20).flatMap(({ e, frameId }) => renderEntry(e, "", frameId));
    if (matches.length > 20) {
      lines.push(`[${matches.length} elements matched; showing the best 20. Use a more specific query to narrow the results.]`);
    }
    return { text: lines.join("\n") };
  },

  async "page.text"({ tabId }) {
    await attach(tabId);
    const r = await runInFrame(tabId, 0, pageTextInFrame, []);
    if (!r) throw new Error("Could not read the page text.");
    return r;
  },

  async "page.eval"({ tabId, code }) {
    await attach(tabId);
    // replMode gives top-level await and returns the last expression.
    const { result, exceptionDetails } = await cdp(tabId, "Runtime.evaluate", {
      expression: code,
      replMode: true,
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
    return { type: result.type, value: result.value !== undefined ? result.value : formatRemoteObject(result) };
  },

  async "form.input"({ tabId, ref, value }) {
    await attach(tabId);
    const { frameId, localRef } = parseRef(ref);
    const out = await runInFrame(tabId, frameId, setInputInFrame, [localRef, value]);
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

  // Drop local files onto the page at a point, as if dragged in from the OS.
  async "page.dropFiles"({ tabId, x, y, files }) {
    await attach(tabId);
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await cdp(tabId, "Input.dispatchDragEvent", { type, x, y, data });
    }
    return { dropped: files.length };
  },

  // --- diagnostics -----------------------------------------------------------

  async "console.read"({ tabId, pattern, limit = 100, onlyErrors = false, clear = false }) {
    await attach(tabId);
    const state = tabState(tabId);
    let entries = state.console;
    if (onlyErrors) entries = entries.filter((e) => e.level === "error" || e.level === "exception");
    if (pattern) {
      const re = new RegExp(pattern);
      entries = entries.filter((e) => re.test(e.text));
    }
    const out = entries.slice(-limit);
    if (clear) state.console = [];
    return { domain: state.domain, messages: out };
  },

  async "network.read"({ tabId, urlPattern, limit = 100, clear = false }) {
    await attach(tabId);
    const state = tabState(tabId);
    let entries = [...state.network.values()];
    if (urlPattern) entries = entries.filter((e) => e.url.includes(urlPattern));
    const out = entries.slice(-limit);
    if (clear) state.network.clear();
    return { domain: state.domain, requests: out };
  },

  // --- images and GIFs ---------------------------------------------------------

  async "gif.encode"({ frames, options }) {
    return { base64: await encodeGif(frames, options) };
  },

  async "gif.download"({ base64, filename }) {
    const downloadId = await chrome.downloads.download({ url: `data:image/gif;base64,${base64}`, filename, saveAs: false });
    return { downloadId, filename };
  },

  async "image.toPng"({ base64, mime }) {
    return { base64: await toPng(base64, mime) };
  },

  // --- browser pairing -------------------------------------------------------

  async "pairing.request"({ requestId }) {
    await chrome.notifications.create(`pairing:${requestId}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Use this browser for Claude?",
      message: "A Claude session wants to automate this browser. Click Connect to choose it.",
      buttons: [{ title: "Connect" }],
      requireInteraction: true,
      priority: 2,
    });
    return {};
  },

  async "pairing.cancel"({ requestId }) {
    await chrome.notifications.clear(`pairing:${requestId}`);
    return {};
  },

  // --- development -----------------------------------------------------------

  async "extension.reload"() {
    // Reload this (unpacked) extension from disk. Respond first; the socket
    // drops when the service worker restarts, then reconnects.
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: true };
  },
};

const GROUP_FREE = new Set(["group.context", "group.createTab"]);

// Commands that target a tab must name one in the MCP tab group, that the
// user hasn't stopped, and that isn't one of this extension's own pages.
// Also keep the indicator up on tabs being driven.
async function handle(method, params) {
  const h = handlers[method];
  if (!h) throw new Error(`Unknown method: ${method}`);
  await stoppedReady;

  const { tabId } = params;
  if (tabId !== undefined && !GROUP_FREE.has(method)) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error(`Tab ${tabId} doesn't exist. Use tabs_context_mcp to get valid tab IDs.`);
    }
    const group = await getGroup();
    if (!group || tab.groupId !== group.id) {
      throw new Error(
        `Tab ${tabId} is not in the MCP tab group. Use tabs_context_mcp to see the tabs you can use, ` +
        "or tabs_create_mcp to open a new one."
      );
    }
    if (method !== "group.closeTab") {
      if (stoppedTabs.has(tabId)) {
        throw new Error(
          "The user pressed Stop on this tab. Don't continue on it unless they ask you to; " +
          "they can re-enable it by clicking the extension's toolbar icon on that tab."
        );
      }
      if (isOwnPage(tab.url)) throw new Error(OWN_PAGE_ERROR);
      if (method !== "window.resize") runInFrame(tabId, 0, installIndicator, []);
    }
  }
  if (method === "page.navigate" && isOwnPage(params.url)) throw new Error(OWN_PAGE_ERROR);
  return h(params);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The extension's own pages run with extension privileges; an agent driving
// them could reach chrome.* APIs, so they're off limits.
const OWN_PAGE_ERROR = "The bridge extension's own pages can't be automated.";
function isOwnPage(url) {
  return String(url || "").startsWith(chrome.runtime.getURL(""));
}

// "example.com" -> "https://example.com"; leaves URLs with a scheme alone.
function normalizeUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

const quote = (s) => String(s).replace(/"/g, '\\"');

// Read every frame (plus a focused subtree if ref_id is given) and work out
// which child frame belongs to which parent <iframe>.
async function readFrames(tabId, opts, refId) {
  const base = { ...opts, focusRef: null, maxElements: MAX_ELEMENTS };
  const [results, frameInfo] = await Promise.all([
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: readPageInFrame, args: [base] }),
    chrome.webNavigation.getAllFrames({ tabId }),
  ]);
  const byFrame = new Map();
  for (const r of results) if (r.result) byFrame.set(r.frameId, r.result);

  let startFrame = 0;
  if (refId) {
    const { frameId, localRef } = parseRef(refId);
    startFrame = frameId;
    const focused = await runInFrame(tabId, frameId, readPageInFrame, [{ ...base, focusRef: localRef }]);
    if (!focused) throw new Error(staleRefMessage(refId));
    if (focused.error) throw new Error(focused.error);
    byFrame.set(frameId, focused);
  }
  if (!byFrame.has(startFrame)) {
    throw new Error("Could not read the page (chrome:// pages and the Web Store can't be scripted).");
  }
  // Match each child frame to its parent's <iframe> placeholder by its
  // index in the parent's window.frames.
  const childAt = new Map();
  for (const f of frameInfo || []) {
    const r = byFrame.get(f.frameId);
    if (f.parentFrameId >= 0 && r && r.selfIndex >= 0) childAt.set(`${f.parentFrameId}:${r.selfIndex}`, f.frameId);
  }
  return { byFrame, startFrame, childAt };
}

// Render one outline entry like Claude in Chrome does:
//   button "Sign in" [ref_4] type="submit"
function renderEntry(e, pad, frameId) {
  const ref = frameId === 0 ? e.ref : `${e.ref}@f${frameId}`;
  let line = `${pad}${e.role}`;
  if (e.name) line += ` "${quote(e.name)}"`;
  line += ` [${ref}]`;
  if (e.href) line += ` href="${quote(e.href)}"`;
  if (e.type) line += ` type="${quote(e.type)}"`;
  if (e.placeholder) line += ` placeholder="${quote(e.placeholder)}"`;
  if (e.value !== undefined) line += ` value="${quote(e.value)}"`;
  if (e.checked !== undefined) line += e.checked ? " (checked)" : " (unchecked)";
  if (e.expanded !== undefined) line += e.expanded ? " (expanded)" : " (collapsed)";
  if (e.disabled) line += " (disabled)";
  const lines = [line];
  for (const o of e.options || []) {
    let opt = `${pad} option "${quote(o.text)}"`;
    if (o.selected) opt += " (selected)";
    if (o.value && o.value !== o.text) opt += ` value="${quote(o.value)}"`;
    lines.push(opt);
  }
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

// Refs are "ref_12" in the main frame and "ref_12@f7" in frame 7.
function parseRef(ref) {
  const m = /^(ref_\d+)(?:@f(\d+))?$/.exec(String(ref));
  if (!m) throw new Error(`Malformed ref "${ref}" — use a ref from read_page or find (e.g. "ref_12").`);
  return { localRef: m[1], frameId: m[2] ? Number(m[2]) : 0 };
}

function staleRefMessage(ref) {
  return `Element with ref_id '${ref}' not found. It may have been removed from the page. Use read_page or find to get current refs.`;
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
