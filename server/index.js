#!/usr/bin/env node
// MCP server for the Browser Driver MCP extension.
//
// Exposes the same tools, with the same names and parameters, as Claude in
// Chrome, so prompts and skills written for it work unchanged. Speaks MCP over
// stdio to the agent and reaches the extension in each connected browser
// through that browser's native messaging host (see bridge.js).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge } from "./bridge.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IMAGE_TTL_MS = 5 * 60 * 1000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const OUT_DIR = path.join(os.tmpdir(), "browser-driver-mcp");

const bridge = new Bridge();

// ---------------------------------------------------------------------------
// Session state: screenshots (for upload_image) and GIF recording
// ---------------------------------------------------------------------------

const images = new Map(); // imageId -> { base64, mime, width, height, at }

function storeImage(img) {
  const now = Date.now();
  for (const [id, v] of images) if (now - v.at > IMAGE_TTL_MS) images.delete(id);
  const id = `ss_${crypto.randomBytes(5).toString("hex")}`;
  images.set(id, { ...img, at: now });
  return id;
}

function writeOut(name, base64) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(base64, "base64"));
  return file;
}

const recording = { active: false, frames: [] };

async function recordFrame(tabId, action) {
  if (!recording.active) return;
  try {
    const shot = await bridge.call("page.screenshot", { tabId, scale: 0.5 });
    recording.frames.push({
      base64: shot.base64,
      mime: shot.mime,
      frameWidth: shot.frameWidth,
      frameHeight: shot.frameHeight,
      action,
    });
  } catch {
    // A failed frame shouldn't fail the action being recorded.
  }
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

const text = (t) => ({ type: "text", text: t });
const image = (img) => ({ type: "image", data: img.base64, mimeType: img.mime });
const ok = (...content) => ({ content });

async function tabContext() {
  const ctx = await bridge.call("group.context", { createIfEmpty: false });
  return JSON.stringify({ availableTabs: ctx.tabs, tabGroupId: ctx.groupId }, null, 2);
}

function need(cond, message) {
  if (!cond) throw new Error(message);
}

const pt = (c) => ({ x: c[0], y: c[1] });

// ---------------------------------------------------------------------------
// Tool implementations (name -> async args => { content, isError? })
// ---------------------------------------------------------------------------

const impl = {
  async tabs_context_mcp({ createIfEmpty }) {
    const ctx = await bridge.call("group.context", { createIfEmpty: !!createIfEmpty });
    if (!ctx.groupId) {
      return ok(text("No MCP tab group exists yet. Call tabs_context_mcp with createIfEmpty: true, or tabs_create_mcp, to create one."));
    }
    return ok(text(JSON.stringify({ availableTabs: ctx.tabs, tabGroupId: ctx.groupId }, null, 2)));
  },

  async tabs_create_mcp() {
    const r = await bridge.call("group.createTab", {});
    return ok(text(`Created new tab. Tab ID: ${r.tabId}\n\n${JSON.stringify({ availableTabs: r.tabs }, null, 2)}`));
  },

  async tabs_close_mcp({ tabId }) {
    const r = await bridge.call("group.closeTab", { tabId });
    return ok(text(`Closed tab ${tabId}.\n\n${JSON.stringify({ availableTabs: r.tabs }, null, 2)}`));
  },

  async navigate({ tabId, url }) {
    const standalone = tabId === undefined;
    if (standalone) {
      need(url !== "back" && url !== "forward", `tabId is required for url: "${url}".`);
      const ctx = await bridge.call("group.context", { createIfEmpty: true });
      tabId = ctx.tabs[0].tabId;
    }
    const r = await bridge.call("page.navigate", { tabId, url });
    const appended = standalone ? "\n\n" + (await tabContext()) : "";
    await recordFrame(tabId, { type: "navigate", label: `Navigate to ${r.url}` });
    const what = url === "back" || url === "forward" ? `Went ${url} to` : "Navigated to";
    return ok(text(`${what} ${r.url}${r.title ? ` (${r.title})` : ""} in tab ${tabId}${appended}`));
  },

  async computer(a) {
    const { tabId, action } = a;
    const label = a.action_summary || action.replace(/_/g, " ");
    const point = async () => {
      if (a.ref) return { ref: a.ref };
      need(Array.isArray(a.coordinate), `coordinate (or ref) is required for ${action}.`);
      return pt(a.coordinate);
    };
    const shot = async (method, params) => {
      const img = await bridge.call(method, { tabId, ...params });
      const imageId = storeImage(img);
      const parts = [`Successfully captured ${action === "zoom" ? "zoomed region" : "screenshot"} (${img.width}x${img.height}, jpeg) - ID: ${imageId}`];
      if (action === "screenshot" && img.width !== img.frameWidth) {
        parts.push(`Image is scaled; coordinates are in the full-resolution ${img.frameWidth}x${img.frameHeight} viewport frame.`);
      } else if (action === "screenshot") {
        parts.push(`Viewport: ${img.frameWidth}x${img.frameHeight}`);
      }
      if (a.save_to_disk) parts.push(`Saved to ${writeOut(`${imageId}.jpg`, img.base64)}`);
      if (action === "screenshot") await recordFrame(tabId, null);
      return ok(text(parts.join("\n")), image(img));
    };
    const clicks = { left_click: ["left", 1], right_click: ["right", 1], double_click: ["left", 2], triple_click: ["left", 3] };

    switch (action) {
      case "screenshot":
        return shot("page.screenshot", { scale: a.scale ?? 1 });

      case "zoom":
        need(Array.isArray(a.region) && a.region.length === 4, "region [x0, y0, x1, y1] is required for zoom.");
        return shot("page.zoom", { region: a.region, scale: a.scale ?? 1 });

      case "left_click":
      case "right_click":
      case "double_click":
      case "triple_click": {
        const [button, clickCount] = clicks[action];
        const r = await bridge.call("input.click", { tabId, ...(await point()), button, clickCount, modifiers: a.modifiers });
        await recordFrame(tabId, { type: "click", label, coordinate: [r.x, r.y] });
        return ok(text(`${action.replace("_", " ")} at (${Math.round(r.x)}, ${Math.round(r.y)})${a.ref ? ` on ${a.ref}` : ""}`));
      }

      case "hover": {
        const r = await bridge.call("input.hover", { tabId, ...(await point()) });
        await recordFrame(tabId, { type: "hover", label, coordinate: [r.x, r.y] });
        return ok(text(`Hovered at (${Math.round(r.x)}, ${Math.round(r.y)})`));
      }

      case "left_click_drag": {
        need(Array.isArray(a.start_coordinate) && Array.isArray(a.coordinate), "start_coordinate and coordinate are required for left_click_drag.");
        const r = await bridge.call("input.drag", { tabId, from: pt(a.start_coordinate), to: pt(a.coordinate), modifiers: a.modifiers });
        await recordFrame(tabId, { type: "drag", label, start: [r.from.x, r.from.y], coordinate: [r.to.x, r.to.y] });
        return ok(text(`Dragged from (${r.from.x}, ${r.from.y}) to (${r.to.x}, ${r.to.y})`));
      }

      case "type":
        need(typeof a.text === "string", "text is required for type.");
        await bridge.call("input.type", { tabId, text: a.text });
        await recordFrame(tabId, { type: "type", label });
        return ok(text(`Typed ${JSON.stringify(a.text)}`));

      case "key": {
        need(typeof a.text === "string" && a.text.trim(), "text (the key or keys to press) is required for key.");
        const r = await bridge.call("input.keys", { tabId, text: a.text, repeat: a.repeat ?? 1 });
        await recordFrame(tabId, { type: "key", label });
        return ok(text(`Pressed ${r.pressed} key${r.pressed === 1 ? "" : "s"}: ${a.text}${(a.repeat ?? 1) > 1 ? ` (x${a.repeat})` : ""}`));
      }

      case "scroll": {
        need(a.scroll_direction, "scroll_direction is required for scroll.");
        const at = Array.isArray(a.coordinate) ? pt(a.coordinate) : {};
        const amount = a.scroll_amount ?? 3;
        await bridge.call("input.scroll", { tabId, ...at, direction: a.scroll_direction, amount });
        await recordFrame(tabId, { type: "scroll", label });
        return ok(text(`Scrolled ${a.scroll_direction} by ${amount} tick${amount === 1 ? "" : "s"}`));
      }

      case "scroll_to": {
        need(a.ref, "ref is required for scroll_to.");
        const r = await bridge.call("input.scrollTo", { tabId, ref: a.ref });
        await recordFrame(tabId, { type: "scroll", label });
        return ok(text(`Scrolled ${a.ref} into view; it is now at (${Math.round(r.x)}, ${Math.round(r.y)})`));
      }

      case "wait": {
        const s = Math.min(10, Math.max(0, a.duration ?? 1));
        await new Promise((r) => setTimeout(r, s * 1000));
        return ok(text(`Waited ${s} second${s === 1 ? "" : "s"}`));
      }

      default:
        throw new Error(`Unknown action "${action}".`);
    }
  },

  async read_page({ tabId, filter, depth, ref_id, max_chars }) {
    const r = await bridge.call("page.read", { tabId, filter, depth, ref_id, max_chars });
    return ok(text(`${r.text}\n\nViewport: ${r.viewport.width}x${r.viewport.height}`));
  },

  async find({ tabId, query }) {
    return ok(text((await bridge.call("page.find", { tabId, query })).text));
  },

  async form_input({ tabId, ref, value }) {
    await bridge.call("form.input", { tabId, ref, value });
    await recordFrame(tabId, { type: "input", label: "Fill form field" });
    return ok(text(`Set ${ref} to ${JSON.stringify(value)}`));
  },

  async get_page_text({ tabId }) {
    const r = await bridge.call("page.text", { tabId });
    return ok(text(`Title: ${r.title}\nURL: ${r.url}\n\n${r.text}`));
  },

  async javascript_tool({ tabId, action, text: code }) {
    need(action === "javascript_exec", "action must be 'javascript_exec'.");
    const r = await bridge.call("page.eval", { tabId, code });
    const out = r.type === "undefined" ? "undefined" : typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2);
    return ok(text(out));
  },

  async read_console_messages({ tabId, pattern, limit, onlyErrors, clear }) {
    const r = await bridge.call("console.read", { tabId, pattern, limit, onlyErrors, clear });
    if (!r.messages.length) return ok(text(`No console messages${pattern ? ` matching /${pattern}/` : ""} for ${r.domain || "this page"}.`));
    const lines = r.messages.map((m) => `[${m.level}] ${m.text}`);
    return ok(text(`${r.messages.length} console message${r.messages.length === 1 ? "" : "s"} from ${r.domain}:\n${lines.join("\n")}`));
  },

  async read_network_requests({ tabId, urlPattern, limit, clear }) {
    const r = await bridge.call("network.read", { tabId, urlPattern, limit, clear });
    if (!r.requests.length) return ok(text(`No network requests${urlPattern ? ` matching "${urlPattern}"` : ""} for ${r.domain || "this page"}.`));
    const lines = r.requests.map((q) => `${q.method} ${q.error ? `FAILED (${q.error})` : q.status ?? "pending"} ${q.url}${q.type ? ` [${q.type}]` : ""}`);
    return ok(text(`${r.requests.length} request${r.requests.length === 1 ? "" : "s"} from ${r.domain}:\n${lines.join("\n")}`));
  },

  async resize_window({ tabId, width, height }) {
    const r = await bridge.call("window.resize", { tabId, width, height });
    return ok(text(`Resized window to ${r.width}x${r.height}`));
  },

  async file_upload({ tabId, ref, paths }) {
    const files = paths.map((p) => path.resolve(p));
    let total = 0;
    for (const f of files) {
      need(fs.existsSync(f), `No such file: ${f}`);
      total += fs.statSync(f).size;
    }
    need(total < MAX_UPLOAD_BYTES, `Files total ${(total / 1048576).toFixed(1)} MB; the limit is 10 MB per call.`);
    await bridge.call("form.upload", { tabId, ref, files });
    return ok(text(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"} to ${ref}: ${files.map((f) => path.basename(f)).join(", ")}`));
  },

  async upload_image({ tabId, imageId, ref, coordinate, filename }) {
    need(!!ref !== Array.isArray(coordinate), "Provide either ref or coordinate, not both.");
    const img = images.get(imageId);
    need(img && Date.now() - img.at <= IMAGE_TTL_MS, `Screenshot ${imageId} not found or expired. Take a new screenshot and upload that.`);
    const name = filename || "image.png";
    let data = img.base64;
    if (/\.png$/i.test(name) && img.mime !== "image/png") data = (await bridge.call("image.toPng", { base64: data, mime: img.mime })).base64;
    const file = writeOut(`${crypto.randomBytes(4).toString("hex")}-${path.basename(name)}`, data);
    if (ref) await bridge.call("form.upload", { tabId, ref, files: [file] });
    else await bridge.call("page.dropFiles", { tabId, x: coordinate[0], y: coordinate[1], files: [file] });
    return ok(text(`Uploaded ${name} (${img.width}x${img.height}) ${ref ? `to ${ref}` : `by dropping at (${coordinate[0]}, ${coordinate[1]})`}`));
  },

  async gif_creator({ tabId, action, download, filename, coordinate, options }) {
    switch (action) {
      case "start_recording":
        recording.active = true;
        recording.frames = [];
        return ok(text("Started recording. Take a screenshot now to capture the initial state as the first frame."));
      case "stop_recording":
        recording.active = false;
        return ok(text(`Stopped recording (${recording.frames.length} frame${recording.frames.length === 1 ? "" : "s"} kept). Use export to save the GIF.`));
      case "clear":
        recording.active = false;
        recording.frames = [];
        return ok(text("Discarded all recorded frames."));
      case "export": {
        need(recording.frames.length, "No frames recorded. Start recording, take screenshots and actions, then export.");
        const { base64 } = await bridge.call("gif.encode", { frames: recording.frames, options });
        const name = filename || `recording-${Date.now()}.gif`;
        const kb = Math.round((base64.length * 3) / 4 / 1024);
        if (Array.isArray(coordinate)) {
          const file = writeOut(path.basename(name), base64);
          await bridge.call("page.dropFiles", { tabId, x: coordinate[0], y: coordinate[1], files: [file] });
          return ok(text(`Exported ${recording.frames.length}-frame GIF (${kb} KB) and dropped it at (${coordinate[0]}, ${coordinate[1]}).`));
        }
        need(download, "Set download: true to download the GIF, or pass coordinate to drop it onto the page.");
        await bridge.call("gif.download", { base64, filename: path.basename(name) });
        return ok(text(`Exported ${recording.frames.length}-frame GIF (${kb} KB); downloaded as ${path.basename(name)}.`));
      }
      default:
        throw new Error(`Unknown gif_creator action "${action}".`);
    }
  },

  async shortcuts_list() {
    return ok(text(
      "No shortcuts or workflows are available. Shortcuts are saved prompts that run in Claude in Chrome's " +
      "side panel, which this bridge doesn't have."
    ));
  },

  async shortcuts_execute() {
    throw new Error("Shortcuts aren't supported by this bridge (there's no side panel to run them in). Do the steps directly with the other tools.");
  },

  async browser_batch({ actions }) {
    const content = [];
    for (let i = 0; i < actions.length; i++) {
      const { name, input } = actions[i];
      const fn = impl[name];
      if (name === "browser_batch") return { isError: true, content: [...content, text(`[${i + 1}] browser_batch can't be nested.`)] };
      if (!fn) return { isError: true, content: [...content, text(`[${i + 1}] Unknown tool "${name}". Batch stopped.`)] };
      try {
        const r = await fn(input || {});
        content.push(text(`[${i + 1}] ${name}${input && input.action ? ` (${input.action})` : ""}:`), ...r.content);
      } catch (err) {
        content.push(text(`[${i + 1}] ${name} failed: ${err.message}\nBatch stopped; ${actions.length - i - 1} remaining action(s) not run.`));
        return { isError: true, content };
      }
    }
    return { content };
  },

  async list_connected_browsers() {
    const list = bridge.list().map((b) => ({
      deviceId: b.deviceId,
      name: b.name,
      platform: b.platform,
      isLocal: true, // hosts are reached over local Unix sockets
      onThisComputer: true,
      inUse: bridge.selected ? b.deviceId === bridge.selected : bridge.entries().length === 1,
    }));
    return ok(text(list.length ? JSON.stringify(list, null, 2) : "No browsers are connected."));
  },

  async select_browser({ deviceId }) {
    need(bridge.find(deviceId), `No connected browser has deviceId ${deviceId}. Use list_connected_browsers.`);
    bridge.selected = deviceId;
    const b = bridge.find(deviceId).info;
    return ok(text(`Selected ${b.name} (${deviceId}) for browser automation.`));
  },

  async switch_browser() {
    const deviceId = await bridge.pair(120000);
    if (!deviceId) return { isError: true, content: [text("No browser was chosen within 2 minutes.")] };
    bridge.selected = deviceId;
    const b = bridge.find(deviceId).info;
    return ok(text(`Connected to ${b.name} (${deviceId}).`));
  },
};

// ---------------------------------------------------------------------------
// MCP registration — names, parameters and descriptions follow Claude in
// Chrome's tools.
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "browser-driver-mcp", version: "0.6.0" });

