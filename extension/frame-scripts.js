// Functions injected into page frames via chrome.scripting.executeScript.
//
// They run in the extension's isolated world (shared DOM, separate JS
// globals, so page scripts can't see or tamper with the ref map), and are
// serialized with Function.prototype.toString, so each must be fully
// self-contained. Their globals persist per document across calls.

// Walk the frame's composed tree (including open and closed shadow roots),
// assign stable refs, and return included elements as a flat list with tree
// depths — the same semantics as Claude in Chrome's read_page:
//   filter "all" (default): every element worth naming, visible or not
//   filter "interactive": visible interactive elements in the viewport
//   focusRef: that element and its subtree (no viewport culling)
//   query: find mode — visible elements scored against a natural-language
//          query; each match carries a score, depth is 0
// Visible iframes become { childIndex } placeholders, where childIndex is the
// iframe's index in window.frames.
export function readPageInFrame(opts) {
  const { filter, maxDepth, query, focusRef, maxElements } = opts;
  const g = globalThis;
  if (!g.__dbgRefs) { g.__dbgRefs = new Map(); g.__dbgRefRev = new WeakMap(); }
  if (!g.__dbgRefN) g.__dbgRefN = 0;
  const refs = g.__dbgRefs;
  // Refs hold WeakRefs so they never pin removed DOM nodes; sweep dead ones.
  for (const [k, w] of refs) { if (!w.deref()) refs.delete(k); }
  function refFor(el) {
    const existing = g.__dbgRefRev.get(el);
    if (existing && refs.has(existing)) return existing;
    const r = "ref_" + (++g.__dbgRefN);
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
  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION", "DETAILS"]);
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
    return clean(t, 100);
  }
  function labelFor(el) {
    if (el.id) {
      const root = el.getRootNode();
      const l = root.querySelector && root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return clean(l.innerText || l.textContent, 100);
    }
    const wrap = el.closest("label");
    return wrap ? clean(wrap.innerText || wrap.textContent, 100) : "";
  }
  function nameOf(el, role) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return clean(aria, 100);
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT" && ["submit", "button", "reset"].includes(type) && el.value) return clean(el.value, 100);
      if (tag === "SELECT" && !isSensitive(el)) {
        const opt = el.options[el.selectedIndex];
        if (opt) return clean(opt.textContent, 100);
      }
      return labelFor(el) || clean(el.placeholder, 100) || clean(el.title, 100);
    }
    if (tag === "IMG") return clean(el.alt, 100);
    if (INTERACTIVE_TAGS.has(tag) || role === "heading" || INTERACTIVE_ROLES.has(role)) {
      return clean(el.innerText || el.textContent, 100) || clean(el.title, 100);
    }
    return ownText(el) || clean(el.title, 100);
  }

  // --- find scoring -------------------------------------------------------
  const STOP = new Set(["the", "a", "an", "to", "for", "of", "on", "in", "with", "containing", "that", "this", "and", "or", "my", "page"]);
  const ROLE_WORDS = {
    button: ["button"], btn: ["button"], link: ["link"],
    search: ["searchbox", "textbox", "combobox"], field: ["textbox", "searchbox", "combobox"],
    input: ["textbox", "searchbox", "combobox", "checkbox", "radio"], box: ["textbox", "searchbox", "checkbox"],
    bar: ["textbox", "searchbox", "navigation"], textbox: ["textbox"], textarea: ["textbox"],
    checkbox: ["checkbox"], radio: ["radio"], toggle: ["switch", "checkbox"], switch: ["switch"],
    dropdown: ["combobox", "listbox", "menu"], select: ["combobox", "listbox"], menu: ["menu", "menuitem", "combobox"],
    tab: ["tab"], image: ["image"], icon: ["image", "button"], picture: ["image"], logo: ["image", "link"],
    heading: ["heading"], title: ["heading"], header: ["heading", "banner"], nav: ["navigation"],
    navigation: ["navigation"], slider: ["slider"], list: ["list"], item: ["listitem", "option", "menuitem"],
    dialog: ["dialog"], modal: ["dialog"], form: ["form"], option: ["option"],
  };
  const qTokens = query ? query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t)) : [];
  function score(el, role, name) {
    const hay = [name, el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("alt"),
      el.id, el.getAttribute("name"), el.getAttribute("href")]
      .filter(Boolean).join(" ").toLowerCase();
    let s = 0, contentHits = 0;
    for (const t of qTokens) {
      const words = ROLE_WORDS[t];
      if (words && words.includes(role)) s += 2;
      if (new RegExp(`\\b${t}`).test(hay)) { s += 3; contentHits++; }
      else if (hay.includes(t)) { s += 1; contentHits++; }
    }
    if (!contentHits && !(qTokens.length && qTokens.every((t) => ROLE_WORDS[t]))) return 0;
    if (isInteractive(el)) s += 1;
    return s;
  }

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE"]);
  const out = [];
  let truncated = false;
  const needVisible = filter === "interactive" || !!query;

  function entryFor(el, depth, role, name) {
    const e = { depth, role: role === "generic" ? "generic" : role, name, ref: refFor(el) };
    const href = el.getAttribute("href");
    if (href && el.tagName === "A") e.href = href.slice(0, 200);
    const tag = el.tagName;
    const type = el.getAttribute("type");
    if (type) e.type = type;
    if (el.getAttribute("placeholder")) e.placeholder = clean(el.getAttribute("placeholder"), 100);
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (el.type !== "checkbox" && el.type !== "radio" && el.value && el.value !== name) {
        e.value = isSensitive(el) ? "[value redacted]" : clean(el.value, 120);
      }
    }
    if (tag === "SELECT" && !isSensitive(el)) {
      e.options = [...el.options].slice(0, 50).map((o) => ({
        text: clean(o.textContent, 100), value: o.value, selected: o.selected,
      }));
    }
    if (el.type === "checkbox" || el.type === "radio") e.checked = el.checked;
    if (el.disabled) e.disabled = true;
    const expanded = el.getAttribute("aria-expanded");
    if (expanded !== null) e.expanded = expanded === "true";
    return e;
  }

  function include(el, role, name, interactive) {
    if (filter === "interactive") return interactive;
    return interactive || STRUCTURAL.has(role) || (role === "image" && !!name) || !!name;
  }

  function visit(node, depth, isRoot) {
    if (node.tagName === "IFRAME" || node.tagName === "FRAME") {
      // Hidden iframes are never spliced in, so invisible injected content
      // can't reach the outline.
      if (!visible(node) || (filter === "interactive" && !focusRef && !inViewport(node))) return false;
      for (let i = 0; i < window.length; i++) {
        if (window[i] === node.contentWindow) {
          out.push({ depth: query ? 0 : depth, childIndex: i, name: clean(node.title || node.name, 100) });
          break;
        }
      }
      return false;
    }
    if (!isRoot && filter !== "all" && node.getAttribute("aria-hidden") === "true") return false;
    if (needVisible && !visible(node)) return false;
    if (!isRoot && filter === "interactive" && !focusRef && !inViewport(node)) return false;
    const interactive = isInteractive(node);
    const role = roleOf(node);
    const name = nameOf(node, role);
    if (query) {
      if (!interactive && !name) return false;
      const sc = score(node, role, name);
      if (sc <= 0) return false;
      const e = entryFor(node, 0, role, name);
      e.score = sc;
      out.push(e);
      return false;
    }
    if (!isRoot && !include(node, role, name, interactive)) return false;
    out.push(entryFor(node, depth, role, name));
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
      if (needVisible && getComputedStyle(node).display === "none") continue; // unrendered subtree
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
    if (!el) return { error: `Element with ref_id '${focusRef}' not found. It may have been removed from the page. Use read_page without ref_id to get the current page state.` };
    if (!el.isConnected) return { error: `Element with ref_id '${focusRef}' no longer exists. It may have been removed from the page. Use read_page without ref_id to get the current page state.` };
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
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, size: Math.min(r.width, r.height) };
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
  let el = w && w.deref();
  if (!el || !el.isConnected) return { error: "Stale or unknown ref — call read_page again to refresh refs." };
  // A <label> stands for its control.
  if (el.tagName === "LABEL" && el.control) el = el.control;
  el.focus();
  if (el.tagName === "SELECT") {
    const v = String(value);
    const opt = [...el.options].find((o) => o.value === v) || [...el.options].find((o) => o.textContent.trim() === v);
    if (!opt) return { error: `No option with value or text "${v}". Options: ${[...el.options].map((o) => o.textContent.trim()).join(", ")}` };
    el.value = opt.value;
  } else if (el.type === "checkbox" || el.type === "radio") {
    el.checked = value === true || value === "true" || value === 1 || value === "1" || value === "on";
  } else if (el.isContentEditable) {
    el.textContent = String(value);
  } else {
    // The isolated world sees the native value setter, bypassing any
    // framework instrumentation on the element, so React's tracker sees a
    // genuine change.
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, String(value)); else el.value = String(value);
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

