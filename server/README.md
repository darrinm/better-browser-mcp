# browser-driver-mcp

MCP server for your real, signed-in browser. It gives an AI agent (Claude
Code, or any MCP client) the same tools as Claude in Chrome — same names,
parameters and behavior — through the **Browser Driver MCP** Chrome extension
and a native messaging host. No ports are opened.

## Install

1. Install the **Browser Driver MCP** extension from the Chrome Web Store
   (or load `extension/` from the repo unpacked).
2. Add the MCP server to your client, e.g. Claude Code:

   ```sh
   claude mcp add browser-driver -- npx -y browser-driver-mcp
   ```

   On its first start the server installs and registers the native messaging
   host the extension talks to, and repairs it on every later start.

   Name it `claude-in-chrome` instead if you want full tool names
   (`mcp__claude-in-chrome__computer`, …) to match Claude in Chrome's, and turn
   off Claude Code's built-in Chrome integration so the two don't collide.

Commands: `browser-driver-mcp doctor` checks every step of the setup and says
how to fix problems; `install-host` / `uninstall-host` install or remove the
native host explicitly. macOS and Linux are supported.

Full documentation: https://github.com/darrinm/browser-driver-mcp

## License

MIT
