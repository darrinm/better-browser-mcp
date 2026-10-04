#!/usr/bin/env node
// Dev harness for the Chrome Debug Bridge: hosts the extension WebSocket on
// 9333 and an HTTP control endpoint on 9334, so the bridge can be driven from
// the shell with curl:
//
//   node cli.js &
//   curl -s localhost:9334/status
//   curl -s localhost:9334 -d '{"method":"tabs.context","params":{}}'

import http from "node:http";
import { WebSocketServer } from "ws";

const WS_PORT = Number(process.env.BRIDGE_PORT || 9333);
const HTTP_PORT = Number(process.env.CONTROL_PORT || 9334);
const REQUEST_TIMEOUT_MS = 30000;

let socket = null;
let nextId = 1;
const pending = new Map();

const wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });
wss.on("connection", (s) => {
  socket = s;
  console.log("extension connected");
  s.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id === undefined) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg.error ? { error: msg.error.message } : { result: msg.result });
  });
  s.on("close", () => { if (socket === s) { socket = null; console.log("extension disconnected"); } });
});

function call(method, params) {
  if (!socket || socket.readyState !== 1) {
    return Promise.resolve({ error: "extension not connected" });
  }
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: `timeout waiting for ${method}` });
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    socket.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

http.createServer((req, res) => {
  if (req.method === "GET") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ connected: !!(socket && socket.readyState === 1) }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let cmd;
    try { cmd = JSON.parse(body); } catch { res.statusCode = 400; res.end('{"error":"bad json"}'); return; }
    const out = await call(cmd.method, cmd.params);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
}).listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`control on http://127.0.0.1:${HTTP_PORT}, extension bridge on ws://127.0.0.1:${WS_PORT}`);
});
