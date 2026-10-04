// Key definitions for Input.dispatchKeyEvent (US keyboard layout).
// Modifier bitmask: 1=Alt 2=Ctrl 4=Meta/Cmd 8=Shift.

export const KEYS = {
  Enter:      { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab:        { key: "Tab", code: "Tab", keyCode: 9 },
  Escape:     { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace:  { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete:     { key: "Delete", code: "Delete", keyCode: 46 },
  Insert:     { key: "Insert", code: "Insert", keyCode: 45 },
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
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const KEY_ALIASES = {
  return: "Enter", enter: "Enter", tab: "Tab", esc: "Escape", escape: "Escape",
  backspace: "Backspace", delete: "Delete", del: "Delete", insert: "Insert",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", pgup: "PageUp", pgdn: "PageDown",
  space: "Space",
};

const MODIFIER_BITS = {
  alt: 1, option: 1, opt: 1,
  ctrl: 2, control: 2,
  meta: 4, cmd: 4, command: 4, super: 4, win: 4,
  shift: 8,
};

const SHIFTED = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};
const PUNCTUATION = {
  "-": { code: "Minus", keyCode: 189 }, "=": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 }, "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 }, ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 }, ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 }, "/": { code: "Slash", keyCode: 191 },
  "`": { code: "Backquote", keyCode: 192 },
};

// Key for a printable character, for typing with real key events. Returns
// null for characters with no key (they're typed via insertText).
export function charKey(ch) {
  if (ch === "\n" || ch === "\r") return { ...KEYS.Enter, shift: false };
  if (ch === " ") return { ...KEYS.Space, shift: false };
  const shift = ch in SHIFTED;
  const base = shift ? SHIFTED[ch] : ch;
  if (/^[a-zA-Z]$/.test(base)) {
    const upper = base.toUpperCase();
    return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: ch, shift: base !== base.toLowerCase() };
  }
  if (/^[0-9]$/.test(base)) return { key: ch, code: `Digit${base}`, keyCode: base.charCodeAt(0), text: ch, shift };
  if (base in PUNCTUATION) return { key: ch, ...PUNCTUATION[base], text: ch, shift };
  return null;
}

// Parse a modifier list like "cmd+shift" into a bitmask.
export function parseModifiers(spec) {
  if (!spec) return 0;
  let bits = 0;
  for (const part of String(spec).toLowerCase().split("+").map((s) => s.trim()).filter(Boolean)) {
    if (!(part in MODIFIER_BITS)) throw new Error(`Unknown modifier "${part}". Use alt, ctrl, cmd/meta, shift.`);
    bits |= MODIFIER_BITS[part];
  }
  return bits;
}

// Parse a key or chord like "Enter", "a", "cmd+a", "ctrl+shift+Tab".
export function parseChord(chord) {
  const raw = String(chord);
  // A trailing "+" is the plus key itself ("ctrl++").
  const parts = raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const keyName = raw === "+" ? "+" : parts.pop();
  let modifiers = 0;
  for (const p of parts) if (p) modifiers |= parseModifiers(p);
  const named = KEYS[keyName] || KEYS[KEY_ALIASES[keyName.toLowerCase()]];
  let def = named ? { ...named } : keyName.length === 1 ? charKey(keyName) : null;
  if (!def) throw new Error(`Unknown key "${keyName}". Use a single character or one of: ${Object.keys(KEYS).join(", ")}.`);
  if (def.shift) modifiers |= 8;
  return { def, modifiers };
}

// On macOS the renderer doesn't handle native editing shortcuts (Cmd+A, Cmd+C,
// ...) itself, so they must be sent as explicit editing commands.
export function macEditingCommands(def, modifiers) {
  const k = (def.key || "").toLowerCase();
  if (modifiers === 4) return { a: ["selectAll"], c: ["copy"], x: ["cut"], v: ["paste"], z: ["undo"] }[k] || [];
  if (modifiers === 12 && k === "z") return ["redo"];
  return [];
}