const TAB = "Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.";
const NO_TAB = "If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.";
const tabId = (what) => z.number().describe(`Tab ID ${what}. ${TAB}`);
const point = z.array(z.number()).length(2);
const summary = (example) =>
  z.string().optional().describe(
    `A few words saying what this does on the page and to what, for example '${example}'. State the effect only, ` +
    "and accurately: no reasons, nothing about what you were asked or allowed to do, no passwords or other secrets."
  );

function tool(name, description, shape) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return await impl[name](args);
    } catch (err) {
      return { isError: true, content: [text(String(err.message || err))] };
    }
  });
}

tool(
  "tabs_context_mcp",
  "Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. " +
    "CRITICAL: You must get the context at least once before using other browser automation tools so you know what " +
    "tabs exist. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing " +
    "existing tabs, unless the user explicitly asks to use an existing tab.",
  {
    createIfEmpty: z.boolean().optional().describe(
      "Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab " +
      "(which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect."
    ),
  }
);

tool(
  "tabs_create_mcp",
  "Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least " +
    "once before using other browser automation tools so you know what tabs exist. Tabs you create are yours to clean " +
    "up: close each one with tabs_close_mcp as soon as you no longer need it, and close any that remain before " +
    "finishing your task. Leave a tab open only if the user asked to see it or wants it kept open.",
  {}
);

