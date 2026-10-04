#!/usr/bin/env node
// Register the native messaging host with every Chromium-based browser found
// for this user (macOS and Linux). The MCP server also does this on every
// start, so running it by hand is only needed to set up ahead of time.
//
//   node install-host.js                        install (or repair)
//   node install-host.js --uninstall            remove
//   node install-host.js --extension-id=<id>    also allow another extension ID

import { ensureHost, uninstallHost, extensionIds, launcher, SUPPORTED } from "./host-install.js";

if (!SUPPORTED) {
  console.error("Only macOS and Linux are supported so far (Windows registers hosts in the registry).");
  process.exit(1);
}

if (process.argv.includes("--uninstall")) {
  const changes = uninstallHost();
  for (const c of changes) console.log(c);
  if (!changes.length) console.log("Nothing to remove.");
} else {
  const extra = process.argv.filter((a) => a.startsWith("--extension-id=")).map((a) => a.split("=")[1]);
  const changes = ensureHost({ extraIds: extra });
  for (const c of changes) console.log(c);
  if (!changes.length) console.log("Already installed and up to date.");
  console.log(`launcher:      ${launcher}`);
  console.log(`extension IDs: ${extensionIds(extra).join(", ")}`);
}
