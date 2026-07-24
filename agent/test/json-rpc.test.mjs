import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { JsonRpcConnection } from "../src/json-rpc.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test("matches JSON-RPC responses to requests", async () => {
  const child = fakeChild();
  const rpc = new JsonRpcConnection(child);
  const sent = [];
  child.stdin.on("data", (chunk) => sent.push(JSON.parse(chunk.toString())));

  const pending = rpc.request("initialize", { capabilities: null });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, result: { ok: true } })}\n`);

  assert.deepEqual(await pending, { ok: true });
});

test("delivers server requests and writes native decisions", async () => {
  const child = fakeChild();
  const rpc = new JsonRpcConnection(child);
  const written = [];
  child.stdin.on("data", (chunk) => written.push(JSON.parse(chunk.toString())));
  rpc.onRequest((message) => rpc.respond(message.id, { decision: "accept" }));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 91,
    method: "item/commandExecution/requestApproval",
    params: { command: "npm test" },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(written[0], {
    jsonrpc: "2.0",
    id: 91,
    result: { decision: "accept" },
  });
});
