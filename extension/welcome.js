// Setup/status page: live connection status plus per-client setup snippets.

const SERVER = { command: "npx", args: ["-y", "browser-driver-mcp"] };
const configJson = (name) => JSON.stringify({ mcpServers: { [name]: SERVER } }, null, 2);

const CLIENTS = [
  {
    id: "claude-code",
    label: "Claude Code",
    snippet: "claude mcp add browser-driver -- npx -y browser-driver-mcp",
    note: "Prefer tool names identical to Claude in Chrome's (mcp__claude-in-chrome__…)? Name it claude-in-chrome instead, and turn off Claude Code's built-in Chrome integration (/chrome).",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    snippet: configJson("browser-driver"),
    note: "Settings → Developer → Edit Config, merge this into claude_desktop_config.json, then restart Claude Desktop.",
  },
  {
    id: "cursor",
    label: "Cursor",
    snippet: configJson("browser-driver"),
    note: "Add to ~/.cursor/mcp.json (or Cursor Settings → MCP → Add new server).",
  },
  {
    id: "vscode",
    label: "VS Code",
    snippet: `code --add-mcp '${JSON.stringify({ name: "browser-driver", ...SERVER })}'`,
    note: "Or add the same entry under \"servers\" in .vscode/mcp.json.",
  },
  {
    id: "other",
    label: "Other",
    snippet: "npx -y browser-driver-mcp",
    note: "Any MCP client that runs local stdio servers: use this as the command.",
  },
];

const $ = (id) => document.getElementById(id);
let current = CLIENTS[0];

function renderTabs() {
  const tabs = $("tabs");
  tabs.textContent = "";
  for (const c of CLIENTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "tab";
    b.textContent = c.label;
    b.setAttribute("aria-selected", String(c === current));
    b.addEventListener("click", () => {
      current = c;
      renderTabs();
    });
    tabs.append(b);
  }
  $("snippet").textContent = current.snippet;
  $("snippet-note").textContent = current.note;
  $("copy").textContent = "Copy";
}

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(current.snippet);
    $("copy").textContent = "Copied";
  } catch {
    $("copy").textContent = "Select & copy";
  }
});

function setRow(prefix, state, title, detail) {
  const dot = $(`${prefix}-dot`);
  dot.className = `dot ${state}`;
  dot.textContent = state === "ok" ? "✓" : state === "bad" ? "!" : "…";
  $(`${prefix}-title`).textContent = title;
  $(`${prefix}-detail`).textContent = detail ? ` — ${detail}` : "";
}

async function refresh() {
  let s;
  try {
    s = await chrome.runtime.sendMessage({ type: "status" });
  } catch {
    return;
  }
  if (!s) return;
  $("ext-detail").textContent = ` — version ${s.extensionVersion}`;

  if (s.connected) {
    setRow("host", "ok", "Connector running", s.version ? `version ${s.version}` : "");
  } else if (/not found|forbidden/i.test(s.error || "")) {
    setRow("host", "wait", "Connector not installed yet",
      "add the server to your MCP client below and start a session; it installs the connector automatically");
  } else {
    setRow("host", "wait", "Connecting to the connector…", s.error || "");
  }

  if (s.connected && s.clients > 0) {
    setRow("client", "ok", `${s.clients} MCP client${s.clients === 1 ? "" : "s"} connected`, "");
  } else if (s.connected) {
    setRow("client", "wait", "Waiting for an MCP client", "start a session in your client — it connects as soon as the server starts");
  } else {
    setRow("client", "wait", "MCP client", "not connected yet");
  }
  $("done").hidden = !(s.connected && s.clients > 0);
}

renderTabs();
refresh();
setInterval(refresh, 1000);
