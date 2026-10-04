#!/usr/bin/env node
// Dev harness for the Browser Driver MCP: connects to the browser's native
// host like the MCP server does, and serves an HTTP control endpoint on 9334
// so extension methods can be called with curl:
//
//   node cli.js &
//   curl -s localhost:9334/status
//   curl -s localhost:9334 -d '{"method":"group.context","params":{"createIfEmpty":true}}'

import http from "node:http";
import { Bridge } from "./bridge.js";

const HTTP_PORT = Number(process.env.CONTROL_PORT || 9334);
const bridge = new Bridge();

http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  // Browsers attach an Origin header to cross-site requests; curl doesn't.
  // Refuse anything that came from a web page.
  if (req.headers.origin) {
    res.statusCode = 403;
    res.end('{"error":"requests from web pages are not allowed"}');
    return;
  }
  if (req.method === "GET") {
    res.end(JSON.stringify({ connected: bridge.entries().length > 0, browsers: bridge.list() }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let cmd;
    try {
      cmd = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end('{"error":"bad json"}');
      return;
    }
    try {
      res.end(JSON.stringify({ result: await bridge.call(cmd.method, cmd.params || {}) }));
    } catch (err) {
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}).listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`control on http://127.0.0.1:${HTTP_PORT}; browsers via native hosts in ${bridge.dir}`);
});
