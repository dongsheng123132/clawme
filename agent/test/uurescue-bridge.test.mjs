import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { ShadowWorker } from "../src/shadow-worker.mjs";
import { UuRescueBridge } from "../src/uurescue-bridge.mjs";

const ACTOR = { id: "ios-1", kind: "device", surface: "ios" };

const EXECUTE_ENVELOPE = {
  protocol: "action-parity/sync@0.1",
  type: "sync.command",
  stream_id: "uu-rescue:task:owner-task",
  payload: {
    action_id: "checkpoint.create",
    execution_id: "clawme-exec-1",
    idempotency_key: "clawme:req-1",
    actor: ACTOR,
    expected_state_version: 7,
    expires_at: "2026-07-26T03:00:00.000Z",
    confirmation: {
      mode: "biometric",
      challenge_id: "owner-challenge",
      confirmed_at: "2026-07-26T02:58:00.000Z",
    },
    input: { reason: "保存接班点" },
  },
};

function recordingRunner(observed, outcomes) {
  return async (_executable, args) => {
    const actionId = args[args.indexOf("run") + 1];
    const file = args[args.indexOf("--input-file") + 1];
    observed.push({ actionId, args, file, input: JSON.parse(readFileSync(file, "utf8")) });
    return { code: 0, stderr: "", stdout: `${JSON.stringify(outcomes[actionId])}\n` };
  };
}

function makeBridge(runner) {
  return new UuRescueBridge({
    cwd: process.cwd(),
    taskId: "owner-task",
    cliPath: "C:\\tools\\uu-rescue.js",
    runner,
  });
}

test("the bridge drives the shared Action IDs through private temp files", async () => {
  const observed = [];
  const bridge = makeBridge(recordingRunner(observed, {
    "checkpoint.challenge": {
      ok: true,
      action_id: "checkpoint.challenge",
      data: {
        challenge: {
          challenge_id: "owner-challenge",
          action_id: "checkpoint.create",
          actor: ACTOR,
          mode: "biometric",
          expected_state_version: 7,
        },
      },
      error: null,
    },
    "checkpoint.create": {
      ok: true,
      action_id: "checkpoint.create",
      data: {
        checkpoint: {
          checkpoint_id: "ckpt-1",
          checkpoint_sha256: "a".repeat(64),
          handoff_ref: "uu-rescue:task:owner-task:checkpoint:ckpt-1",
          task_state: "ready",
        },
        state_version: 9,
        recovered: false,
      },
      error: null,
    },
  }));

  const challenge = await bridge.handle({
    type: "shadow_challenge",
    payload: {
      owner_task_id: "owner-task",
      action_id: "checkpoint.create",
      actor: ACTOR,
      confirmation_mode: "biometric",
      input: { reason: "保存接班点" },
    },
  });
  const result = await bridge.handle({
    type: "shadow_execute",
    payload: { owner_task_id: "owner-task", envelope: EXECUTE_ENVELOPE },
  });

  // Both calls go through the generic action surface, not ShadowCore-only
  // compatibility commands.
  assert.deepEqual(observed.map((entry) => entry.actionId), [
    "checkpoint.challenge",
    "checkpoint.create",
  ]);
  assert.ok(observed.every((entry) => entry.args.includes("action") && entry.args.includes("run")));
  assert.ok(observed.every((entry) => !entry.args.some((arg) => arg.includes("保存接班点"))),
    "action input must never reach the command line");
  assert.ok(observed.every((entry) => !existsSync(entry.file)), "temp files are removed");

  assert.equal(challenge.ok, true);
  assert.equal(challenge.challenge.challenge_id, "owner-challenge");
  assert.deepEqual(observed[0].input, {
    task: "owner-task",
    reason: "保存接班点",
    mode: "biometric",
    actor: ACTOR,
  });

  assert.equal(result.ok, true);
  assert.equal(result.response.protocol, "action-parity/sync@0.1");
  assert.equal(result.response.type, "sync.result");
  assert.equal(result.response.stream_id, EXECUTE_ENVELOPE.stream_id);
  assert.equal(result.response.payload.execution_id, "clawme-exec-1");
  assert.equal(result.response.payload.ok, true);
  assert.equal(result.response.payload.data.checkpoint_id, "ckpt-1");
  assert.equal(result.response.payload.state_version, 9);
});

test("a redelivered command reproduces the exact fingerprint the ledger keys on", async () => {
  const observed = [];
  const outcomes = {
    "checkpoint.create": {
      ok: true,
      action_id: "checkpoint.create",
      data: { checkpoint: { checkpoint_id: "ckpt-1" }, state_version: 9, recovered: true },
      error: null,
    },
  };
  const bridge = makeBridge(recordingRunner(observed, outcomes));
  const command = {
    type: "shadow_execute",
    payload: { owner_task_id: "owner-task", envelope: EXECUTE_ENVELOPE },
  };

  await bridge.handle(command);
  await bridge.handle(command);

  // UURescue fingerprints action_id, execution_id, actor, expected_state_version,
  // expires_at, confirmation and input. Any field the agent regenerated per call
  // would break at-least-once delivery and write a second checkpoint.
  assert.deepEqual(observed[0].input, observed[1].input);
  assert.equal(observed[0].input.idempotency_key, "clawme:req-1");
  assert.equal(observed[0].input.expires_at, "2026-07-26T03:00:00.000Z");
  assert.equal(observed[0].input.confirmed_at, "2026-07-26T02:58:00.000Z");
  assert.equal(observed[0].input.execution_id, "clawme-exec-1");
});

test("a failed action still comes back as a projectable envelope", async () => {
  const observed = [];
  const bridge = makeBridge(recordingRunner(observed, {
    "checkpoint.create": {
      ok: false,
      action_id: "checkpoint.create",
      data: null,
      error: { code: "state_conflict", message: "任务状态已经变化，请刷新后重新确认。" },
    },
  }));

  const result = await bridge.handle({
    type: "shadow_execute",
    payload: { owner_task_id: "owner-task", envelope: EXECUTE_ENVELOPE },
  });

  assert.equal(result.ok, false);
  assert.equal(result.response.type, "sync.result");
  assert.equal(result.response.payload.ok, false);
  assert.equal(result.response.payload.error.code, "state_conflict");
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