tool(
  "tabs_close_mcp",
  "Close a tab in the MCP tab group by its ID. Use to clean up tabs you're done with. Only tabs in this session's " +
    "group are closable; call tabs_context_mcp first to get valid IDs. If you close the group's last tab, Chrome " +
    "auto-removes the group — the next tabs_context_mcp with createIfEmpty starts fresh.",
  { tabId: z.number().int().describe("The ID of the tab to close. Must be in this session's tab group. Get valid IDs from tabs_context_mcp.") }
);

tool(
  "navigate",
  "Navigate to a URL, or go forward/back in browser history. tabId may be omitted for URL navigation: " +
    "tabs_context_mcp{createIfEmpty:true} is called for you and the first tab in the session's group is navigated — " +
    "its result is appended to this call's output so you have the tab list and ids for subsequent calls. tabId is " +
    "required for url:\"back\"/\"forward\". A tab opened for you this way is yours to clean up, the same as one from " +
    "tabs_create_mcp.",
  {
    url: z.string().describe(
      'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go ' +
      'forward in history or "back" to go back in history.'
    ),
    tabId: z.number().optional().describe(
      "Tab ID to navigate. Must be a tab in the current group. If omitted for URL navigation, " +
      'tabs_context_mcp{createIfEmpty:true} is called for you. Required for url:"back"/"forward".'
    ),
  }
);

