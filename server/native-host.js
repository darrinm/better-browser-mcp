#!/usr/bin/env node
// Native messaging host for the Better Browser MCP extension.
//
// The browser starts this process when the extension calls
// chrome.runtime.connectNative, and only the extension IDs listed in the host
// manifest may do so (see install-host.js). It speaks native messaging on
// stdin/stdout (4-byte little-endian length + JSON) and exposes the
// extension to local clients on a Unix socket:
//
//   MCP server(s) ──Unix socket──▶ this host ──native messaging──▶ extension
//
// Several clients (e.g. several Claude sessions) can share one browser: the
// host rewrites request ids and routes each response back to its client.
// The process exits when the browser closes the native messaging port.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { ensureSocketDir, onLines, writeLine } from "./transport.js";

// Chrome rejects host→extension messages over 1 MB, so larger ones are sent
// in pieces the extension reassembles. Chunks are counted in characters;
// JSON from the bridge is almost entirely ASCII, and 256K characters stays
// under the limit even at 3 bytes per character.
const CHUNK_CHARS = 256 * 1024;

const log = (...args) => process.stderr.write(`[native-host ${process.pid}] ${args.join(" ")}\n`);

// --- native messaging framing (stdin/stdout) --------------------------------

function toExtension(obj) {
  const json = JSON.stringify(obj);
  if (json.length <= CHUNK_CHARS) return writeFrame(json);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const count = Math.ceil(json.length / CHUNK_CHARS);
  for (let index = 0; index < count; index++) {
    writeFrame(JSON.stringify({ chunk: { id, index, count, data: json.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS) } }));
  }
}

function writeFrame(json) {
  const body = Buffer.from(json, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let inbuf = Buffer.alloc(0);
process.stdin.on("data", (data) => {
  inbuf = Buffer.concat([inbuf, data]);
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) break;
    const json = inbuf.subarray(4, 4 + len).toString("utf8");
    inbuf = inbuf.subarray(4 + len);
    try {
      fromExtension(JSON.parse(json));
    } catch (err) {
      log("bad message from extension:", err.message);
    }
  }
});
process.stdin.on("end", shutdown); // the browser closed the port
process.stdout.on("error", shutdown); // EPIPE: the browser went away mid-write

// --- routing ------------------------------------------------------------------

const clients = new Set();
const pending = new Map(); // host-side id -> { client, id }
let nextId = 1;
let hello = null; // the extension's identity, replayed to clients that connect later

function fromExtension(msg) {
  if (msg.event) {
    if (msg.event === "hello") hello = msg;
    for (const c of clients) writeLine(c, msg);
    return;
  }
  if (msg.id === undefined) return; // keepalive pings
  const route = pending.get(msg.id);
  if (!route) return;
  pending.delete(msg.id);
  writeLine(route.client, { ...msg, id: route.id });
}

const dir = ensureSocketDir();
const socketPath = path.join(dir, `${process.pid}.sock`);

const server = net.createServer((client) => {
  clients.add(client);
  if (hello) writeLine(client, hello);
  onLines(client, (msg) => {
    if (msg.id === undefined || !msg.method) return;
    const id = nextId++;
    pending.set(id, { client, id: msg.id });
    toExtension({ id, method: msg.method, params: msg.params || {} });
  });
  client.on("error", () => {});
  client.on("close", () => {
    clients.delete(client);
    for (const [id, route] of pending) if (route.client === client) pending.delete(id);
  });
});

server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  log("listening on", socketPath);
  toExtension({ event: "ready", socket: socketPath });
});

function shutdown() {
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
