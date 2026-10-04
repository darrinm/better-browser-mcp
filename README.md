# Chrome Debug Bridge

Drive your own Chrome browser from an AI agent (or any MCP client) with the
same tools as Claude in Chrome — same names, same parameters, same behavior —
so prompts and skills written for Claude in Chrome work unchanged.

```
Claude Code ──(MCP over stdio)── server/index.js ──(WebSocket, localhost:9333)── Chrome extension ──(chrome.debugger / CDP)── your tabs
```

Two pieces:

- **`extension/`** — a Manifest V3 extension. Its service worker connects to the
  local bridge server and executes commands against tabs using the Chrome
  DevTools Protocol (`chrome.debugger`) and `chrome.scripting`.
- **`server/`** — a Node MCP server exposing those commands as tools.

## Tools

| Tool | What it does |
|---|---|
| `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp` | The "Claude" tab group: list its tabs (optionally creating it), open a tab in it, close one |
| `navigate` | Go to a URL, or `back`/`forward`; without a `tabId` it uses the group's first tab |
| `computer` | `left_click`, `right_click`, `double_click`, `triple_click`, `type`, `key`, `scroll`, `scroll_to`, `hover`, `left_click_drag`, `wait`, `screenshot`, `zoom` |
| `read_page` | Accessibility-style outline with `ref_N` element refs (`filter`, `depth`, `ref_id`, `max_chars`) |
| `find` | Elements matching a description like "login button" or "search bar" (up to 20) |
| `form_input` | Set an input, select, checkbox (boolean) or contenteditable by ref |
| `get_page_text` | Page text, preferring the article / main content |
| `javascript_tool` | Run JS in the page with REPL semantics (top-level `await`, last expression returned) |
| `read_console_messages`, `read_network_requests` | Console and network activity for the current domain |
| `resize_window` | Resize the tab's window |
| `file_upload` | Attach local files to a file input |
| `upload_image` | Upload a screenshot (by its ID) to a file input or drop it on the page |
| `gif_creator` | Record actions and export an annotated GIF |
| `browser_batch` | Run several tool calls in one round trip, stopping at the first error |
| `list_connected_browsers`, `select_browser`, `switch_browser` | Choose between several connected browsers |
| `shortcuts_list`, `shortcuts_execute` | Present for compatibility; there's no side panel, so no shortcuts |

Behaviors that match Claude in Chrome:

- Tools only act on tabs in the MCP tab group, which `tabs_context_mcp
  {createIfEmpty: true}` creates in a new window.
- Coordinates are viewport CSS pixels; screenshots come back at that size
  (`scale` shrinks the image, never the coordinate frame), and each one gets an
  ID that `upload_image` accepts for a few minutes.
- `key` takes space-separated keys and chords (`"Backspace Backspace"`,
  `"cmd+a"`, xdotool names like `Return` and `Page_Down`); page-zoom shortcuts
  are refused in favor of the `zoom` action.
- `read_page` defaults to `filter: "all"`, including non-visible elements;
  `"interactive"` lists only visible controls in the viewport.
- Console and network buffers reset when the tab moves to another domain.

Where it goes further: `read_page`, `find`, clicks and `form_input` reach into
closed shadow roots and cross-origin iframes (refs inside a frame look like
`ref_3@f7`), and sensitive form values are redacted.

Differences: `find` matches with a local scoring heuristic instead of a model;
there's no domain blocklist; shortcuts aren't available.

## Setup

### 1. Install the server

```sh
cd server
npm install
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder

The extension connects to `ws://127.0.0.1:9333` and retries with backoff, so
the order you start things in doesn't matter.

### 3. Register with Claude Code

```sh
claude mcp add claude-in-chrome -- node /ABSOLUTE/PATH/TO/chrome-dbg-ext/server/index.js
```

Naming the server `claude-in-chrome` makes the full tool names
(`mcp__claude-in-chrome__computer`, …) identical to Claude in Chrome's too, so
even skills that refer to tools by full name work. Turn off Claude Code's
built-in Chrome integration first (`/chrome`) so the two don't collide — or
pick any other name if you only need the short names to match.

