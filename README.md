# Chrome Debug Bridge

Drive your own Chrome browser from an AI agent (or any MCP client), the same way
Claude's browser tools work:

```
Claude Code ──(MCP over stdio)── server/index.js ──(WebSocket, localhost:9333)── Chrome extension ──(chrome.debugger / CDP)── your tabs
```

Two pieces:

- **`extension/`** — a Manifest V3 extension. Its service worker connects to the
  local bridge server and executes commands against tabs using the Chrome
  DevTools Protocol (`chrome.debugger`): screenshots, trusted mouse/keyboard
  input, JS evaluation, and buffered console + network capture.
- **`server/`** — a Node MCP server exposing those commands as tools:
  `tabs_context`, `new_tab`, `close_tab`, `navigate`, `screenshot`, `read_page`,
  `click`, `type`, `press_key`, `scroll`, `form_input`, `javascript`,
  `read_console`, `read_network`.

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

## How it works

- **Attach on demand.** The first command touching a tab runs
  `chrome.debugger.attach` and enables the `Runtime`, `Page`, `Network`, and
  `Log` CDP domains. Chrome shows an "is debugging this browser" banner while
  attached — that's inherent to the `debugger` API.
- **Trusted input.** Clicks and keys go through `Input.dispatchMouseEvent` /
  `Input.dispatchKeyEvent`, so they're indistinguishable from real user input
  (`isTrusted: true`), unlike synthetic DOM events.
- **Element refs.** `read_page` walks the DOM in-page, assigns each interactive
  element a `ref` id (kept in a `window.__dbgRefs` map), and returns a compact
  outline. `click` and `form_input` accept those refs; on click the element is
  scrolled into view and its center coordinates are resolved fresh, so refs
  survive layout changes until the page navigates.
- **Console & network.** CDP events (`Runtime.consoleAPICalled`,
  `Runtime.exceptionThrown`, `Log.entryAdded`, `Network.*`) are buffered per
  tab (capped at 2000 entries) and read back with optional regex filters.
- **Screenshots** use `Page.captureScreenshot` and come back to the MCP client
  as real image content blocks, so a multimodal model can see the page.

## Caveats

- Only one debugger can be attached per tab — close DevTools on a tab before
  driving it, and vice versa.
- `chrome.debugger` can't attach to `chrome://` pages or the Web Store.
- Don't trigger `alert()`/`confirm()`/`prompt()` from the `javascript` tool;
  modal dialogs block the renderer and stall the bridge.
- The WebSocket server binds to `127.0.0.1` only, but any local process could
  connect to it. For anything beyond personal use, add a shared-secret
  handshake between server and extension.
