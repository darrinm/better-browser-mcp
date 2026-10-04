// Functions injected into page frames via chrome.scripting.executeScript.
//
// They run in the extension's isolated world (shared DOM, separate JS
// globals, so page scripts can't see or tamper with the ref map), and are
// serialized with Function.prototype.toString, so each must be fully
// self-contained. Their globals persist per document across calls.

// Walk the frame's composed tree (including open and closed shadow roots),
// assign stable refs, and return the included elements as a flat list with
// tree depths. Visible iframes become { childIndex } placeholders, where
// childIndex is the iframe's index in window.frames.
export function readPageInFrame(opts) {
  const { filter, viewportOnly, maxDepth, query, focusRef, maxElements } = opts;
  const g = globalThis;
  if (!g.__dbgRefs) { g.__dbgRefs = new Map(); g.__dbgRefRev = new WeakMap(); g.__dbgRefN = 0; }
  const refs = g.__dbgRefs;
  // Refs hold WeakRefs so they never pin removed DOM nodes; sweep dead ones.
  for (const [k, w] of refs) { if (!w.deref()) refs.delete(k); }
  function refFor(el) {
    const existing = g.__dbgRefRev.get(el);
    if (existing && refs.has(existing)) return existing;
    const r = "ref" + (++g.__dbgRefN);
    refs.set(r, new WeakRef(el)); g.__dbgRefRev.set(el, r);
    return r;
  }

  const shadowRootOf = (el) =>
    (chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : el.shadowRoot) || null;

  const SENSITIVE_AC = ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp"];
  function isSensitive(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password" || type === "hidden") return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    return SENSITIVE_AC.some((s) => ac.includes(s));
  }

  const ROLE_BY_TAG = {
    button: "button", select: "combobox", textarea: "textbox", img: "image", nav: "navigation",
    main: "main", header: "banner", footer: "contentinfo", aside: "complementary", form: "form",
    table: "table", ul: "list", ol: "list", li: "listitem", label: "label", summary: "button",
    details: "group", dialog: "dialog", section: "region", article: "article", option: "option",
    p: "paragraph", video: "video", audio: "audio",
  };
  const INPUT_ROLES = {
    submit: "button", button: "button", reset: "button", image: "button", file: "button",
    checkbox: "checkbox", radio: "radio", range: "slider", search: "searchbox",
  };
  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return INPUT_ROLES[(el.getAttribute("type") || "text").toLowerCase()] || "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (ROLE_BY_TAG[tag]) return ROLE_BY_TAG[tag];
    return el.isContentEditable ? "textbox" : "generic";
  }
  const STRUCTURAL = new Set([
    "heading", "navigation", "main", "banner", "contentinfo", "complementary", "form", "region",
    "article", "dialog", "table", "list", "listitem", "group",
  ]);
  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "combobox", "textbox", "searchbox", "switch", "slider", "option", "spinbutton", "treeitem",
  ]);
  function isInteractive(el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return el.tagName !== "A" || el.hasAttribute("href");
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return true;
    if (el.hasAttribute("onclick") || el.getAttribute("draggable") === "true") return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && tabindex !== "-1") return true;
    return INTERACTIVE_ROLES.has(el.getAttribute("role"));
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  function ownText(el) {
    let t = "";
    for (const c of el.childNodes) if (c.nodeType === Node.TEXT_NODE) t += c.textContent;
    return clean(t, 200);
  }
  function labelFor(el) {
    if (el.id) {
      const root = el.getRootNode();
      const l = root.querySelector && root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return clean(l.innerText, 100);
    }
    const wrap = el.closest("label");
    return wrap ? clean(wrap.innerText, 100) : "";
  }
  function nameOf(el, role) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return clean(aria, 100);
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT" && ["submit", "button", "reset"].includes(type) && el.value) return clean(el.value, 100);
      return labelFor(el) || clean(el.placeholder, 100) || clean(el.title, 100);
    }
    if (tag === "IMG") return clean(el.alt, 100);
    if (INTERACTIVE_TAGS.has(tag) || role === "heading" || INTERACTIVE_ROLES.has(role)) {
      return clean(el.innerText, 100) || clean(el.title, 100);
    }
    return ownText(el) || clean(el.title, 100);
  }

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
  const out = [];
  let truncated = false;

  function entryFor(el, depth, role, name) {
    const e = { depth, role, name, ref: refFor(el) };
    const href = el.getAttribute("href");
    if (href && el.tagName === "A") e.href = href.slice(0, 200);
    const tag = el.tagName;
    if (tag === "INPUT") e.type = el.type;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (el.placeholder && el.placeholder !== name) e.placeholder = clean(el.placeholder, 100);
      const sensitive = isSensitive(el);
      if (el.type !== "checkbox" && el.type !== "radio" && el.value) {
        e.value = sensitive ? "[value redacted]" : clean(el.value, 120);
      }
    }
    if (tag === "SELECT" && !isSensitive(el)) {
      e.options = [...el.options].slice(0, 25).map((o) => ({ text: clean(o.textContent, 80), selected: o.selected }));
    }
    if (el.type === "checkbox" || el.type === "radio") e.checked = el.checked;
    if (el.disabled) e.disabled = true;
    const expanded = el.getAttribute("aria-expanded");
    if (expanded !== null) e.expanded = expanded === "true";
    return e;
  }

  function include(el, role, name, interactive) {
    if (query) return (interactive || name) && (name + " " + (el.innerText || "")).toLowerCase().includes(query);
    if (filter === "interactive") return interactive;
    return interactive || STRUCTURAL.has(role) || (role === "image" && !!name) || !!name;
  }

  function visit(node, depth, isRoot) {
    if (node.tagName === "IFRAME" || node.tagName === "FRAME") {
      if (!visible(node) || (viewportOnly && !query && !inViewport(node))) return false;
      for (let i = 0; i < window.length; i++) {
        if (window[i] === node.contentWindow) {
          out.push({ depth, childIndex: i, name: clean(node.title || node.name, 100) });
          break;
        }
      }
      return false;
    }
    if (!visible(node)) return false;
    if (!isRoot && viewportOnly && !query && !inViewport(node)) return false;
    const interactive = isInteractive(node);
    const role = roleOf(node);
    const name = nameOf(node, role);
    if (!isRoot && !include(node, role, name, interactive)) return false;
    out.push(entryFor(node, query ? 0 : depth, role === "generic" ? "text" : role, name));
    return true;
  }

  // Depth-first over the composed tree: each element, then its shadow root,
  // then its light-DOM children (slotted content). Depth counts only
  // included ancestors, so wrapper divs don't indent the outline.
  function walk(root, depth) {
    for (const node of root.children) {
      if (out.length >= maxElements) { truncated = true; return; }
      if (SKIP.has(node.tagName)) continue;
      const included = visit(node, depth, false);
      if (node.tagName === "SELECT" || node.tagName === "IFRAME" || node.tagName === "FRAME") continue;
      if (getComputedStyle(node).display === "none") continue; // whole subtree is unrendered
      const next = included ? depth + 1 : depth;
      if (next > maxDepth) { truncated = true; continue; }
      const shadow = shadowRootOf(node);
      if (shadow) walk(shadow, next);
      walk(node, next);
    }
  }

  let root = document.body || document.documentElement;
  let startDepth = 0;
  if (focusRef) {
    const w = refs.get(focusRef);
    const el = w && w.deref();
    if (!el || !el.isConnected) return { error: `Ref "${focusRef}" is stale — call read_page without ref to refresh.` };
    visit(el, 0, true);
    root = el;
    startDepth = 1;
    const shadow = shadowRootOf(el);
    if (shadow) walk(shadow, startDepth);
  }
  walk(root, startDepth);

  // Which index this frame has in its parent's window.frames, so the
  // service worker can match it to the parent's <iframe> placeholder.
  let selfIndex = -1;
  if (window.parent !== window) {
    for (let i = 0; i < window.parent.length; i++) if (window.parent[i] === window) { selfIndex = i; break; }
  }
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    selfIndex,
    elements: out,
    truncated,
  };
}