Any other MCP client works the same way — point it at `node server/index.js`
over stdio. Set `BRIDGE_PORT` to change the WebSocket port (both sides; the
extension's port is the `BRIDGE_URL` constant in `extension/background.js`).

## Staying in control

- **Glow border and Stop button.** Any page being driven gets a pulsing border
  and a **Stop automation** button. Pressing Stop detaches the debugger and
  refuses further commands on that tab (the agent is told the user stopped it).
  Dismissing Chrome's "is debugging this browser" banner does the same. Click
  the extension's toolbar icon on a stopped tab to allow automation there
  again. The indicator lives in a closed shadow root and only honors trusted
  clicks, so page scripts can't press Stop or remove it for good; it's hidden
  while the agent clicks or takes a screenshot.
- **The tab group is the boundary.** Your other tabs are never touched.
- **The extension's own pages are off limits**, since they run with extension
  privileges.

## How it works

- **Attach on demand.** The first command touching a tab runs
  `chrome.debugger.attach` and enables the `Runtime`, `Page`, `Network`, and
  `Log` CDP domains. Chrome shows an "is debugging this browser" banner while
  attached — that's inherent to the `debugger` API.
- **Trusted input.** Clicks and keys go through `Input.dispatchMouseEvent` /
  `Input.dispatchKeyEvent`, so they're indistinguishable from real user input
  (`isTrusted: true`). `type` sends a real keyDown/keyUp per character (US
  layout; characters with no key, like emoji, fall back to `Input.insertText`).
  On macOS, `cmd+a/c/x/v/z` are sent with the matching editing command,
  because the renderer doesn't handle those native shortcuts itself.
- **Page reading in the isolated world.** `read_page`, `find`, ref clicks and
  `form_input` run via `chrome.scripting.executeScript` in the extension's
  isolated world, in every frame. That world can reach closed shadow roots
  (`chrome.dom.openOrClosedShadowRoot`), and page scripts can't see or tamper
  with the ref map. Refs are held via `WeakRef`, so removed nodes are never
  pinned in memory.
- **iframes.** Each visible iframe's content is spliced in where the iframe
  sits, cross-origin ones included. Child frames are matched to their
  `<iframe>` elements by index in `window.frames` (comparing windows is allowed
  across origins), with frame ids from `chrome.webNavigation`. Hidden iframes
  are skipped, which keeps invisible injected content out of the outline.
- **Clicking refs.** A ref is scrolled into view in its own frame, then each
  parent iframe's offset is added on the way up. A scroll inside a cross-origin
  iframe reaches the parent page asynchronously, so the point is re-measured
  until two readings agree. CDP mouse events hit-test from the top level, so
  the click lands in the right frame.
- **Screenshots** are clipped to the visual viewport with `clip.scale` set to
  undo the device pixel ratio, so image pixels equal CSS pixels equal click
  coordinates. `zoom` captures a region at up to 4x.
- **Navigation waits for the right load.** `navigate` starts listening before
  it navigates and matches the `load` lifecycle event by `loaderId`, so a fast
  cached load can't be missed and a subframe's load can't end the wait early.
- **Drag and drop.** `left_click_drag` moves the mouse in steps for
  pointer-driven drags, and uses `Input.setInterceptDrags` +
  `Input.dispatchDragEvent` so HTML5 drag-and-drop works too.
  `upload_image` and GIF export drop files with `Input.dispatchDragEvent`.
- **GIFs.** While recording, the server captures a frame after each action;
  export draws click circles, drag arrows, labels (from `action_summary`), a
  progress bar and a watermark on an `OffscreenCanvas` in the service worker,
  encodes with [gifenc](https://github.com/mattdesl/gifenc), and downloads via
  `chrome.downloads`.
- **Several browsers.** Each extension reports a persistent device ID; the
  server routes to the one selected (or the only one). `switch_browser` shows a
  Connect notification in every connected browser.
- **Dialogs can't wedge the bridge.** `alert`/`confirm`/`prompt` are
  auto-dismissed (and `beforeunload` auto-accepted); each is logged to the
  console buffer.
- **Service-worker keepalive.** An offscreen document (exempt from MV3's ~30s
  service-worker idle kill) pings the worker every 20s.

## Development

`server/cli.js` is a dev harness: it hosts the extension's WebSocket and an
HTTP control endpoint on port 9334, so you can call extension methods with
curl. `extension.reload` reloads the unpacked extension from disk:

```sh
node server/cli.js &
curl -s localhost:9334 -d '{"method":"group.context","params":{"createIfEmpty":true}}'
curl -s localhost:9334 -d '{"method":"extension.reload"}'
```

Starting the MCP server with `BRIDGE_DEV=1` adds `dev_call` and
`dev_reload_extension` tools for the same purpose.

## Caveats

- Only one debugger can be attached per tab — close DevTools on a tab before
  driving it, and vice versa.
- `chrome.debugger` can't attach to `chrome://` pages or the Web Store.
- `file_upload` can't reach file inputs inside cross-origin iframes.
- The WebSocket server binds to `127.0.0.1` only, but any local process (or
  web page) could connect to it, and anything listening on port 9333 when the
  server isn't running can drive the extension. For anything beyond personal
  use, check the `Origin` header and add a shared secret, or move to native
  messaging.
