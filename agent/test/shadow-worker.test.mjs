import assert from "node:assert/strict";
import test from "node:test";
import { ShadowWorker } from "../src/shadow-worker.mjs";

function notFound() {
  const error = new Error("Task not found");
  error.status = 404;
  error.code = "task_not_found";
  return error;
}

function fakeDelta(cursor) {
  return {
    protocol: "action-parity/sync@0.1",
    type: "sync.delta",
    payload: { previous_cursor: "uur1.0", cursor, events: [] },
  };
}

test("commands ShadowCore cannot run are answered, not left in the queue", async () => {
  const acknowledged = [];
  const events = [];
  const relay = {
    async getShadowCursor() { return undefined; },
    async importShadowDelta(_taskId, delta) {
      return { imported: 0, cursor: delta.payload.cursor, hasMore: false };
    },
    async getCommands() {
      return acknowledged.length
        ? []
        : [
          { id: "cmd-1", taskId: "uu-rescue:pc-1:task-1", type: "user_message", payload: { text: "改用 OAuth2" } },
          { id: "cmd-2", taskId: "other-task", type: "user_message", payload: { text: "别的任务" } },
        ];
    },
    async acknowledge(id) { acknowledged.push(id); },
    async addEvent(taskId, event) { events.push({ taskId, ...event }); },
  };

  const worker = new ShadowWorker({
    relay,
    bridge: { async events() { return fakeDelta("uur1.1"); } },
    relayTaskId: "uu-rescue:pc-1:task-1",
    onNotice: () => {},
    onError: (error) => assert.fail(`unexpected error: ${error.message}`),
  });

  await worker.runOnce();

  assert.deepEqual(acknowledged, ["cmd-1"], "only this task's command is answered");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "command.unsupported");
  assert.equal(events[0].data.text, "改用 OAuth2", "the phone must see what was dropped");
});

test("the machine heartbeat repeats instead of freezing at startup", async () => {
  let beats = 0;
  const relay = {
    async getShadowCursor() { return undefined; },
    async importShadowDelta(_taskId, delta) {
      return { imported: 0, cursor: delta.payload.cursor, hasMore: false };
    },
    async getCommands() { return []; },
  };
  const worker = new ShadowWorker({
    relay,
    bridge: { async events() { return fakeDelta("uur1.1"); } },
    relayTaskId: "uu-rescue:pc-1:task-1",
    heartbeat: async () => { beats += 1; },
    heartbeatIntervalMs: 0,
    onNotice: () => {},
  });

  await worker.runOnce();
  await worker.runOnce();
  assert.equal(beats, 2, "each cycle past the interval must refresh the stamp");
});

test("a failing heartbeat does not stop the task sync", async () => {
  let imported = 0;
  const worker = new ShadowWorker({
    relay: {
      async getShadowCursor() { return undefined; },
      async importShadowDelta(_taskId, delta) {
        imported += 1;
        return { imported: 0, cursor: delta.payload.cursor, hasMore: false };
      },
      async getCommands() { return []; },
    },
    bridge: { async events() { return fakeDelta("uur1.1"); } },
    relayTaskId: "uu-rescue:pc-1:task-1",
    heartbeat: async () => { throw new Error("relay unreachable"); },
    heartbeatIntervalMs: 0,
    onNotice: () => {},
    onError: () => {},
  });

  await worker.runOnce();
  assert.ok(imported > 0, "syncing must continue even when the heartbeat fails");
});

test("a relay that forgot the task triggers re-registration, not an endless loop", async () => {
  const calls = [];
  let taskKnown = false;

  const relay = {
    async getShadowCursor() {
      calls.push("cursor");
      if (!taskKnown) throw notFound();
      return undefined;
    },
    async importShadowDelta(_taskId, delta) {
      calls.push("import");
      return { imported: 0, cursor: delta.payload.cursor, hasMore: false };
    },
    async getCommands() {
      return [];
    },
  };
  const bridge = {
    async events() {
      return fakeDelta("uur1.3");
    },
  };

  const worker = new ShadowWorker({
    relay,
    bridge,
    relayTaskId: "uu-rescue:pc-1:task-1",
    register: async () => {
      calls.push("register");
      taskKnown = true;
    },
    onNotice: () => {},
    onError: (error) => assert.fail(`unexpected error: ${error.message}`),
  });

  await worker.runOnce();

  assert.equal(calls[0], "cursor");
  assert.equal(calls[1], "register", "the worker must re-register after a 404");
  assert.ok(calls.includes("import"), "syncing must resume after re-registration");
});

test("errors other than an unknown task are not swallowed by re-registration", async () => {
  let registered = false;
  const relay = {
    async getShadowCursor() {
      const error = new Error("relay is down");
      error.status = 500;
      throw error;
    },
    async getCommands() {
      return [];
    },
  };

  const worker = new ShadowWorker({
    relay,
    bridge: { async events() { return fakeDelta("uur1.1"); } },
    relayTaskId: "uu-rescue:pc-1:task-1",
    register: async () => { registered = true; },
    onNotice: () => {},
  });

  await assert.rejects(() => worker.runOnce(), /relay is down/);
  assert.equal(registered, false, "a 500 must not be mistaken for a lost task");
});
