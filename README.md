# Chrome Debug Bridge

Drive your own Chrome browser from an AI agent (or any MCP client) with the
same tools as Claude in Chrome — same names, same parameters, same behavior —
so prompts and skills written for Claude in Chrome work unchanged.

```
Claude Code ──MCP/stdio── server/index.js ──Unix socket── native host ──native messaging── extension ──CDP── your tabs
```

Three pieces:

- **`extension/`** — a Manifest V3 extension. Its service worker executes
  commands against tabs using the Chrome DevTools Protocol (`chrome.debugger`)
  and `chrome.scripting`.
- **`server/native-host.js`** — a native messaging host. The browser launches
  it when the extension connects, and only this extension may launch it. It
  exposes the extension on a Unix socket in `~/.chrome-debug-bridge/`.
- **`server/index.js`** — the MCP server exposing the tools. It finds each
  connected browser's host socket and relays tool calls to it.

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

### 2. Register the native host

```sh
npm run install-host      # in server/
```

This registers the host with every Chromium-based browser it finds (Chrome,
Chromium, Brave, Edge, Vivaldi, Arc, and Chrome's beta/dev/canary channels) on
macOS or Linux, allowing only this extension to launch it. The allowed
extension ID is computed from the `extension/` folder's path, which is how
Chrome assigns IDs to unpacked extensions; pass `--extension-id=<id>` if yours
differs. `npm run uninstall-host` removes it.

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder

The extension connects to the host as soon as it loads. If the host isn't
registered, the toolbar icon shows a red **!** and its tooltip says why; the
extension keeps retrying, so register the host and reload.

### 4. Register with Claude Code

```sh
claude mcp add claude-in-chrome -- node /ABSOLUTE/PATH/TO/chrome-dbg-ext/server/index.js
```

Naming the server `claude-in-chrome` makes the full tool names
(`mcp__claude-in-chrome__computer`, …) identical to Claude in Chrome's too, so
even skills that refer to tools by full name work. Turn off Claude Code's
built-in Chrome integration first (`/chrome`) so the two don't collide — or
pick any other name if you only need the short names to match.

Any other MCP client works the same way — point it at `node server/index.js`
over stdio. Several MCP servers (say, several Claude sessions) can use the
same browser at once; the host routes each response back to its caller.

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
- **No network listener.** The extension talks only to its native host, which
  only it can launch (the host manifest's `allowed_origins`). The host listens
  on a Unix socket inside `~/.chrome-debug-bridge/` (mode 0700, socket 0600),
  so web pages can't reach it, other users can't, and there's no TCP port for
  another program to squat on.

## How it works

- **Transport.** The browser launches `native-host.js` on
  `chrome.runtime.connectNative` and exchanges length-prefixed JSON with it
  over stdio. The host listens on `~/.chrome-debug-bridge/<pid>.sock`; MCP
  servers watch that directory and connect to every socket in it, one per
  connected browser. The host rewrites request ids so several clients can
  share it, and replays the extension's `hello` (device ID, browser name) to
  each client. Chrome caps host→extension messages at 1 MB, so the host splits
  larger ones (GIF frames, say) into chunks the extension reassembles. The host
  exits and removes its socket when the browser closes the port; clients
  remove sockets left behind by a host that crashed.

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

`server/cli.js` is a dev harness: it connects to the host like the MCP server
does and serves an HTTP control endpoint on `127.0.0.1:9334`, so you can call
extension methods with curl. It refuses requests that carry an `Origin`
header, so web pages can't use it. `extension.reload` reloads the unpacked
extension from disk:

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
- Any program running as your user can connect to the host's socket — the
  same trust boundary as the rest of your user account (and as Claude in
  Chrome's own native host).
- Native host registration is automated for macOS and Linux only; Windows
  registers hosts in the registry.
