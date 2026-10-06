# Chrome Web Store submission — Browser Driver MCP

Everything to paste into the Developer Dashboard. Upload the zip from
`node scripts/package-extension.mjs --first-upload` for the **first** upload
only (it contains `key.pem`, which keeps the extension ID
`epkpbfomlhcfccjlmjnihbllpdhaacaj`); later updates use the zip built without
the flag.

## Store listing tab

**Name** (from manifest): Browser Driver MCP

**Summary** (from manifest, 111 chars): Lets your local AI agent drive this
browser over MCP, with Claude in Chrome-compatible tools and a Stop button.

**Category:** Developer Tools

**Language:** English

**Description:**

```
Browser Driver MCP connects your real, signed-in browser to an AI agent running on your own computer — Claude Code, Cursor, or any Model Context Protocol (MCP) client — so it can read pages and get things done in your actual tabs.

It offers the same tools as Claude in Chrome, with the same names, parameters and behavior, so prompts and skills written for Claude in Chrome work unchanged: screenshots, clicking, typing, keyboard shortcuts, scrolling, drag and drop, reading the page as an accessibility outline, finding elements by description, filling forms, uploading files, running JavaScript, and reading console and network activity. It can also record annotated GIFs of what it does.

YOU STAY IN CONTROL
• The agent only works in a dedicated "MCP" tab group — your other tabs are never touched.
• Every page it drives glows electric blue and shows a Stop button. One click detaches it immediately.
• A blue agent cursor moves to each spot before the agent clicks, hovers, drags or scrolls there, so you can follow what it does.
• Password, payment and one-time-code fields are redacted from what the agent reads.

PRIVATE AND LOCAL
• No servers, no accounts, no analytics. The extension talks only to a small helper program on your own computer, through Chrome's native messaging.
• It opens no network ports, so web pages and other computers can't reach it.

WORKS WHERE OTHERS DON'T
• Reads inside shadow DOM (including closed shadow roots) and cross-origin iframes.
• Handles alert/confirm dialogs so automation never gets stuck.

SETUP
After installing, a setup page shows live status and the one line to add to your MCP client, e.g. for Claude Code:
  claude mcp add browser-driver -- npx -y browser-driver-mcp
The server sets up its connector to this extension automatically the first time it runs (requires Node.js 18+). Full instructions: https://github.com/darrinm/browser-driver-mcp

Open source (MIT). Independent project; not affiliated with Google or Anthropic.
```

**Graphic assets** (in `store/images/`):
- Store icon: `extension/icons/icon128.png`
- Screenshots (1280x800): `screenshot-1-control.png`, `screenshot-2-tools.png`, `screenshot-3-private.png`
- Small promo tile (440x280): `promo-small.png`
- Marquee promo tile (1400x560, optional): `promo-marquee.png`

**Official URL / Homepage:** https://github.com/darrinm/browser-driver-mcp

**Support URL:** https://github.com/darrinm/browser-driver-mcp/issues

## Privacy practices tab

**Single purpose description:**

```
Lets an AI agent that the user runs locally (an MCP client such as Claude Code) read and operate web pages in a dedicated tab group of the user's browser, relayed through a native messaging host on the same computer.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `debugger` | Core function. The agent's clicks, typing and key presses are delivered with the Chrome DevTools Protocol (Input domain) so pages receive real user input; screenshots, JavaScript evaluation, console/network reading, dialog handling and file uploads also use it. It is attached only to tabs in the extension's own tab group, and the user can detach it at any time with the on-page Stop button or Chrome's debugging banner. |
| `nativeMessaging` | The extension's only communication channel: it exchanges commands and results with its companion native host on the user's computer, which relays requests from the user's local MCP client. |
| `scripting` | Reads the page structure (including shadow DOM and iframes) to build the element outline and find elements, sets form values, and shows the on-page glow and Stop button. |
| `tabs` | Lists, creates, closes and navigates the tabs the agent works in, and reports their titles and URLs to the agent. |
| `tabGroups` | Keeps the agent's tabs in a dedicated, labeled "MCP" tab group, which is the boundary for what it may automate. |
| `webNavigation` | Enumerates a tab's frames so cross-origin iframes can be read and clicked accurately. |
| `storage` | Stores a random device ID (to distinguish connected browsers), the tab group ID, and which tabs the user has stopped. |
| `alarms` | Periodically re-establishes the native messaging connection if it drops. |
| `offscreen` | Keeps the service worker alive while an agent session is active, so the connection isn't torn down mid-task. |
| `downloads` | Saves an animated GIF recording to the user's Downloads folder when the agent exports one at the user's request. |
| `notifications` | When several browsers are connected, shows a "Connect" notification so the user can choose which browser the agent uses. |
| Host permission `<all_urls>` | The agent works on whatever sites the user directs it to, so the extension must be able to read and operate pages on any site — but only in tabs inside its own tab group. |

**Remote code:** No, I am not using remote code. (All JavaScript is packaged in the extension; no code is fetched or evaluated from remote sources. The `javascript_tool` evaluates code supplied by the user's own local MCP client in the page, as a user-directed automation feature.)

**Data usage — collected data types** (check these; data is handled only locally and sent only to the user's own MCP client, never to the developer):
- Website content (page text, structure, screenshots)
- Web history (URLs of pages in the agent's tab group)
- User activity (the agent's clicks and keystrokes it performs)

Leave unchecked: personally identifiable information, health, financial and payment, authentication information (credential fields are redacted), personal communications, location.

**Certifications:** check all three —
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/darrinm/browser-driver-mcp/blob/main/PRIVACY.md

## Distribution tab

**Visibility:** Public (or Unlisted while testing). **Regions:** All.

## Review notes (Test instructions field)

```
This extension works with its companion MCP server, which installs the native messaging host automatically on first run:
  claude mcp add browser-driver -- npx -y browser-driver-mcp   (Claude Code; any MCP client works)
Then ask the agent to open a page and take a screenshot. On install the extension opens a setup page with live connection status; without the server it shows a red "!" on its icon, and clicking the icon reopens the setup page.
The debugger permission is the core automation mechanism (CDP Input/Page/Runtime domains) and is only attached to tabs in the extension's "MCP" tab group; an on-page Stop button detaches it.
```