tool(
  "computer",
  "Use a mouse and keyboard to interact with a web browser, and take screenshots. " + NO_TAB + "\n" +
    "* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the " +
    "coordinates of the element before moving the cursor.\n" +
    "* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click " +
    "location so that the tip of the cursor visually falls on the element that you want to click.\n" +
    "* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click " +
    "boxes on their edges unless asked.",
  {
    action: z.enum([
      "left_click", "right_click", "type", "screenshot", "wait", "scroll", "key", "left_click_drag",
      "double_click", "triple_click", "zoom", "scroll_to", "hover",
    ]).describe(
      "The action to perform:\n" +
      "* `left_click`: Click the left mouse button at the specified coordinates.\n" +
      "* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n" +
      "* `double_click`: Double-click the left mouse button at the specified coordinates.\n" +
      "* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n" +
      "* `type`: Type a string of text.\n" +
      "* `screenshot`: Take a screenshot of the screen.\n" +
      "* `wait`: Wait for a specified number of seconds.\n" +
      "* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n" +
      "* `key`: Press a specific keyboard key.\n" +
      "* `left_click_drag`: Drag from start_coordinate to coordinate.\n" +
      "* `zoom`: Take a screenshot of a specific region for closer inspection.\n" +
      "* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n" +
      "* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing " +
      "tooltips, dropdown menus, or triggering hover states."
    ),
    tabId: z.number().describe(`Tab ID to execute the action on. ${TAB}`),
    coordinate: point.optional().describe(
      "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for " +
      "`left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position."
    ),
    start_coordinate: point.optional().describe("(x, y): The starting coordinates for `left_click_drag`."),
    text: z.string().optional().describe(
      "The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide " +
      'space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s ' +
      'modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all). Page zoom ' +
      'shortcuts (e.g. "cmd+=", "ctrl+-", "cmd+0") are not supported and will return an error - use the `zoom` action ' +
      "to magnify a region of the page instead."
    ),
    ref: z.string().optional().describe(
      'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. ' +
      "Can be used as alternative to `coordinate` for click actions."
    ),
    modifiers: z.string().optional().describe(
      'Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). ' +
      'Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.'
    ),
    duration: z.number().min(0).max(10).optional().describe("The number of seconds to wait. Required for `wait`. Maximum 10 seconds."),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional().describe("The direction to scroll. Required for `scroll`."),
    scroll_amount: z.number().min(1).max(10).optional().describe("The number of scroll wheel ticks. Optional for `scroll`, defaults to 3."),
    region: z.array(z.number()).length(4).optional().describe(
      "(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left " +
      "(x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for " +
      "inspecting small UI elements like icons, buttons, or text."
    ),
    repeat: z.number().int().min(1).max(100).optional().describe(
      "Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between " +
      "1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times."
    ),
    scale: z.number().min(0.1).max(1).optional().describe(
      "For `screenshot` and `zoom` only. Scale factor in [0.1, 1] for the returned image; 1 (default) uses the full " +
      "image, 0.5 returns an image at half the width and height (~quarter of the tokens). Coordinates are ALWAYS in " +
      "the full-resolution coordinate frame (reported with every scaled screenshot), never in the scaled image's own pixels."
    ),
    save_to_disk: z.boolean().optional().describe(
      "For screenshot/zoom actions: save the image to disk so it can be attached to a message for the user. Returns the " +
      "saved path in the tool result. Only set this when you intend to share the image."
    ),
    action_summary: summary("Opens the Filters menu"),
  }
);

