// Chrome Debug Bridge — MV3 service worker.
//
// Connects to a local MCP server over WebSocket and executes commands against
// browser tabs using the Chrome DevTools Protocol (chrome.debugger).
//
// Protocol (JSON over WebSocket):
//   request:  { id, method, params }
//   response: { id, result } | { id, error: { message } }

const BRIDGE_URL = "ws://127.0.0.1:9333";
const CDP_VERSION = "1.3";

let ws = null;
let reconnectDelay = 1000;

// Per-tab state: { attached, console: [], network: Map<requestId, entry> }
const tabs = new Map();

function tabState(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, { attached: false, console: [], network: new Map() });
  }
  return tabs.get(tabId);
}

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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.keepalive) {
    send({ ping: Date.now() });
    connect();
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
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  state.attached = true;
  await cdp(tabId, "Runtime.enable");
  await cdp(tabId, "Page.enable");
  await cdp(tabId, "Network.enable");
  await cdp(tabId, "Log.enable");
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId && tabs.has(source.tabId)) tabState(source.tabId).attached = false;
});

chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

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
// Command handlers
// ---------------------------------------------------------------------------

const handlers = {
  // --- tabs ---------------------------------------------------------------

  async "tabs.context"() {
    const all = await chrome.tabs.query({});
    return {
      tabs: all.map((t) => ({
        id: t.id,
        windowId: t.windowId,
        active: t.active,
        url: t.url,
        title: t.title,
      })),
    };
  },

  async "tabs.create"({ url }) {
    const tab = await chrome.tabs.create({ url: url || "about:blank" });
    return { tabId: tab.id };
  },

  async "tabs.close"({ tabId }) {
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },

  // --- navigation ----------------------------------------------------------

  async "page.navigate"({ tabId, url }) {
    await attach(tabId);
    await cdp(tabId, "Page.navigate", { url });
    await waitForLoad(tabId, 15000);
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url, title: tab.title };
  },

  async "page.goBack"({ tabId }) {
    await attach(tabId);
    const { currentIndex, entries } = await cdp(tabId, "Page.getNavigationHistory");
    if (currentIndex > 0) {
      await cdp(tabId, "Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id });
    }
    return {};
  },

  // --- screenshot ----------------------------------------------------------

  async "page.screenshot"({ tabId, format = "jpeg", quality = 80 }) {
    await attach(tabId);
    const params = { format, fromSurface: true };
    if (format === "jpeg") params.quality = quality;
    const { data } = await cdp(tabId, "Page.captureScreenshot", params);
    return { format, base64: data };
  },

  // --- input ---------------------------------------------------------------

  async "input.click"({ tabId, x, y, ref, button = "left", clickCount = 1 }) {
    await attach(tabId);
    if (ref !== undefined) ({ x, y } = await refToPoint(tabId, ref));
    const base = { x, y, button, clickCount, pointerType: "mouse" };
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", clickCount: 0 });
    for (let i = 1; i <= clickCount; i++) {
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: i });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: i });
    }
    return { clicked: { x, y } };
  },

  async "input.type"({ tabId, text }) {
    await attach(tabId);
    await cdp(tabId, "Input.insertText", { text });
    return {};
  },

  async "input.key"({ tabId, key, modifiers = 0 }) {
    await attach(tabId);
    const def = KEYS[key];
    if (!def) throw new Error(`Unknown key: ${key}. Known: ${Object.keys(KEYS).join(", ")}`);
    const event = {
      modifiers,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      key: def.key,
      code: def.code,
    };
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
    if (def.text) await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", ...event, text: def.text });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...event });
    return {};
  },

  async "input.scroll"({ tabId, x, y, deltaX = 0, deltaY = 0 }) {
    await attach(tabId);
    if (x === undefined || y === undefined) {
      const m = await cdp(tabId, "Page.getLayoutMetrics");
      x = Math.floor(m.cssVisualViewport.clientWidth / 2);
      y = Math.floor(m.cssVisualViewport.clientHeight / 2);
    }
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX, deltaY, pointerType: "mouse",
    });
    return {};
  },

  // --- page content ----------------------------------------------------------

  async "page.read"({ tabId, filter = "interactive" }) {
    await attach(tabId);
    const { result, exceptionDetails } = await cdp(tabId, "Runtime.evaluate", {
      expression: `(${READ_PAGE_FN})(${JSON.stringify(filter)})`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
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
    const { result, exceptionDetails } = await cdp(tabId, "Runtime.evaluate", {
      expression: `(${SET_INPUT_FN})(${JSON.stringify(ref)}, ${JSON.stringify(value)})`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
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
};

function handle(method, params) {
  const h = handlers[method];
  if (!h) throw new Error(`Unknown method: ${method}`);
  return h(params);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function listener(source, method) {
      if (source.tabId === tabId && method === "Page.loadEventFired") done();
    }
    function done() {
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      // Give the page a beat to run post-load scripts.
      setTimeout(resolve, 300);
    }
    chrome.debugger.onEvent.addListener(listener);
  });
}

// Resolve a ref (from page.read) to viewport coordinates of the element center.
async function refToPoint(tabId, ref) {
  const { result, exceptionDetails } = await cdp(tabId, "Runtime.evaluate", {
    expression: `(() => {
      const w = window.__dbgRefs && window.__dbgRefs.get(${JSON.stringify(ref)});
      const el = w && w.deref();
      if (!el || !el.isConnected) return null;
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
    returnByValue: true,
  });
  if (exceptionDetails || !result.value) {
    throw new Error(`Stale or unknown ref "${ref}" — call read_page again to refresh refs.`);
  }
  return result.value;
}

// Injected into the page: walks the DOM, assigns stable refs, and returns a
// compact outline of interactive (or all visible) elements.
const READ_PAGE_FN = `function (filter) {
  if (!window.__dbgRefs) { window.__dbgRefs = new Map(); window.__dbgRefRev = new WeakMap(); window.__dbgRefN = 0; }
  const refs = window.__dbgRefs;
  // Refs hold WeakRefs so they never pin removed DOM nodes; sweep dead ones.
  for (const [k, w] of refs) { if (!w.deref()) refs.delete(k); }
  function refFor(el) {
    const existing = window.__dbgRefRev.get(el);
    if (existing && refs.has(existing)) return existing;
    const r = "ref" + (++window.__dbgRefN);
    refs.set(r, new WeakRef(el)); window.__dbgRefRev.set(el, r);
    return r;
  }
  const SENSITIVE_AC = ["current-password","new-password","one-time-code","cc-number","cc-csc","cc-exp"];
  function isSensitive(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password" || type === "hidden") return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    return SENSITIVE_AC.some((s) => ac.includes(s));
  }
  const INTERACTIVE = new Set(["A","BUTTON","INPUT","SELECT","TEXTAREA","SUMMARY","OPTION"]);
  function isInteractive(el) {
    if (INTERACTIVE.has(el.tagName)) return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("contenteditable")) return true;
    const role = el.getAttribute("role");
    if (role && ["button","link","checkbox","radio","tab","menuitem","combobox","textbox","switch","slider","option"].includes(role)) return true;
    return typeof el.onclick === "function";
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }
  function name(el) {
    // Never let a field's value leak into its name: for form controls the
    // value fallback only applies to non-sensitive fields.
    const valueFallback = isSensitive(el) ? "" : (el.value || "");
    return (el.getAttribute("aria-label") || el.innerText || el.placeholder ||
            el.getAttribute("title") || el.getAttribute("alt") || valueFallback || "")
      .trim().slice(0, 120);
  }
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (!visible(node)) continue;
    const inter = isInteractive(node);
    if (filter === "interactive" && !inter) continue;
    if (filter !== "interactive" && !inter) {
      // In "all" mode include leaf text blocks only, to keep output compact.
      const tag = node.tagName;
      const textual = ["H1","H2","H3","H4","P","LI","TD","TH","LABEL","LEGEND","FIGCAPTION"].includes(tag);
      if (!textual) continue;
      const t = (node.innerText || "").trim();
      if (!t) continue;
      out.push({ tag: tag.toLowerCase(), text: t.slice(0, 200) });
      continue;
    }
    const entry = { ref: refFor(node), tag: node.tagName.toLowerCase(), name: name(node) };
    if (node.tagName === "INPUT") entry.type = node.type;
    if (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT") {
      entry.value = isSensitive(node)
        ? (node.value ? "[value redacted]" : "")
        : String(node.value || "").slice(0, 120);
    }
    if (node.disabled) entry.disabled = true;
    if (node.checked !== undefined && (node.type === "checkbox" || node.type === "radio")) entry.checked = node.checked;
    const role = node.getAttribute("role");
    if (role) entry.role = role;
    out.push(entry);
    if (out.length >= 500) break;
  }
  return { url: location.href, title: document.title, elements: out };
}`;

// Injected into the page: set a form control's value the way a user would,
// firing input/change events so frameworks (React, Vue) notice.
const SET_INPUT_FN = `function (ref, value) {
  const w = window.__dbgRefs && window.__dbgRefs.get(ref);
  const el = w && w.deref();
  if (!el || !el.isConnected) throw new Error("Stale or unknown ref: " + ref);
  el.focus();
  if (el.tagName === "SELECT") {
    el.value = value;
  } else if (el.type === "checkbox" || el.type === "radio") {
    el.checked = Boolean(value) && value !== "false";
  } else {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: el.value !== undefined ? el.value : el.checked };
}`;

// Minimal key map for Input.dispatchKeyEvent. Modifiers: 1=Alt 2=Ctrl 4=Meta 8=Shift.
const KEYS = {
  Enter:      { key: "Enter", code: "Enter", keyCode: 13, text: "\\r" },
  Tab:        { key: "Tab", code: "Tab", keyCode: 9 },
  Escape:     { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace:  { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete:     { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp:    { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown:  { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft:  { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home:       { key: "Home", code: "Home", keyCode: 36 },
  End:        { key: "End", code: "End", keyCode: 35 },
  PageUp:     { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown:   { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space:      { key: " ", code: "Space", keyCode: 32, text: " " },
};
