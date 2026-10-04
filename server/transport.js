// Shared transport details for the native host and its clients (the MCP
// server and the dev harness).
//
// The browser launches the native host (native-host.js) via native
// messaging. The host listens on a Unix socket in a directory only this user
// can open; MCP servers find hosts by scanning that directory, one socket per
// connected browser. Nothing listens on a TCP port, so web pages can't reach
// the bridge and nothing can squat a port to impersonate it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOST_NAME = "com.github.darrinm.chrome_debug_bridge";

export function socketDir() {
  return process.env.CHROME_DEBUG_BRIDGE_DIR || path.join(os.homedir(), ".chrome-debug-bridge");
}

// Create the socket directory with mode 0700 and refuse to use one owned by
// someone else, so other local users can't reach (or plant) sockets.
export function ensureSocketDir() {
  const dir = socketDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by another user; refusing to use it.`);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

// Newline-delimited JSON over a stream socket.
export function onLines(socket, handler) {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handler(msg);
    }
  });
}

export function writeLine(socket, obj) {
  if (!socket.destroyed) socket.write(JSON.stringify(obj) + "\n");
}
