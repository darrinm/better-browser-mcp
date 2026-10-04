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

const server = new McpServer({ name: "chrome-debug-bridge", version: "0.1.0" });

const tabId = z.number().int().describe("Target tab id (from tabs_context or new_tab)");

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
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

tool(
  "tabs_context",
  "List all open browser tabs with their ids, URLs, and titles. Call this first to see what's available.",
  {},
  async () => jsonResult(await bridge.call("tabs.context"))
);

tool(
  "new_tab",
  "Open a new browser tab, optionally at a URL. Returns the new tab id.",
  { url: z.string().optional().describe("URL to open (default about:blank)") },
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
  { tabId, url: z.string().describe("Destination URL, or 'back'") },
  async ({ tabId, url }) => {
    if (url === "back") return jsonResult(await bridge.call("page.goBack", { tabId }));
    return jsonResult(await bridge.call("page.navigate", { tabId, url }));
  }
);

tool(
  "screenshot",
  "Capture a screenshot of the tab's visible viewport. Returns a PNG image.",
  { tabId },
  async (args) => {
    const { base64 } = await bridge.call("page.screenshot", args);
    return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
  }
);

tool(
  "read_page",
  "Read the page as a compact element outline. filter='interactive' (default) lists clickable/editable " +
    "elements with ref ids usable in click/form_input; filter='all' also includes headings and text.",
  { tabId, filter: z.enum(["interactive", "all"]).optional() },
  async (args) => jsonResult(await bridge.call("page.read", args))
);

tool(
  "click",
  "Click in the page — either on an element by ref (from read_page) or at viewport coordinates. " +
    "Set clickCount=2 for a double-click.",
  {
    tabId,
    ref: z.string().optional().describe("Element ref from read_page"),
    x: z.number().optional().describe("Viewport x (if no ref)"),
    y: z.number().optional().describe("Viewport y (if no ref)"),
    button: z.enum(["left", "right", "middle"]).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
  },
  async (args) => {
    if (args.ref === undefined && (args.x === undefined || args.y === undefined)) {
      throw new Error("Provide either ref, or both x and y.");
    }
    return jsonResult(await bridge.call("input.click", args));
  }
);

tool(
  "type",
  "Type text into the currently focused element (click a field first).",
  { tabId, text: z.string() },
  async (args) => jsonResult(await bridge.call("input.type", args))
);

tool(
  "press_key",
  "Press a special key. Modifiers bitmask: 1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift.",
  {
    tabId,
    key: z.enum([
      "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Home", "End", "PageUp", "PageDown",
    ]),
    modifiers: z.number().int().optional(),
  },
  async (args) => jsonResult(await bridge.call("input.key", args))
);

tool(
  "scroll",
  "Scroll the page (or the element under x,y). Positive deltaY scrolls down.",
  {
    tabId,
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  async (args) => jsonResult(await bridge.call("input.scroll", args))
);

tool(
  "form_input",
  "Set a form control's value directly (input, textarea, select, checkbox) by ref, firing input/change " +
    "events so frameworks react. More reliable than click+type for selects and checkboxes.",
  { tabId, ref: z.string(), value: z.string() },
  async (args) => jsonResult(await bridge.call("form.input", args))
);

tool(
  "javascript",
  "Evaluate a JavaScript expression in the page and return its JSON-serializable result. " +
    "Await-able expressions are awaited. Avoid alert/confirm/prompt — they block the browser.",
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
