import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { ShadowWorker } from "../src/shadow-worker.mjs";
import { UuRescueBridge } from "../src/uurescue-bridge.mjs";

test("UURescue bridge passes action input and command envelopes through private temp files", async () => {
  const observed = [];
  const runner = async (_executable, args) => {
    const command = args.find((value) => ["sync-challenge", "sync-command"].includes(value));
    const fileFlag = command === "sync-challenge" ? "--input-file" : "--file";
    const file = args[args.indexOf(fileFlag) + 1];
    observed.push({ command, file, value: JSON.parse(readFileSync(file, "utf8")) });
    if (command === "sync-challenge") {
      return {
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          ok: true,
          challenge: {
            challenge_id: "owner-challenge",
            action_id: "checkpoint.create",
          },
        })}\n`,
      };
    }
    return {
      code: 1,
      stderr: "",
      stdout: `${JSON.stringify({
        ok: false,
        error: "state_conflict",
        response: {
          protocol: "action-parity/sync@0.1",
          type: "sync.conflict",
          payload: { action_id: "checkpoint.create" },
        },
      })}\n`,
    };
  };
  const bridge = new UuRescueBridge({
    cwd: process.cwd(),
    taskId: "owner-task",
    cliPath: "C:\\tools\\uu-rescue.js",
    runner,
  });
  const actor = { id: "ios-1", kind: "device", surface: "ios" };
  const challenge = await bridge.handle({
    type: "shadow_challenge",
    payload: {
      owner_task_id: "owner-task",
      action_id: "checkpoint.create",
      actor,
      confirmation_mode: "biometric",
      input: { reason: "保存接班点" },
    },
  });
  const envelope = {
    protocol: "action-parity/sync@0.1",
    type: "sync.command",
    payload: { action_id: "checkpoint.create" },
  };
  const result = await bridge.handle({
    type: "shadow_execute",
    payload: { owner_task_id: "owner-task", envelope },
  });

  assert.equal(challenge.ok, true);
  assert.equal(result.error, "state_conflict");
  assert.deepEqual(observed[0].value, { reason: "保存接班点" });
  assert.deepEqual(observed[1].value, envelope);
  assert.ok(observed.every((entry) => !existsSync(entry.file)));
});

test("Shadow worker imports owner deltas and reports only its reliable commands", async () => {
  const calls = [];
  let eventPoll = 0;
  const bridge = {
    async events(after) {
      calls.push(["events", after]);
      eventPoll += 1;
      return {
        protocol: "action-parity/sync@0.1",
        type: "sync.delta",
        payload: {
          previous_cursor: after ?? "owner-zero",
          cursor: `owner-${eventPoll}`,
          has_more: false,
          events: [],
        },
      };
    },
    async handle(command) {
      calls.push(["handle", command.id]);
      return { ok: true, challenge: { challenge_id: "challenge-1" } };
    },
  };
  const relay = {
    async getShadowCursor(taskId) {
      calls.push(["cursor", taskId]);
      return undefined;
    },
    async importShadowDelta(taskId, delta) {
      calls.push(["import", taskId, delta.payload.cursor]);
      return {
        imported: 0,
        cursor: delta.payload.cursor,
        hasMore: delta.payload.has_more,
      };
    },
    async getCommands() {
      return [
        { id: "shadow-1", taskId: "relay-task", type: "shadow_challenge" },
        { id: "codex-1", taskId: "relay-task", type: "user_message" },
        { id: "other-1", taskId: "other-task", type: "shadow_execute" },
      ];
    },
    async reportCommandResult(id, result) {
      calls.push(["result", id, result.ok]);
    },
    async acknowledge(id) {
      calls.push(["ack", id]);
    },
    async addEvent(taskId, event) {
      calls.push(["event", taskId, event.type]);
    },
  };
  const worker = new ShadowWorker({
    relay,
    bridge,
    relayTaskId: "relay-task",
    onNotice: () => {},
    onError: (error) => assert.fail(error),
  });

  await worker.runOnce();

  assert.ok(calls.some((call) => call[0] === "handle" && call[1] === "shadow-1"));
  assert.ok(calls.some((call) => call[0] === "result" && call[1] === "shadow-1"));

  // The relay rejects an owner result for a non-ShadowCore command, so this one
  // is acknowledged and reported on the task stream instead.
  assert.equal(calls.some((call) => call[0] === "result" && call[1] === "codex-1"), false);
  assert.ok(calls.some((call) => call[0] === "ack" && call[1] === "codex-1"));
  assert.ok(calls.some((call) => call[0] === "event" && call[2] === "command.unsupported"));

  // Another task's command still belongs to another worker.
  assert.equal(calls.some((call) => call[1] === "other-1"), false);
  assert.equal(calls.filter((call) => call[0] === "import").length, 2);
});