tool(
  "read_page",
  "Get an accessibility tree representation of elements on the page. By default returns all elements including " +
    "non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit it is " +
    "truncated at a line boundary, with a note giving the full size — pass a larger max_chars, or use depth/ref_id to " +
    "focus on part of the page. Optionally filter for only interactive elements. Covers shadow DOM and iframes (refs " +
    "inside an iframe look like ref_3@f7). " + NO_TAB,
  {
    tabId: tabId("to read from"),
    filter: z.enum(["interactive", "all"]).optional().describe(
      'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)'
    ),
    depth: z.number().optional().describe("Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large."),
    ref_id: z.string().optional().describe(
      "Reference ID of a parent element to read. Will return the specified element and all its children. Use this to " +
      "focus on a specific part of the page when output is too large."
    ),
    max_chars: z.number().optional().describe("Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs."),
  }
);

tool(
  "find",
  "Find elements on the page using natural language. Can search for elements by their purpose (e.g., \"search bar\", " +
    "\"login button\") or by text content (e.g., \"organic mango product\"). Returns up to 20 matching elements with " +
    "references that can be used with other tools. If more than 20 matches exist, you'll be notified to use a more " +
    "specific query. " + NO_TAB,
  {
    query: z.string().describe('Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")'),
    tabId: tabId("to search in"),
  }
);

