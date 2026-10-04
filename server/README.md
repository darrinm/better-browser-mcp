# browser-driver-mcp

MCP server for your real, signed-in browser. It gives an AI agent (Claude
Code, or any MCP client) the same tools as Claude in Chrome — same names,
parameters and behavior — through the **Browser Driver MCP** Chrome extension
and a native messaging host. No ports are opened.

## Install

1. Install the **Browser Driver MCP** extension from the Chrome Web Store
   (or load `extension/` from the repo unpacked).
2. Install this package and register the native host with your browsers:

   ```sh
   npm install -g browser-driver-mcp
   browser-driver-mcp install-host
   ```

3. Add the MCP server to your client, e.g. Claude Code:

   ```sh
   claude mcp add browser-driver -- browser-driver-mcp
   ```

   Name it `claude-in-chrome` instead if you want full tool names
   (`mcp__claude-in-chrome__computer`, …) to match Claude in Chrome's, and turn
   off Claude Code's built-in Chrome integration so the two don't collide.

`browser-driver-mcp uninstall-host` removes the host registration. macOS and
Linux are supported.

Full documentation: https://github.com/darrinm/browser-driver-mcp

## License

MIT
