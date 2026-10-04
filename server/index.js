#!/usr/bin/env node
// MCP server for the Chrome Debug Bridge extension.
//
// Speaks MCP over stdio to the agent (Claude Code, etc.) and relays commands
// to the extension over a localhost WebSocket. The extension executes them
// via the Chrome DevTools Protocol.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

const WS_PORT = Number(process.env.BRIDGE_PORT || 9333);
const REQUEST_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// WebSocket bridge to the extension
// ---------------------------------------------------------------------------

class Bridge {
  constructor(port) {
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    this.wss.on("connection", (socket) => {
      // Latest connection wins (e.g. extension service worker restarted).
      this.socket = socket;
      socket.on("message", (data) => this.onMessage(data));
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
      });
    });
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.id === undefined) return; // hello / ping
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  }

  call(method, params) {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error(
        "Chrome extension is not connected. Make sure Chrome is running with the " +
        "Chrome Debug Bridge extension loaded (chrome://extensions → Load unpacked)."
      ));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for extension response to ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

const bridge = new Bridge(WS_PORT);

// ---------------------------------------------------------------------------
// MCP server and tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "chrome-debug-bridge", version: "0.2.0" });

const tabId = z.number().int().describe("Target tab id (from tabs_context or new_tab)");
const ref = z.string().describe('Element ref from read_page or find, e.g. "ref12" or "ref3@f7"');
const target = z
  .object({ ref: ref.optional(), x: z.number().optional(), y: z.number().optional() })
  .describe("An element ref, or viewport coordinates x and y");
const modifiers = z.string().optional().describe('Modifier keys held during the action, e.g. "shift" or "cmd+shift"');

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function tool(name, description, shape, handler) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: String(err.message || err) }] };
    }
  });
}

function requireTarget({ ref, x, y }, label = "target") {
  if (ref === undefined && (x === undefined || y === undefined)) {
    throw new Error(`Provide ${label} as a ref, or both x and y.`);
  }
}

tool(
  "tabs_context",
  "List all open browser tabs with their ids, URLs, and titles. Call this first to see what's available. " +
    "Tabs flagged stopped (the user pressed Stop) or blocked (on the user's blocklist) can't be driven.",
  {},
  async () => jsonResult(await bridge.call("tabs.context"))
);

tool(
  "new_tab",
  "Open a new browser tab, optionally at a URL. Returns the new tab id.",
  { url: z.string().optional().describe("URL to open (default about:blank); https:// is assumed if no scheme") },
  async ({ url }) => jsonResult(await bridge.call("tabs.create", { url }))
);

tool(
  "close_tab",
  "Close a browser tab.",
  { tabId },
  async (args) => jsonResult(await bridge.call("tabs.close", args))
);

tool(
  "navigate",
  "Navigate a tab to a URL and wait for the page to load. Pass url='back' to go back in history.",
  { tabId, url: z.string().describe("Destination URL (https:// assumed if no scheme), or 'back'") },
  async ({ tabId, url }) => {
    if (url === "back") return jsonResult(await bridge.call("page.goBack", { tabId }));
    return jsonResult(await bridge.call("page.navigate", { tabId, url }));
  }
);

tool(
  "resize_window",
  "Resize the browser window containing a tab, e.g. to test responsive layouts.",
  { tabId, width: z.number().int().min(200), height: z.number().int().min(200) },
  async (args) => jsonResult(await bridge.call("window.resize", args))
);

tool(
  "screenshot",
  "Capture a screenshot of the tab's visible viewport. JPEG by default (cheaper); pass format='png' " +
    "for lossless UI detail.",
  {
    tabId,
    format: z.enum(["jpeg", "png"]).optional(),
    quality: z.number().int().min(1).max(100).optional().describe("JPEG quality (default 80)"),
  },
  async (args) => {
    const { base64, format } = await bridge.call("page.screenshot", args);
    return { content: [{ type: "image", data: base64, mimeType: format === "png" ? "image/png" : "image/jpeg" }] };
  }
);

tool(
  "read_page",
  "Read the page as an indented outline of elements with refs, e.g. `button \"Sign in\" [ref4]`. Covers " +
    "shadow DOM and iframes (refs inside frames look like ref3@f7). By default lists only interactive " +
    "elements in the viewport; filter='all' adds headings, landmarks and text; fullPage=true covers the " +
    "whole page; ref focuses on one element's subtree. Sensitive values (passwords, card numbers) are redacted.",
  {
    tabId,
    filter: z.enum(["interactive", "all"]).optional(),
    fullPage: z.boolean().optional().describe("Include elements outside the viewport (default false)"),
    ref: ref.optional().describe("Only read this element's subtree"),
    maxDepth: z.number().int().min(1).max(50).optional().describe("Outline depth limit (default 15)"),
    maxChars: z.number().int().min(1000).optional().describe("Output size limit (default 50000)"),
  },
  async (args) => textResult((await bridge.call("page.read", args)).text)
);

