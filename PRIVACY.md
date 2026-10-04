# Privacy Policy — Browser Driver MCP

_Last updated: October 4, 2026_

Browser Driver MCP is a Chrome extension plus a local helper program (the
"native host" and MCP server, distributed as the `browser-driver-mcp` npm
package). Together they let an AI agent that **you** run on your own computer
(for example Claude Code) read and operate web pages in your browser.

## What the extension accesses

When — and only when — your locally running MCP client asks it to, the
extension reads the content of pages in its "MCP" tab group (page text,
element structure, form field values, screenshots, console messages and
network request URLs) and performs actions there (clicking, typing,
navigating, running JavaScript). Password fields, hidden inputs and payment or
one-time-code fields are redacted from page outlines.

## Where that data goes

- The extension sends this data **only** to the native host on your own
  computer, through Chrome's native messaging. The native host passes it to
  the MCP client programs you have configured on the same computer.
- The extension and native host make **no network requests of their own**,
  contain no analytics or telemetry, and have no server. The developer never
  receives any of your data.
- What your MCP client does with page data is governed by that client and the
  AI service it uses (for example, Claude Code sends tool results to
  Anthropic's API). Review those providers' privacy policies.

## What is stored

The extension stores, in the browser's local extension storage: a random
device identifier (used to tell browsers apart when several are connected),
the ID of its tab group, and which tabs you have stopped. Screenshots captured
for uploads or GIF recordings are kept in memory or in a temporary folder on
your computer and are not sent anywhere else. GIFs you export are saved to
your Downloads folder.

## Your control

- Automation only happens in the extension's "MCP" tab group.
- Every page being automated shows a blue glow and a **Stop automation**
  button; pressing it (or dismissing Chrome's "is debugging this browser"
  banner) immediately detaches the extension from that tab.
- Uninstalling the extension and running `browser-driver-mcp uninstall-host`
  removes everything.

## Sale and sharing

No data is sold, transferred to third parties, used for advertising, or used
for creditworthiness or lending purposes.

## Contact

Questions: open an issue at https://github.com/darrinm/browser-driver-mcp/issues.

Browser Driver MCP is an independent project and is not affiliated with
Google or Anthropic.
