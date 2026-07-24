import { createInterface } from "node:readline";

export class JsonRpcConnection {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.requestHandlers = new Set();

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => process.stderr.write(`[codex] ${chunk}`));
    child.on("exit", (code) => {
      const error = new Error(`Codex app-server exited with code ${code}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
    });
  }

  notify(method, params) {
    this.send(params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params });
  }

  respond(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
  }

  onRequest(handler) {
    this.requestHandlers.add(handler);
  }

  async handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message || "JSON-RPC error"));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      for (const handler of this.requestHandlers) {
        Promise.resolve(handler(message)).catch((error) => {
          this.respondError(message.id, -32603, error.message || String(error));
        });
      }
      return;
    }

    if (message.method) {
      for (const handler of this.notificationHandlers) {
        Promise.resolve(handler(message)).catch((error) => {
          console.error("[agent] notification handler failed:", error);
        });
      }
    }
  }
}