tool(
  "form_input",
  "Set values in form elements using element reference ID from the read_page tool. " + NO_TAB,
  {
    ref: z.string().describe('Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")'),
    value: z.union([z.string(), z.boolean(), z.number()]).describe(
      "The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number"
    ),
    tabId: tabId("to set form value in"),
    action_summary: summary("Sets the delivery date to 29 September"),
  }
);

tool(
  "get_page_text",
  "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or " +
    "other text-heavy pages. Returns plain text without HTML formatting. " + NO_TAB,
  { tabId: tabId("to extract text from") }
);

tool(
  "javascript_tool",
  "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact " +
    "with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. " + NO_TAB,
  {
    action: z.string().describe("Must be set to 'javascript_exec'"),
    text: z.string().describe(
      "The JavaScript code to execute. Evaluated in the page context with REPL semantics: top-level `await` works, and " +
      "the result of the last expression is returned automatically — write the expression you want (e.g. " +
      "`window.myData.value`, or `await fetch(url).then(r=>r.json())`) rather than `return ...`."
    ),
    tabId: tabId("to execute the code in"),
  }
);

tool(
  "read_console_messages",
  "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for " +
    "debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. " +
    "Returns console messages from the current domain only. " + NO_TAB + " IMPORTANT: Always provide a pattern to " +
    "filter messages - without a pattern, you may get too many irrelevant messages.",
  {
    tabId: tabId("to read console messages from"),
    pattern: z.string().optional().describe(
      "Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., " +
      "'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs)."
    ),
    limit: z.number().optional().describe("Maximum number of messages to return. Defaults to 100. Increase only if you need more results."),
    onlyErrors: z.boolean().optional().describe("If true, only return error and exception messages. Default is false (return all message types)."),
    clear: z.boolean().optional().describe("If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false."),
  }
);

