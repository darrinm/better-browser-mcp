#!/usr/bin/env node
// Build the Chrome Web Store upload zip for the extension.
//
//   node scripts/package-extension.mjs                 -> dist/browser-driver-mcp-<version>.zip
//   node scripts/package-extension.mjs --first-upload  -> also includes key.pem
//
// The store rejects manifests with a "key" field, so it's stripped from the
// packaged copy. For the item's FIRST upload only, --first-upload puts the
// private key in the zip as key.pem; the store then derives the published
// extension's ID from it, so the store build and local unpacked builds share
// one ID (and one native host allow-list entry). Later uploads must not
// include it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "extension");
const firstUpload = process.argv.includes("--first-upload");
const keyFile = path.join(os.homedir(), ".config/browser-driver-mcp/extension-key.pem");

const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
const out = path.join(root, "dist", `browser-driver-mcp-${manifest.version}${firstUpload ? "-first-upload" : ""}.zip`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "bdmcp-pack-"));
try {
  fs.cpSync(extDir, stage, { recursive: true, filter: (src) => !path.basename(src).startsWith(".") });
  delete manifest.key;
  fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (firstUpload) {
    if (!fs.existsSync(keyFile)) throw new Error(`--first-upload needs the private key at ${keyFile}`);
    fs.copyFileSync(keyFile, path.join(stage, "key.pem"));
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  execFileSync("zip", ["-qr", "-X", out, "."], { cwd: stage });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

const listing = execFileSync("unzip", ["-Z1", out], { encoding: "utf8" }).trim().split("\n");
console.log(`${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${listing.length} files)`);
console.log(firstUpload
  ? "Includes key.pem: use this zip only for the item's FIRST upload."
  : "No key.pem: use this zip for updates (or a first upload with a store-assigned ID).");