tool(
  "find",
  "Find elements whose label or text contains the query (case-insensitive), anywhere on the page " +
    "including iframes and shadow DOM. Returns matching elements with refs.",
  { tabId, query: z.string().min(1) },
  async ({ tabId, query }) => textResult((await bridge.call("page.read", { tabId, query, filter: "all", fullPage: true })).text)
);

tool(
  "get_page_text",
  "Get the visible text of the page's main content (the <main> element if there is one, else the body). " +
    "Good for reading articles and listings without the element outline.",
  { tabId, maxChars: z.number().int().min(1000).optional().describe("Output size limit (default 50000)") },
  async (args) => textResult((await bridge.call("page.text", args)).text)
);

tool(
  "click",
  "Click in the page — on an element by ref (scrolled into view first) or at viewport coordinates. " +
    "clickCount 2/3 for double/triple click; modifiers e.g. 'cmd' to open a link in a new tab.",
  {
    tabId,
    ref: ref.optional(),
    x: z.number().optional().describe("Viewport x (if no ref)"),
    y: z.number().optional().describe("Viewport y (if no ref)"),
    button: z.enum(["left", "right", "middle"]).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
    modifiers,
  },
  async (args) => {
    requireTarget(args);
    return jsonResult(await bridge.call("input.click", args));
  }
);

tool(
  "hover",
  "Move the mouse over an element (by ref) or to viewport coordinates, e.g. to open hover menus or tooltips.",
  { tabId, ref: ref.optional(), x: z.number().optional(), y: z.number().optional() },
  async (args) => {
    requireTarget(args);
    return jsonResult(await bridge.call("input.hover", args));
  }
);

tool(
  "drag",
  "Drag from one point to another with the left mouse button. Works for HTML5 drag-and-drop as well as " +
    "pointer-driven drags (sliders, canvases, sortable lists).",
  { tabId, from: target, to: target, modifiers },
  async (args) => {
    requireTarget(args.from, "from");
    requireTarget(args.to, "to");
    return jsonResult(await bridge.call("input.drag", args));
  }
);

tool(
  "type",
  "Type text into the focused element (click a field first) with real key events, so autocomplete and " +
    "per-keystroke handlers fire. Newlines press Enter.",
  { tabId, text: z.string() },
  async (args) => jsonResult(await bridge.call("input.type", args))
);

tool(
  "press_key",
  "Press a key or chord, e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'F5', 'cmd+a', 'ctrl+shift+Tab'. " +
    "Modifiers: alt/option, ctrl, cmd/meta, shift.",
  {
    tabId,
    key: z.string().min(1),
    repeat: z.number().int().min(1).max(100).optional().describe("Press it this many times (default 1)"),
  },
  async (args) => jsonResult(await bridge.call("input.key", args))
);

tool(
  "scroll",
  "Scroll the page (or the element under x,y) by deltaX/deltaY pixels — positive deltaY scrolls down — " +
    "or pass ref to scroll that element into the middle of the viewport.",
  {
    tabId,
    ref: ref.optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  async (args) => jsonResult(await bridge.call("input.scroll", args))
);

tool(
  "form_input",
  "Set a form control's value directly (input, textarea, select by option value or text, checkbox, " +
    "contenteditable) by ref, firing input/change events so frameworks react.",
  { tabId, ref, value: z.string() },
  async (args) => jsonResult(await bridge.call("form.input", args))
);

tool(
  "file_upload",
  "Attach local files to an <input type=file> (by ref), as if the user picked them.",
  { tabId, ref, paths: z.array(z.string()).min(1).describe("Local file paths") },
  async ({ tabId, ref, paths }) => {
    const files = paths.map((p) => path.resolve(p));
    for (const f of files) if (!fs.existsSync(f)) throw new Error(`No such file: ${f}`);
    return jsonResult(await bridge.call("form.upload", { tabId, ref, files }));
  }
);

tool(
  "javascript",
  "Evaluate a JavaScript expression in the page's main frame and return its JSON-serializable result. " +
    "Await-able expressions are awaited. Dialogs (alert/confirm) are auto-dismissed.",
  { tabId, expression: z.string() },
  async (args) => jsonResult(await bridge.call("page.eval", args))
);

tool(
  "read_console",
  "Read buffered console messages and uncaught exceptions from the tab. " +
    "Use pattern (regex) to filter noisy output.",
  { tabId, pattern: z.string().optional(), limit: z.number().int().optional() },
  async (args) => jsonResult(await bridge.call("console.read", args))
);

tool(
  "read_network",
  "Read buffered network requests from the tab (URL, method, status, failures). " +
    "Use pattern (regex on URL) to filter.",
  { tabId, pattern: z.string().optional(), limit: z.number().int().optional() },
  async (args) => jsonResult(await bridge.call("network.read", args))
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`chrome-debug-bridge: MCP on stdio, extension bridge on ws://127.0.0.1:${WS_PORT}`);