tool(
  "read_network_requests",
  "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API " +
    "calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests " +
    "made by the current page, including cross-origin requests. Requests are automatically cleared when the page " +
    "navigates to a different domain. " + NO_TAB,
  {
    tabId: tabId("to read network requests from"),
    urlPattern: z.string().optional().describe(
      "Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., " +
      "'/api/' to filter API calls, 'example.com' to filter by domain)."
    ),
    limit: z.number().optional().describe("Maximum number of requests to return. Defaults to 100. Increase only if you need more results."),
    clear: z.boolean().optional().describe("If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false."),
  }
);

tool(
  "resize_window",
  "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up " +
    "specific screen sizes. " + NO_TAB,
  {
    width: z.number().describe("Target window width in pixels"),
    height: z.number().describe("Target window height in pixels"),
    tabId: tabId("to get the window for"),
  }
);

tool(
  "file_upload",
  "Upload one or multiple files to a file input element on the page. Do not click on file upload buttons or file " +
    "inputs — clicking opens a native file picker dialog that you cannot see or interact with. Instead, use read_page " +
    "or find to locate the file input element, then use this tool with its ref to upload files directly. The combined " +
    "size of all files in a single call must stay under 10 MB.",
  {
    paths: z.array(z.string()).min(1).describe("Absolute paths to the files to upload."),
    ref: z.string().describe('Element reference ID of the file input from read_page or find tools (e.g., "ref_1", "ref_2").'),
    tabId: z.number().describe(`Tab ID where the file input is located. ${NO_TAB}`),
  }
);

tool(
  "upload_image",
  "Upload a screenshot you took with the computer tool's screenshot action to a file input or drag & drop target. " +
    "Screenshot IDs expire a few minutes after capture, so take the screenshot of what you want to upload right before " +
    "uploading. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, " +
    "(2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.",
  {
    imageId: z.string().describe("ID of a screenshot from the computer tool's screenshot action, taken shortly before this call."),
    tabId: z.number().describe("Tab ID where the target element is located. This is where the image will be uploaded to."),
    ref: z.string().optional().describe(
      'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially ' +
      "hidden ones) or specific elements. Provide either ref or coordinate, not both."
    ),
    coordinate: z.array(z.number()).optional().describe(
      "Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google " +
      "Docs. Provide either ref or coordinate, not both."
    ),
    filename: z.string().optional().describe('Optional filename for the uploaded file (default: "image.png")'),
  }
);

tool(
  "gif_creator",
  "Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser " +
    "actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action " +
    "labels, progress bar, watermark). All operations are scoped to the tab's group. When starting recording, take a " +
    "screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a " +
    "screenshot immediately before to capture the final state as the last frame. For export, either provide " +
    "'coordinate' to drag/drop upload to a page element, or set 'download: true' to download the GIF.",
  {
    action: z.enum(["start_recording", "stop_recording", "export", "clear"]).describe(
      "Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), " +
      "'export' (generate and export GIF), 'clear' (discard frames)"
    ),
    tabId: z.number().describe("Tab ID to identify which tab group this operation applies to"),
    download: z.boolean().optional().describe("Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser."),
    filename: z.string().optional().describe("Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only."),
    coordinate: z.array(z.number()).optional().describe("Viewport coordinates [x, y] to drag & drop the exported GIF onto. For 'export' action only."),
    options: z.object({
      showClickIndicators: z.boolean().optional().describe("Show orange circles at click locations (default: true)"),
      showDragPaths: z.boolean().optional().describe("Show red arrows for drag actions (default: true)"),
      showActionLabels: z.boolean().optional().describe("Show black labels describing actions (default: true)"),
      showProgressBar: z.boolean().optional().describe("Show orange progress bar at bottom (default: true)"),
      showWatermark: z.boolean().optional().describe("Show a logo watermark (default: true)"),
      quality: z.number().optional().describe("GIF compression quality, 1-30 (lower = better quality, slower encoding). Default: 10"),
    }).optional().describe("Optional GIF enhancement options for 'export' action. All default to true except quality (default: 10)."),
  }
);