// Scroll a ref's element into view and return its center in this frame's
// viewport coordinates, or null if the ref is stale.
export function locateRefInFrame(localRef) {
  const w = globalThis.__dbgRefs && globalThis.__dbgRefs.get(localRef);
  const el = w && w.deref();
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Find the <iframe> whose window is window.frames[childIndex] (searching
// shadow roots too), scroll it into view, and return its content-box origin
// in this frame's viewport.
export function iframeOffsetInFrame(childIndex) {
  const target = window[childIndex];
  if (!target) return null;
  const shadowRootOf = (el) =>
    (chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : el.shadowRoot) || null;
  function find(root) {
    for (const el of root.querySelectorAll("*")) {
      if ((el.tagName === "IFRAME" || el.tagName === "FRAME") && el.contentWindow === target) return el;
      const shadow = shadowRootOf(el);
      const hit = shadow && find(shadow);
      if (hit) return hit;
    }
    return null;
  }
  const frame = find(document);
  if (!frame) return null;
  frame.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const r = frame.getBoundingClientRect();
  const s = getComputedStyle(frame);
  return {
    x: r.left + frame.clientLeft + parseFloat(s.paddingLeft),
    y: r.top + frame.clientTop + parseFloat(s.paddingTop),
  };
}

// Set a form control's value the way a user would, firing input/change
// events so frameworks (React, Vue) notice. Returns { error } rather than
// throwing, since executeScript drops exceptions.
export function setInputInFrame(localRef, value) {
  const w = globalThis.__dbgRefs && globalThis.__dbgRefs.get(localRef);
  const el = w && w.deref();
  if (!el || !el.isConnected) return { error: "Stale or unknown ref — call read_page again to refresh refs." };
  el.focus();
  if (el.tagName === "SELECT") {
    const opt = [...el.options].find((o) => o.value === value) || [...el.options].find((o) => o.textContent.trim() === value);
    if (!opt) return { error: `No option with value or text "${value}".` };
    el.value = opt.value;
  } else if (el.type === "checkbox" || el.type === "radio") {
    el.checked = Boolean(value) && value !== "false";
  } else if (el.isContentEditable) {
    el.textContent = value;
  } else {
    // The isolated world sees the native value setter, bypassing any
    // framework instrumentation on the element, so React's tracker sees a
    // genuine change.
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}

// Tag a ref's element with a unique attribute so CDP can find it (for
// DOM.setFileInputFiles). Returns an error if it isn't a file input.
export function markFileInputInFrame(localRef, token) {
  const w = globalThis.__dbgRefs && globalThis.__dbgRefs.get(localRef);
  const el = w && w.deref();
  if (!el || !el.isConnected) return { error: "Stale or unknown ref — call read_page again to refresh refs." };
  if (el.tagName !== "INPUT" || el.type !== "file") return { error: "That element is not an <input type=file>." };
  if (token) el.setAttribute("data-dbg-upload", token); else el.removeAttribute("data-dbg-upload");
  return { ok: true };
}

// Visible text of the frame's main content.
export function pageTextInFrame() {
  const main = document.querySelector("main, [role=main]");
  const el = main && main.innerText.trim().length > 200 ? main : document.body;
  const text = (el ? el.innerText : "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { url: location.href, title: document.title, text };
}

// --- Agent indicator: glow border + Stop button -----------------------------

export function installIndicator() {
  const existing = globalThis.__dbgIndicator;
  if (existing && existing.isConnected) return;
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .glow { position: fixed; inset: 0; pointer-events: none;
      box-shadow: inset 0 0 0 3px rgba(217,119,87,.9), inset 0 0 28px 6px rgba(217,119,87,.4);
      animation: pulse 2.4s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .55; } }
    button { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
      pointer-events: auto; font: 600 13px/1 system-ui, sans-serif; color: #fff;
      background: #b8441f; border: 0; border-radius: 999px; padding: 9px 16px;
      box-shadow: 0 2px 10px rgba(0,0,0,.3); cursor: pointer; }
    button:hover { background: #8f3418; }
  </style><div class="glow"></div><button type="button">&#9632; Stop automation</button>`;
  root.querySelector("button").addEventListener("click", (e) => {
    e.stopPropagation();
    // Only a real user click counts; page scripts can't forge isTrusted.
    if (e.isTrusted) chrome.runtime.sendMessage({ stopAutomation: true });
  });
  document.documentElement.appendChild(host);
  globalThis.__dbgIndicator = host;
}

export function setIndicatorVisible(visible) {
  const host = globalThis.__dbgIndicator;
  if (host) host.style.display = visible ? "" : "none";
}

export function removeIndicator() {
  const host = globalThis.__dbgIndicator;
  if (host) host.remove();
  globalThis.__dbgIndicator = null;
}
