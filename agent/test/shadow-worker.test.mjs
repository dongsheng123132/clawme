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