tool(
  "shortcuts_list",
  "List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with " +
    "their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow.",
  { tabId: tabId("to list shortcuts from") }
);

tool(
  "shortcuts_execute",
  "Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and " +
    "workflows are interchangeable). Use shortcuts_list first to see available shortcuts.",
  {
    tabId: tabId("to execute the shortcut on"),
    shortcutId: z.string().optional().describe("The ID of the shortcut to execute"),
    command: z.string().optional().describe("The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash."),
  }
);

tool(
  "browser_batch",
  "Execute a sequence of browser tool calls in ONE round trip. Each item is {name, input} where input is exactly what " +
    "you'd pass to that tool standalone. Actions execute SEQUENTIALLY (not in parallel) and stop on the first error. " +
    "Use this tool extensively to quickly execute work whenever you can predict two or more steps ahead — e.g. " +
    "navigate, click a field, type, press Return, screenshot. Screenshots and other images are returned interleaved " +
    "with outputs; coordinates you write in THIS batch refer to the screenshot taken BEFORE this call. browser_batch " +
    "cannot be nested.",
  {
    actions: z.array(z.object({
      name: z.string().describe("Tool name (e.g. computer, navigate, find, tabs_create_mcp). browser_batch cannot be nested."),
      input: z.record(z.any()).describe("That tool's input — same shape you'd pass when calling it directly."),
    })).min(1).describe(
      'List of tool calls to execute sequentially. Example: [{"name":"computer","input":{"action":"left_click",' +
      '"coordinate":[100,200],"tabId":123}},{"name":"computer","input":{"action":"type","text":"hello","tabId":123}}]'
    ),
  }
);

tool(
  "list_connected_browsers",
  "List all Chrome browsers (extension instances) currently connected to this bridge. Returns each browser's deviceId, " +
    "display name, OS platform, and inUse on the browser this session's actions go to. You do not need to call this " +
    "before using the browser: when one browser is connected, or one was already chosen for this session, browser " +
    "tools just work. Only if a browser tool reports that several browsers are connected and none is selected, or the " +
    "user asks to change browsers, ask the user which one to use, then call select_browser with the chosen deviceId, " +
    "or switch_browser to let them pick from inside the browser. Never pick one yourself.",
  {}
);

tool(
  "select_browser",
  "Select a specific Chrome browser by deviceId for browser automation, without broadcasting a pairing request. Use " +
    "this after list_connected_browsers when the user has chosen one from the list.",
  { deviceId: z.string().describe("The deviceId from list_connected_browsers.") }
);

tool(
  "switch_browser",
  "Send a connection request to every Chrome browser with the extension installed and wait (up to 2 minutes) for the " +
    "user to click 'Connect' in the one they want to use. Use this when the user wants to pick the browser themselves " +
    "from inside Chrome rather than choosing from a list; otherwise prefer select_browser with a known deviceId.",
  {}
);

// Development helpers, only with BRIDGE_DEV=1: call any extension method, or
// reload the unpacked extension from disk.
if (process.env.BRIDGE_DEV) {
  impl.dev_call = async ({ method, params }) => ok(text(JSON.stringify(await bridge.call(method, params || {}), null, 2)));
  impl.dev_reload_extension = async () => ok(text(JSON.stringify(await bridge.call("extension.reload"))));
  tool("dev_call", "Development: call an extension method directly.", { method: z.string(), params: z.record(z.any()).optional() });
  tool("dev_reload_extension", "Development: reload the unpacked extension from disk.", {});
}

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`browser-driver-mcp: MCP on stdio, browsers via native hosts in ${bridge.dir}`);
