// SSE 流：同一条游标流，由 relay 主动推。
//
// 轮询版本下 45% 的流量花在 HTTP 头上而不是内容（bandwidth-benchmark.mjs 实测）。
// 这里要验证的不是"接口存在"，而是"事件产生之后确实被推过来了"，以及推过来的
// 东西跟轮询拿到的是同一种信封、同一套游标。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { installV3Routes } from "../dist/v3-routes.js";
import { V3Store } from "../dist/v3-store.js";

/** 把 SSE 字节流切成 {event, data} —— 帧以空行结束。 */
function createSseReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending = [];

  async function next(timeoutMs = 5000) {
    if (pending.length) return pending.shift();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), deadline - Date.now())),
      ]);
      if (chunk.timeout) break;
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (frame.startsWith(":")) continue; // 保活注释
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (data) pending.push({ event, data: JSON.parse(data) });
      }
      if (pending.length) return pending.shift();
    }
    return null;
  }

  return { next, cancel: () => reader.cancel().catch(() => {}) };
}

async function harness() {
  const previous = process.env.CLAWME_TOKENS;
  process.env.CLAWME_TOKENS = "stream-token";
  const dir = await mkdtemp(join(tmpdir(), "clawme-stream-"));
  const store = new V3Store(join(dir, "relay.json"));
  await store.load();
  store.upsertTask({
    id: "stream-task",
    machineId: "pc-1",
    provider: "codex",
    title: "Stream test",
    status: "running",
  });

  const app = express();
  app.use(express.json());
  installV3Routes(app, store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  return {
    store,
    base: `http://127.0.0.1:${server.address().port}`,
    headers: { "X-ClawMe-Token": "stream-token" },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await store.flush().catch(() => {});
      await rm(dir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.CLAWME_TOKENS;
      else process.env.CLAWME_TOKENS = previous;
    },
  };
}

test("连上就先补齐欠的，之后事件一产生就推过来", async () => {
  const h = await harness();
  let sse;
  try {
    const response = await fetch(`${h.base}/v3/sync/tasks/stream-task/stream`, {
      headers: h.headers,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    // 反向代理一缓冲就不叫推送了。
    assert.equal(response.headers.get("x-accel-buffering"), "no");

    sse = createSseReader(response.body);

    // 第一帧是基线快照，跟轮询首次拿到的是同一种信封。
    const first = await sse.next();
    assert.equal(first.event, "sync");
    assert.equal(first.data.protocol, "action-parity/sync@0.1");
    assert.equal(first.data.type, "sync.snapshot");
    assert.equal(first.data.payload.state.task.id, "stream-task");

    // 现在制造一个事件：不轮询，等它自己过来。
    h.store.addEvent("stream-task", {
      type: "task.progress",
      message: "推过来的，不是轮来的",
      status: "running",
    });

    const pushed = await sse.next();
    assert.equal(pushed.event, "sync");
    assert.equal(pushed.data.type, "sync.delta");
    const kinds = pushed.data.payload.events.map((e) => e.kind);
    assert.ok(kinds.includes("task.progress"));
    assert.equal(pushed.data.payload.events[0].payload.message, "推过来的，不是轮来的");

    // 游标要接得上：previous_cursor 必须等于上一帧交出的 cursor。
    assert.equal(pushed.data.payload.previous_cursor, first.data.payload.cursor);
  } finally {
    sse?.cancel();
    await h.close();
  }
});

test("带游标连接时只补游标之后的那一段", async () => {
  const h = await harness();
  let sse;
  try {
    const snapshot = h.store.syncTask("stream-task");
    h.store.addEvent("stream-task", { type: "task.progress", message: "断线期间发生的" });

    const response = await fetch(
      `${h.base}/v3/sync/tasks/stream-task/stream?after=${encodeURIComponent(snapshot.payload.cursor)}`,
      { headers: h.headers },
    );
    sse = createSseReader(response.body);

    // 断线重连不该重放全部历史，也不该漏掉断线期间的事件。
    const catchUp = await sse.next();
    assert.equal(catchUp.data.type, "sync.delta");
    assert.equal(catchUp.data.payload.events.length, 1);
    assert.equal(catchUp.data.payload.events[0].payload.message, "断线期间发生的");
  } finally {
    sse?.cancel();
    await h.close();
  }
});

test("流接口和轮询接口用同一把锁", async () => {
  const h = await harness();
  try {
    const anonymous = await fetch(`${h.base}/v3/sync/tasks/stream-task/stream`);
    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();

    const wrong = await fetch(`${h.base}/v3/sync/tasks/stream-task/stream`, {
      headers: { "X-ClawMe-Token": "not-the-token" },
    });
    assert.equal(wrong.status, 401);
    await wrong.body?.cancel();

    const missing = await fetch(`${h.base}/v3/sync/tasks/no-such-task/stream`, {
      headers: h.headers,
    });
    assert.equal(missing.status, 404);
    await missing.body?.cancel();
  } finally {
    await h.close();
  }
});

test("客户端断开后 relay 不再为它保留订阅", async () => {
  const h = await harness();
  try {
    const controller = new AbortController();
    const response = await fetch(`${h.base}/v3/sync/tasks/stream-task/stream`, {
      headers: h.headers,
      signal: controller.signal,
    });
    const sse = createSseReader(response.body);
    await sse.next();

    controller.abort();
    // 给 close 事件一点时间落地。
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 订阅泄漏会让 relay 越跑越慢，而且每个死连接都会被写一次。
    h.store.addEvent("stream-task", { type: "task.progress", message: "没人听了" });
    assert.doesNotThrow(() => h.store.addEvent("stream-task", { type: "task.progress" }));
  } finally {
    await h.close();
  }
});
