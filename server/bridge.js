// Client side of the bridge: finds native hosts (one per connected browser)
// by watching the socket directory, and routes calls to the selected browser.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { socketDir, ensureSocketDir, onLines, writeLine, PROTOCOL } from "./transport.js";

const REQUEST_TIMEOUT_MS = 60000;
const PROTOCOL_EXEMPT = new Set(["extension.reload"]);

export class Bridge {
  constructor({ diagnose = () => "" } = {}) {
    this.diagnose = diagnose;
    this.dir = ensureSocketDir();
    this.conns = new Map(); // socket path -> { socket, info }
    this.selected = null; // deviceId chosen with select_browser / switch_browser
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer, socket }
    this.pairings = new Map(); // requestId -> resolve(deviceId)
    this.scan();
    setInterval(() => this.scan(), 1000).unref();
    try {
      fs.watch(this.dir, () => this.scan()).unref();
    } catch {}
  }

  scan() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".sock")) continue;
      const file = path.join(this.dir, name);
      if (!this.conns.has(file)) this.open(file);
    }
  }

  open(file) {
    const socket = net.createConnection(file);
    const entry = { socket, info: null };
    this.conns.set(file, entry);
    onLines(socket, (msg) => this.onMessage(entry, msg));
    socket.on("error", (err) => {
      // Nothing listening: a host that died without cleaning up.
      if (err.code === "ECONNREFUSED") {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
    });
    socket.on("close", () => {
      this.conns.delete(file);
      for (const [id, p] of this.pending) {
        if (p.socket !== socket) continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error("The browser disconnected (it may have been closed or the extension reloaded)."));
      }
    });
  }

  onMessage(entry, msg) {
    if (msg.event === "hello") {
      entry.info = {
        deviceId: msg.deviceId,
        name: msg.name,
        platform: msg.platform,
        version: msg.version,
        protocol: msg.protocol, // undefined from extensions older than the check
      };
      return;
    }
    if (msg.event === "pairing.accepted") {
      const resolve = this.pairings.get(msg.requestId);
      if (resolve && entry.info) resolve(entry.info.deviceId);
      return;
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  // Connected browsers that have identified themselves.
  entries() {
    return [...this.conns.values()].filter((e) => e.info && !e.socket.destroyed);
  }

  list() {
    return this.entries().map((e) => e.info);
  }

  find(deviceId) {
    return this.entries().find((e) => e.info.deviceId === deviceId);
  }

  target(method) {
    const target = this.pick();
    const protocol = target.info.protocol ?? 0;
    // Reloading the extension is how a mismatch gets fixed during
    // development, so it's always allowed through.
    if (protocol !== PROTOCOL && !PROTOCOL_EXEMPT.has(method)) {
      throw new Error(
        `The ${target.info.name} extension (version ${target.info.version}) speaks protocol ${protocol}, but this ` +
        `server speaks protocol ${PROTOCOL}. ` +
        (protocol < PROTOCOL
          ? "Update the Browser Driver MCP extension (chrome://extensions → Update, or reinstall from the Chrome Web Store)."
          : "Update this server: npm install -g browser-driver-mcp@latest, or use npx -y browser-driver-mcp@latest.")
      );
    }
    return target;
  }

  pick() {
    const all = this.entries();
    if (this.selected) {
      const chosen = this.find(this.selected);
      if (chosen) return chosen;
    }
    if (all.length === 1) return all[0];
    if (!all.length) {
      // Explain what's missing rather than just saying "not connected".
      let why = "";
      try {
        why = " " + this.diagnose();
      } catch {}
      throw new Error(`No browser is connected.${why}`);
    }
    throw new Error(
      "Several browsers are connected and none is selected. Use list_connected_browsers, ask the user " +
      "which one to use, then call select_browser."
    );
  }

  sendTo(socket, method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for the browser to respond to ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, socket });
      writeLine(socket, { id, method, params });
    });
  }

  call(method, params = {}) {
    let target;
    try {
      target = this.target(method);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.sendTo(target.socket, method, params);
  }

  // Ask every connected browser to show a "Connect" prompt; resolve with the
  // deviceId of the one the user clicks, or null on timeout.
  async pair(timeoutMs) {
    const requestId = crypto.randomUUID();
    const sockets = this.entries().map((e) => e.socket);
    if (!sockets.length) throw new Error("No browser is connected.");
    const chosen = new Promise((resolve) => {
      this.pairings.set(requestId, resolve);
      setTimeout(() => resolve(null), timeoutMs);
    });
    await Promise.all(sockets.map((s) => this.sendTo(s, "pairing.request", { requestId }).catch(() => {})));
    const deviceId = await chosen;
    this.pairings.delete(requestId);
    await Promise.all(sockets.map((s) => this.sendTo(s, "pairing.cancel", { requestId }).catch(() => {})));
    return deviceId;
  }

  // Wait until at least one browser has connected (for startup in scripts).
  async ready(timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    while (!this.entries().length && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    return this.entries().length > 0;
  }
}

export { socketDir };