// Visible text of the page, prioritizing article content: a single
// <article>, else <main>, else the body.
export function pageTextInFrame() {
  const articles = document.querySelectorAll("article");
  const main = document.querySelector("main, [role=main]");
  const pick = (el) => el && (el.innerText || "").trim().length > 200;
  const el = articles.length === 1 && pick(articles[0]) ? articles[0] : pick(main) ? main : document.body;
  const text = (el ? el.innerText : "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { url: location.href, title: document.title, text };
}

// --- Agent indicator: glow border, Stop button, agent cursor ----------------
//
// The cursor's look and motion are a port of Cua Driver's default "signature
// arc" style (https://github.com/trycua/cua, libs/cua-driver; MIT, Copyright
// (c) 2025 Cua AI, Inc.; its bezier arc math is derived from trope-cua, MIT,
// Copyright (c) 2026 Victor Vannara). A move follows a cubic bezier arc with a
// small follow-through past the target and takes a Fitts'-law duration. The
// arrow turns toward its direction of travel, glows in proportion to its
// speed, and squishes and ripples when it presses. The license text is in
// THIRD_PARTY_NOTICES.md.

// `cursor` is the agent cursor's last position ({ x, y } in viewport CSS
// pixels), so it reappears there after a page load; null leaves it hidden
// until the first move.
export function installIndicator(cursor) {
  if (globalThis.__dbgIndicator?.isConnected) return;
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  // Cua's arrow on a 128-unit canvas, shown 42px wide, tip (hotspot) at (55, 30).
  const ARROW = "M55 30C48 28 42 33 43 41L64 98C67 106 73 106 77 99L86 79C88 75 91 72 95 70L108 63C115 59 114 53 107 50Z";
  const SIZE = 42;
  const HOT_X = (55 * SIZE) / 128;
  const HOT_Y = (30 * SIZE) / 128;
  const GLOW_R = 30 * 1.44; // the speed glow's largest radius; it's scaled down from this
  const halo = [[44, 0.02], [36, 0.024], [29, 0.03], [23, 0.038], [18, 0.048], [14, 0.06], [10, 0.075], [7, 0.095]]
    .map(([w, o]) => `<path d="${ARROW}" fill="none" stroke="#00aaff" stroke-width="${w}" stroke-opacity="${o}" stroke-linejoin="round"/>`)
    .join("");
  root.innerHTML = `<style>
    .glow { position: fixed; inset: 0; pointer-events: none;
      box-shadow: inset 0 0 0 3px rgba(0,170,255,.95), inset 0 0 28px 6px rgba(0,170,255,.45);
      animation: pulse 2.4s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .55; } }
    button { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
      pointer-events: auto; font: 600 13px/1 system-ui, sans-serif; color: #fff;
      background: #00aaff; border: 0; border-radius: 999px; padding: 9px 16px;
      box-shadow: 0 2px 10px rgba(0,0,0,.3); cursor: pointer; }
    button:hover { background: #0090dd; }
    svg.cursor { position: fixed; left: 0; top: 0; overflow: visible; pointer-events: none; opacity: 0;
      transform-origin: ${HOT_X}px ${HOT_Y}px; transition: opacity 150ms ease; }
    .speed, .ripple { position: fixed; left: 0; top: 0; border-radius: 50%; pointer-events: none; }
    .speed { width: ${2 * GLOW_R}px; height: ${2 * GLOW_R}px; opacity: 0;
      background: radial-gradient(closest-side, rgb(0,170,255), rgba(0,170,255,0)); }
    .ripple { box-sizing: border-box; border: solid rgb(115,208,255); }
  </style><div class="glow"></div><div class="speed"></div><button type="button">&#9632; Stop automation</button>
  <svg class="cursor" width="${SIZE}" height="${SIZE}" viewBox="0 0 128 128">${halo}
    <path d="${ARROW}" fill="#00aaff" stroke="#fff" stroke-width="5" stroke-linejoin="round"/></svg>`;
  const button = root.querySelector("button");
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    // Only a real user click counts; page scripts can't forge isTrusted.
    if (e.isTrusted) chrome.runtime.sendMessage({ stopAutomation: true });
  });
  const pointer = root.querySelector(".cursor");
  const speedGlow = root.querySelector(".speed");

  const TIP = -0.75 * Math.PI; // the arrow's tip direction at rest (up-left)
  const STEP = 1000 / 120; // moves are planned as 120 Hz samples
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
  const state = {
    pos: cursor,
    vel: { x: 0, y: 0 },
    rot: 0,
    move: null, // the move in progress: plan()'s result plus its start time
    pressAt: -1,
    frame: 0,
    last: 0,
  };

  // Plan a move from `a` to `b` as samples `step` ms apart. `size` is the
  // target's smaller side in px, for the Fitts'-law duration. An explicit
  // `ms` gives a straight move of that length instead, for a drag that must
  // follow the real pointer. Returns the samples and when the tip first
  // reaches the target, which is when the action should fire; any
  // follow-through plays on during it.
  function plan(a, b, { size, ms } = {}) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    let point = (f) => ({ x: a.x + dx * f, y: a.y + dy * f });
    let profile = minJerk;
    if (ms === undefined && !reduced) {
      // Bow perpendicular to the line; rightward moves bow upward. Cua's
      // arcFlow of 0.15 puts slightly more of the bow near the end.
      const side = dx > 0 ? -1 : 1;
      const px = -dy / dist;
      const py = dx / dist;
      const deflection = dist * 0.16 * side;
      const c1d = deflection * 0.7125;
      const c2d = deflection * 0.7875;
      const c1 = { x: a.x + dx * 0.3 + px * c1d, y: a.y + dy * 0.3 + py * c1d };
      const c2 = { x: b.x - dx * 0.3 + px * c2d, y: b.y - dy * 0.3 + py * c2d };
      // Arc-length table, so the profile maps to distance along the curve.
      const N = 256;
      const pts = [a];
      const cum = [0];
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const u = 1 - t;
        const w0 = u * u * u;
        const w1 = 3 * u * u * t;
        const w2 = 3 * u * t * t;
        const w3 = t * t * t;
        const p = { x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x, y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y };
        cum.push(cum[i - 1] + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y));
        pts.push(p);
      }
      const total = cum[N];
      const endLen = Math.hypot(b.x - c2.x, b.y - c2.y);
      const tx = (b.x - c2.x) / endLen;
      const ty = (b.y - c2.y) / endLen;
      point = (f) => {
        // Past the end, continue along the end tangent.
        if (f >= 1) return { x: b.x + tx * (f - 1) * total, y: b.y + ty * (f - 1) * total };
        const s = Math.max(0, f) * total;
        let lo = 0;
        let hi = N;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (cum[mid] < s) lo = mid;
          else hi = mid;
        }
        const k = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
        return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * k, y: pts[lo].y + (pts[hi].y - pts[lo].y) * k };
      };
      // Follow through up to 8px past the target, peaking 82% of the way in.
      const over = Math.min(0.018, 8 / dist);
      const ea = 8.2;
      const eb = 1.8;
      const peak = (ea / (ea + eb)) ** ea * (eb / (ea + eb)) ** eb;
      profile = (t) => minJerk(t) + (over * t ** ea * (1 - t) ** eb) / peak;
      ms ??= clamp(150 + 120 * Math.log2(dist / Math.max(4, size ?? 24) + 1), 300, 1000) * 1.1;
    }
    ms ??= 120;
    const n = Math.max(1, Math.round(ms / STEP));
    const samples = [];
    for (let i = 0; i <= n; i++) samples.push(point(profile(i / n)));
    const arrive = samples.findIndex((p) => Math.hypot(p.x - b.x, p.y - b.y) <= 1);
    return { samples, step: ms / n, arriveMs: (arrive < 0 ? n : arrive) * (ms / n) };
  }

  function frame() {
    // performance.now(), not the rAF timestamp: that is the frame's vsync
    // time and can precede the performance.now() that move() and press()
    // record, which would index samples[-1].
    const now = performance.now();
    state.frame = 0;
    const dt = Math.min(0.05, (now - state.last) / 1000);
    state.last = now;
    let busy = false;

    if (state.move) {
      const { samples, step, start } = state.move;
      const end = samples.length - 1;
      const f = (now - start) / step;
      const i = Math.min(Math.floor(f), end);
      const k = Math.min(f - i, 1);
      const p = samples[i];
      const q = samples[Math.min(i + 1, end)];
      state.pos = { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
      const i0 = Math.max(0, i - 2);
      const i1 = Math.min(end, i + 2);
      const span = ((i1 - i0) * step) / 1000;
      state.vel = span
        ? { x: (samples[i1].x - samples[i0].x) / span, y: (samples[i1].y - samples[i0].y) / span }
        : { x: 0, y: 0 };
      if (i >= end) {
        state.move = null;
        state.vel = { x: 0, y: 0 };
      }
      busy = true;
    }
    const { pos, vel } = state;
    const speed = Math.hypot(vel.x, vel.y);

    // Lead with the tip along the direction of travel; ease back to rest.
    const weight = reduced ? 0 : clamp((speed - 40) / 260, 0, 1);
    const want = weight ? wrap(Math.atan2(vel.y, vel.x) - TIP) * weight : 0;
    state.rot += wrap(want - state.rot) * (1 - Math.exp(-dt * 22));
    if (Math.abs(state.rot) > 0.002) busy = true;
    else if (!state.move) state.rot = 0;

    let squish = 0;
    if (state.pressAt >= 0) {
      const age = (now - state.pressAt) / 1000;
      if (age < 0.09) squish = 0.12 * Math.min(age / 0.05, 1);
      else {
        const u = Math.min((age - 0.09) / 0.22, 1);
        squish = 0.12 * Math.max(0, Math.cos(u * 1.5 * Math.PI)) * (1 - u);
      }
      if (age > 0.31) state.pressAt = -1;
      busy = true;
    }
    pointer.style.transform =
      `translate(${pos.x - HOT_X}px, ${pos.y - HOT_Y}px) rotate(${state.rot}rad) scale(${1 - squish})`;

    // A soft glow trails behind the cursor while it moves fast.
    const alpha = reduced ? 0 : Math.min(speed * 0.00014, 0.42);
    if (alpha < 0.02) speedGlow.style.opacity = 0;
    else {
      const back = Math.min(speed * 0.009, 18) / speed;
      const r = 30 * (1 + Math.min(speed * 0.00024, 0.44));
      speedGlow.style.opacity = alpha;
      speedGlow.style.transform =
        `translate(${pos.x - vel.x * back - GLOW_R}px, ${pos.y - vel.y * back - GLOW_R}px) scale(${r / GLOW_R})`;
    }

    if (busy) kick();
  }

  function kick() {
    if (!state.frame) state.frame = requestAnimationFrame(frame);
  }

  // Start a move to (x, y); returns ms until the tip reaches it. The first
  // move after install places the cursor without animating.
  function move(x, y, opts) {
    const from = state.pos;
    state.pos = { x, y };
    pointer.style.opacity = 1;
    if (from && Math.hypot(x - from.x, y - from.y) >= 1) {
      state.move = { ...plan(from, state.pos, opts), start: performance.now() };
      kick();
      // A hidden tab runs no animation frames and has no viewer to wait for.
      return document.hidden ? 0 : state.move.arriveMs;
    }
    kick();
    return 0;
  }

  // Squish the cursor and send a ripple out from (x, y): its radius eases
  // out from 8px to 52px while its border thins and it fades.
  function press(x, y) {
    if (reduced || document.hidden) return;
    const el = root.appendChild(document.createElement("div"));
    el.className = "ripple";
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.animate(
      [{ width: "16px", height: "16px", margin: "-8px" }, { width: "104px", height: "104px", margin: "-52px" }],
      { duration: 520, easing: "cubic-bezier(.33,1,.68,1)" },
    );
    el.animate([{ borderWidth: "5px", opacity: 0.75 }, { borderWidth: "1px", opacity: 0 }], 520).onfinish = () =>
      el.remove();
    state.pressAt = performance.now();
    kick();
  }

  if (cursor) {
    pointer.style.opacity = 1;
    kick();
  }
  document.documentElement.appendChild(host);
  globalThis.__dbgIndicator = host;
  globalThis.__dbgParts = { button, move, press };
}

// With `buttonOnly`, hide just the Stop button so a click can't land on it,
// and keep the glow and cursor on screen.
export function setIndicatorVisible(visible, buttonOnly) {
  const host = globalThis.__dbgIndicator;
  if (!host) return;
  const el = buttonOnly ? globalThis.__dbgParts.button : host;
  el.style.display = visible ? "" : "none";
}

// Start moving the agent cursor to (x, y); returns ms until it arrives. See
// installIndicator's plan() for `opts`.
export function moveCursor(x, y, opts) {
  const parts = globalThis.__dbgParts;
  if (!parts || !globalThis.__dbgIndicator.isConnected) return 0;
  return parts.move(x, y, opts);
}

// Squish the agent cursor and draw a ripple at (x, y).
export function pressCursor(x, y) {
  const parts = globalThis.__dbgParts;
  if (parts && globalThis.__dbgIndicator.isConnected) parts.press(x, y);
}

export function removeIndicator() {
  const host = globalThis.__dbgIndicator;
  if (host) host.remove();
  globalThis.__dbgIndicator = null;
  globalThis.__dbgParts = null;
}
