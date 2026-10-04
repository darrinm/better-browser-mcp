# Chrome Debug Bridge

Drive your own Chrome browser from an AI agent (or any MCP client), the same way
Claude's browser tools work:

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
| `tabs_context`, `new_tab`, `close_tab` | List, open and close tabs |
| `navigate` | Go to a URL (or `back`) and wait for the load |
| `resize_window` | Resize the tab's window |
| `screenshot` | Viewport capture as an image (JPEG by default, PNG on request) |
| `read_page` | Indented outline of the page with element refs |
| `find` | Elements whose label or text matches a query, anywhere on the page |
| `get_page_text` | Visible text of the main content |
| `click`, `hover`, `drag` | Mouse actions on a ref or at coordinates |
| `type`, `press_key` | Keyboard input; `press_key` takes chords like `cmd+a` |
| `scroll` | Scroll by pixels, or bring a ref into view |
| `form_input` | Set an input/select/checkbox value directly |
| `file_upload` | Attach local files to a file input |
| `javascript` | Evaluate JS in the page |
| `read_console`, `read_network` | Buffered console messages and network requests |

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
claude mcp add chrome-bridge -- node /ABSOLUTE/PATH/TO/chrome-dbg-ext/server/index.js
```

Then in a Claude Code session: *"use the chrome-bridge tools to open example.com
and take a screenshot"*.

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
- **Site blocklist.** Open the extension's options page (right-click the
  toolbar icon → Options) and list sites the agent must never touch, one
  pattern per line. Patterns match hostname + path, `*` is a wildcard, a bare
  domain (`mybank.com`) covers the whole site and its subdomains, and a path
  (`github.com/acme`) covers everything under it. Blocked sites can't be opened,
  navigated to, read, screenshotted or clicked. Administrators can also set
  `blockedUrlPatterns` through Chrome enterprise policy
  (`extension/managed_schema.json`).
- **The extension's own pages are off limits**, so an agent can't open the
  options page and edit its own blocklist.

## How it works

- **Attach on demand.** The first command touching a tab runs
  `chrome.debugger.attach` and enables the `Runtime`, `Page`, `Network`, and
  `Log` CDP domains. Chrome shows an "is debugging this browser" banner while
  attached — that's inherent to the `debugger` API.
- **Trusted input.** Clicks and keys go through `Input.dispatchMouseEvent` /
  `Input.dispatchKeyEvent`, so they're indistinguishable from real user input
  (`isTrusted: true`), unlike synthetic DOM events. `type` sends a real
  keyDown/keyUp per character (US layout; characters with no key, like emoji,
  fall back to `Input.insertText`), so autocomplete and per-key handlers fire.
  On macOS, `cmd+a/c/x/v/z` are sent with the matching editing command,
  because the renderer doesn't handle those native shortcuts itself.
- **Page reading in the isolated world.** `read_page`, `find`, ref clicks and
  `form_input` run via `chrome.scripting.executeScript` in the extension's
  isolated world, in every frame. That world can reach closed shadow roots
  (`chrome.dom.openOrClosedShadowRoot`), and page scripts can't see or tamper
  with the ref map.
- **Text outline.** `read_page` returns lines like
  `button "Sign in" [ref4]`, indented by nesting, which costs far fewer tokens
  than JSON. By default it lists interactive elements in the viewport;
  `filter: "all"` adds headings, landmarks and text, `fullPage: true` covers
  the whole page, `ref` focuses on a subtree, and `maxDepth`/`maxChars` bound
  the output.
- **Shadow DOM and iframes.** The walker descends into open and closed shadow
  roots and splices each visible iframe's content in where the iframe sits,
  cross-origin ones included. Refs inside a frame look like `ref3@f7`. Child
  frames are matched to their `<iframe>` elements by index in
  `window.frames` (comparing windows is allowed across origins), with frame
  ids from `chrome.webNavigation`. Hidden iframes are skipped, which also keeps
  invisible injected content out of the outline.
- **Clicking refs.** A ref is scrolled into view in its own frame, then each
  parent iframe's content-box offset is added on the way up. Because a scroll
  inside a cross-origin iframe reaches the parent page asynchronously, the
  point is re-measured until two readings agree. CDP mouse events hit-test from
  the top level, so the click lands in the right frame.
- **Element refs** are held via `WeakRef` (dead ones are swept on each read),
  so removed nodes are never pinned in memory, and stay stable across reads
  until the page navigates.
- **Navigation waits for the right load.** `navigate` starts listening before
  it navigates and matches the `load` lifecycle event by `loaderId`, so a fast
  cached load can't be missed and a subframe's load can't end the wait early.
  Same-document (`#hash`) navigations return immediately; failures like DNS
  errors are reported.
- **Drag and drop.** `drag` moves the mouse in steps for pointer-driven drags,
  and uses `Input.setInterceptDrags` + `Input.dispatchDragEvent` (as Puppeteer
  does) so HTML5 drag-and-drop works too.
- **File upload** tags the input in the isolated world, finds it with
  `DOM.performSearch`, and calls `DOM.setFileInputFiles`.
- **Sensitive values are redacted.** Password fields, `type=hidden` inputs,
  and fields with sensitive `autocomplete` values (`cc-number`,
  `one-time-code`, `new-password`, …) come back as `[value redacted]` from
  `read_page`, and never leak through name fallbacks. (The `javascript` tool
  can still read anything — treat it accordingly.)
- **Dialogs can't wedge the bridge.** `alert`/`confirm`/`prompt` are
  auto-dismissed (and `beforeunload` auto-accepted) via
  `Page.handleJavaScriptDialog`; each one is logged to the console buffer so
  the agent sees what happened.
- **Console & network.** CDP events (`Runtime.consoleAPICalled`,
  `Runtime.exceptionThrown`, `Log.entryAdded`, `Network.*`) are buffered per
  tab (capped at 2000 entries) and read back with optional regex filters.
- **Screenshots** use `Page.captureScreenshot` and come back to the MCP client
  as real image content blocks, so a multimodal model can see the page. JPEG
  (quality 80) by default to keep token costs down; pass `format: "png"` for
  lossless captures.
- **Service-worker keepalive.** An offscreen document (exempt from MV3's ~30s
  service-worker idle kill) pings the worker every 20s, keeping the bridge
  WebSocket connected even when Chrome throttles background work.

## Development

`server/cli.js` is a dev harness: it hosts the extension's WebSocket and an
HTTP control endpoint on port 9334, so you can drive the bridge with curl. Its
`extension.reload` command reloads the unpacked extension from disk, so you
don't have to click reload in `chrome://extensions`:

```sh
node server/cli.js &
curl -s localhost:9334 -d '{"method":"tabs.context"}'
curl -s localhost:9334 -d '{"method":"extension.reload"}'
```

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
