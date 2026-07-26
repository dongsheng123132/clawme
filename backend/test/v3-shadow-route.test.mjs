import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { installV3Routes } from "../dist/v3-routes.js";
import { V3Store } from "../dist/v3-store.js";

const PROTOCOL = "action-parity/sync@0.1";

async function json(response) {
  return { response, body: await response.json() };
}

test("controller confirmation crosses the owner boundary and returns as a task delta", async () => {
  const previousIdentities = process.env.CLAWME_IDENTITIES;
  process.env.CLAWME_IDENTITIES = JSON.stringify({
    "ios-token": {
      actor_id: "ios-device-1",
      actor_kind: "device",
      surface: "ios",
      role: "controller",
    },
    "owner-token": {
      actor_id: "owner-pc-1",
      actor_kind: "service",
      surface: "windows",
      role: "owner",
      machine_ids: ["pc-shadow"],
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "clawme-shadow-route-"));
  const store = new V3Store(join(dir, "relay.json"));
  await store.load();
  const app = express();
  app.use(express.json());
  installV3Routes(app, store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const controllerHeaders = {
    "Content-Type": "application/json",
    "X-ClawMe-Token": "ios-token",
  };
  const ownerHeaders = {
    "Content-Type": "application/json",
    "X-ClawMe-Token": "owner-token",
  };

  try {
    const heartbeat = await fetch(`${base}/v3/machines/heartbeat`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        id: "pc-shadow",
        name: "Owner PC",
        platform: "win32",
        agentVersion: "0.4.0",
        capabilities: ["shadowcore-owner"],
      }),
    });
    assert.equal(heartbeat.status, 200);
    const registered = await fetch(`${base}/v3/tasks`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        id: "shadow-task",
        machineId: "pc-shadow",
        provider: "uu-rescue",
        title: "Save a handoff checkpoint",
        status: "running",
        metadata: { owner_task_id: "owner-task-7" },
      }),
    });
    assert.equal(registered.status, 201);
    const initial = store.syncTask("shadow-task");

    const controllerCannotRewriteTask = await fetch(`${base}/v3/tasks`, {
      method: "POST",
      headers: controllerHeaders,
      body: JSON.stringify({
        id: "shadow-task",
        machineId: "pc-shadow",
        provider: "uu-rescue",
        title: "spoofed",
        status: "running",
        metadata: { owner_task_id: "spoofed-owner-task" },
      }),
    });
    assert.equal(controllerCannotRewriteTask.status, 401);

    const queued = await json(await fetch(
      `${base}/v3/tasks/shadow-task/shadow/checkpoint-challenges`,
      {
        method: "POST",
        headers: { ...controllerHeaders, "Idempotency-Key": "ios-request-1" },
        body: JSON.stringify({
          reason: "手机确认保存当前接班点",
          confirmation_mode: "biometric",
          actor: { id: "spoofed-owner" },
        }),
      },
    ));
    assert.equal(queued.response.status, 202);

    const controllerCannotPoll = await fetch(
      `${base}/v3/agent/commands?machineId=pc-shadow`,
      { headers: controllerHeaders },
    );
    assert.equal(controllerCannotPoll.status, 401);

    const ownerPoll = await json(await fetch(
      `${base}/v3/agent/commands?machineId=pc-shadow`,
      { headers: ownerHeaders },
    ));
    assert.equal(ownerPoll.response.status, 200);
    const challengeCommand = ownerPoll.body.commands[0];
    assert.equal(challengeCommand.type, "shadow_challenge");
    assert.equal(challengeCommand.payload.actor.id, "ios-device-1");
    assert.equal(challengeCommand.payload.actor.surface, "ios");
    assert.equal(challengeCommand.payload.owner_task_id, "owner-task-7");

    const challenge = {
      challenge_id: "challenge-owner-1",
      action_id: "checkpoint.create",
      actor: challengeCommand.payload.actor,
      mode: "biometric",
      input_sha256: "a".repeat(64),
      expected_state_version: 4,
      issued_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
    };
    const challengeResult = await json(await fetch(
      `${base}/v3/agent/commands/${challengeCommand.id}/result`,
      {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          machineId: "pc-shadow",
          result: { ok: true, challenge },
        }),
      },
    ));
    assert.equal(challengeResult.response.status, 200);

    const challengeDelta = store.syncTask("shadow-task", initial.payload.cursor);
    const challengeEvent = challengeDelta.payload.events.find(
      (event) => event.kind === "sync.challenge",
    );
    assert.equal(challengeEvent.payload.reason, "手机确认保存当前接班点");
    assert.equal(challengeEvent.payload.challenge_id, "challenge-owner-1");

    const confirmedAt = new Date().toISOString();
    const confirmed = await json(await fetch(
      `${base}/v3/tasks/shadow-task/shadow/checkpoint-challenges/${challengeCommand.id}/confirm`,
      {
        method: "POST",
        headers: controllerHeaders,
        body: JSON.stringify({ confirmed_at: confirmedAt }),
      },
    ));
    assert.equal(confirmed.response.status, 202);

    const executionPoll = await json(await fetch(
      `${base}/v3/agent/commands?machineId=pc-shadow`,
      { headers: ownerHeaders },
    ));
    const executeCommand = executionPoll.body.commands[0];
    assert.equal(executeCommand.type, "shadow_execute");
    const envelope = executeCommand.payload.envelope;
    assert.equal(envelope.protocol, PROTOCOL);
    assert.equal(envelope.payload.actor.id, "ios-device-1");
    assert.equal(envelope.payload.input.reason, "手机确认保存当前接班点");
    assert.equal(envelope.payload.confirmation.challenge_id, "challenge-owner-1");

    const ownerResponse = {
      protocol: PROTOCOL,
      type: "sync.result",
      stream_id: "uu-rescue:task:owner-task-7",
      message_id: "owner-result-1",
      sent_at: new Date().toISOString(),
      payload: {
        action_id: "checkpoint.create",
        execution_id: envelope.payload.execution_id,
        ok: true,
        data: {
          checkpoint_id: "checkpoint-1",
          checkpoint_sha256: "b".repeat(64),
          handoff_ref: "uu-rescue:task:owner-task-7:checkpoint:checkpoint-1",
          task_state: "ready",
        },
        error: null,
        state_version: 7,
      },
    };
    const executionResult = await json(await fetch(
      `${base}/v3/agent/commands/${executeCommand.id}/result`,
      {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          machineId: "pc-shadow",
          result: { ok: true, response: ownerResponse },
        }),
      },
    ));
    assert.equal(executionResult.response.status, 200);

    const finalDelta = store.syncTask("shadow-task", challengeDelta.payload.cursor);
    const resultEvent = finalDelta.payload.events.find(
      (event) => event.kind === "sync.result",
    );
    assert.equal(resultEvent.payload.ok, true);
    assert.equal(resultEvent.payload.checkpoint_id, "checkpoint-1");

    const retriedConfirmation = await json(await fetch(
      `${base}/v3/tasks/shadow-task/shadow/checkpoint-challenges/${challengeCommand.id}/confirm`,
      {
        method: "POST",
        headers: controllerHeaders,
        body: JSON.stringify({ confirmed_at: confirmedAt }),
      },
    ));
    assert.equal(retriedConfirmation.response.status, 200);
    assert.equal(retriedConfirmation.body.command_id, executeCommand.id);

    const ownerDelta = {
      protocol: PROTOCOL,
      type: "sync.delta",
      stream_id: "uu-rescue:task:owner-task-7",
      message_id: "owner-delta-1",
      sent_at: new Date().toISOString(),
      payload: {
        previous_cursor: "uur1.zero",
        cursor: "uur1.one",
        state_version: 1,
        has_more: false,
        events: [{
          event_id: "owner-event-1",
          sequence: 1,
          kind: "checkpoint.created",
          occurred_at: new Date().toISOString(),
          entity: { type: "task", id: "owner-task-7" },
          payload: { checkpoint_id: "checkpoint-1" },
        }],
      },
    };
    const imported = await json(await fetch(
      `${base}/v3/agent/tasks/shadow-task/shadow-delta`,
      {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ delta: ownerDelta }),
      },
    ));
    assert.equal(imported.response.status, 200);
    assert.equal(imported.body.imported, 1);
    assert.equal(store.getShadowCursor("shadow-task"), "uur1.one");

    const staleImport = await json(await fetch(
      `${base}/v3/agent/tasks/shadow-task/shadow-delta`,
      {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ delta: ownerDelta }),
      },
    ));
    assert.equal(staleImport.response.status, 409);
    assert.equal(staleImport.body.error, "shadow_cursor_conflict");
    assert.equal(staleImport.body.current_cursor, "uur1.one");
    await store.flush();
  } finally {
    if (previousIdentities === undefined) delete process.env.CLAWME_IDENTITIES;
    else process.env.CLAWME_IDENTITIES = previousIdentities;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    // The store keeps a backup beside the main file, so drain the save chain
    // before removing the directory or the delete races the next write.
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  }
});
