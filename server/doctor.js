// `browser-driver-mcp doctor`: check every link in the chain and say how to
// fix whatever is broken. Also provides diagnose(), the quick (file-only)
// subset used to explain "no browser is connected" errors.

import fs from "node:fs";
import { browserDirs, manifestPathFor, launcher, hostDir, extensionIds, findExtensionInstalls, SUPPORTED } from "./host-install.js";
import { socketDir, PROTOCOL, VERSION, HOST_NAME } from "./transport.js";

const STORE_URL = "https://chromewebstore.google.com/detail/epkpbfomlhcfccjlmjnihbllpdhaacaj";

// Checks that only read files. Returns [{ ok, label, fix? }].
export function fileChecks() {
  const results = [];
  const add = (ok, label, fix) => results.push({ ok, label, fix });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 18, `Node.js ${process.versions.node}`, "Install Node.js 18 or newer.");
  if (!SUPPORTED) {
    add(false, `Platform ${process.platform}`, "Only macOS and Linux are supported so far.");
    return results;
  }

  const browsers = browserDirs();
  add(browsers.length > 0, browsers.length ? `Browsers found: ${browsers.map((b) => b.name).join(", ")}` : "No Chromium-based browser found",
    "Install Google Chrome (or another Chromium-based browser).");

  let launcherOk = false;
  try {
    const script = fs.readFileSync(launcher, "utf8");
    const node = /exec "([^"]+)"/.exec(script)?.[1];
    launcherOk = !!node && fs.existsSync(node) && fs.existsSync(`${hostDir}/native-host.js`);
    add(launcherOk, launcherOk ? `Native host installed (${launcher})` : `Native host launcher is broken (${launcher})`,
      "Run `browser-driver-mcp install-host` (or just start the MCP server once).");
  } catch {
    add(false, "Native host not installed", "Start your MCP client once (the server installs the host), or run `browser-driver-mcp install-host`.");
  }

  const ids = extensionIds();
  for (const { name, dir } of browsers) {
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPathFor(dir), "utf8"));
    } catch {}
    const ok = manifest && manifest.path === launcher && ids.every((id) => manifest.allowed_origins?.includes(`chrome-extension://${id}/`));
    add(!!ok, ok ? `Registered with ${name}` : `Not registered with ${name}`,
      "Run `browser-driver-mcp install-host` (or start the MCP server once).");
  }

  const installs = findExtensionInstalls();
  if (installs.length) {
    for (const i of installs) {
      add(i.enabled, `Extension installed in ${i.browser} (${i.profile})${i.enabled ? "" : " but disabled"}`,
        "Enable Browser Driver MCP in chrome://extensions.");
    }
  } else {
    add(false, "Extension not found in any browser profile", `Install Browser Driver MCP: ${STORE_URL}`);
  }
  return results;
}

// A one-paragraph explanation of why no browser is connected, for errors.
export function diagnose() {
  try {
    const failing = fileChecks().filter((r) => !r.ok);
    if (!failing.length) {
      return "The extension and host look installed: make sure the browser is running (the extension starts the host when it loads), or reload the extension in chrome://extensions.";
    }
    return failing.map((r) => `${r.label}: ${r.fix}`).join(" ");
  } catch (err) {
    return `Run \`browser-driver-mcp doctor\` for details (${err.message}).`;
  }
}

export async function runDoctor() {
  console.log(`browser-driver-mcp ${VERSION} (protocol ${PROTOCOL}, host ${HOST_NAME})\n`);
  const results = fileChecks();

  // Live check: connect like the MCP server does and see who answers.
  const { Bridge } = await import("./bridge.js");
  const bridge = new Bridge();
  await bridge.ready(4000);
  const browsers = bridge.list();
  if (!browsers.length) {
    results.push({ ok: false, label: `No browser connected (sockets in ${socketDir()})`,
      fix: "Open the browser with the extension enabled; if it shows a red \"!\" on its toolbar icon, click it for details." });
  }
  for (const b of browsers) {
    const ok = b.protocol === PROTOCOL;
    results.push({ ok, label: `Connected: ${b.name} on ${b.platform} — extension ${b.version}, protocol ${b.protocol ?? "?"}`,
      fix: (b.protocol ?? 0) < PROTOCOL ? "Update the extension." : "Update browser-driver-mcp (npm install -g browser-driver-mcp@latest)." });
  }

  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.label}`);
    if (!r.ok && r.fix) console.log(`    → ${r.fix}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} problem${failed === 1 ? "" : "s"} found.` : "\nEverything looks good.");
  return failed ? 1 : 0;
}
