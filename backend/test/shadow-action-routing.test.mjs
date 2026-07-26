import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { V3Store } from "../dist/v3-store.js";
import { ownerStreamId, resolveActionId } from "../dist/shadow.js";

const ACTOR = { id: "ios-1", kind: "device", surface: "ios" };

function machine(capabilities) {
  return {
    id: "pc-1",
    name: "pc-1",
    platform: "win32",
    agentVersion: "0.4.0",
    capabilities,
  };
}

async function storeWith(capabilities, task) {
  const dir = await mkdtemp(join(tmpdir(), "clawme-routing-"));
  const store = new V3Store(join(dir, "relay.json"));
  await store.load();
  store.heartbeat(machine(capabilities));
  store.upsertTask({ machineId: "pc-1", status: "running", ...task });
  return { store, dir };
}

test("the owner stream is named by the provider, not by the relay", () => {
  assert.equal(
    ownerStreamId({ id: "t1", provider: "uu-rescue", metadata: { owner_task_id: "owner-7" } }),
    "uu-rescue:task:owner-7",
  );
  assert.equal(
    ownerStreamId({ id: "t2", provider: "open365", metadata: {} }),
    "open365:task:t2",
  );
});

test("an action the machine never declared is refused", async () => {
  const { store, dir } = await storeWith(["checkpoint.create"], {
    id: "t1", provider: "uu-rescue", title: "t",
  });
  assert.throws(
    () => store.requestCheckpointChallenge({
      taskId: "t1",
      actor: ACTOR,
      reason: "试试没声明的动作",
      confirmationMode: "explicit",
      actionId: "startup.disable",
      requestKey: "k1",
    }),
    (error) => error.code === "shadow_action_unavailable" && error.status === 409,
  );
  await rm(dir, { recursive: true, force: true });
});

test("a declared action is routed with its own identity and stream", async () => {
  const { store, dir } = await storeWith(["checkpoint.create", "startup.disable"], {
    id: "t1", provider: "open365", title: "t",
  });
  const queued = store.requestCheckpointChallenge({
    taskId: "t1",
    actor: ACTOR,
    reason: "关掉开机自启",
    confirmationMode: "explicit",
    actionId: "startup.disable",
    requestKey: "k1",
  });
  assert.equal(queued.command.payload.action_id, "startup.disable");
  assert.equal(queued.command.payload.stream_id, "open365:task:t1");
  await rm(dir, { recursive: true, force: true });
});

test("an agent that only declares the legacy capability keeps working", async () => {
  const { store, dir } = await storeWith(["shadowcore-owner"], {
    id: "t1", provider: "uu-rescue", title: "t",
  });
  const queued = store.requestCheckpointChallenge({
    taskId: "t1",
    actor: ACTOR,
    reason: "老 agent 仍然能存接班点",
    confirmationMode: "explicit",
    requestKey: "k1",
  });
  assert.equal(queued.command.payload.action_id, "checkpoint.create");

  // But it must not be able to reach anything it never declared.
  assert.throws(
    () => store.requestCheckpointChallenge({
      taskId: "t1",
      actor: ACTOR,
      reason: "越界",
      confirmationMode: "explicit",
      actionId: "startup.disable",
      requestKey: "k2",
    }),
    (error) => error.code === "shadow_action_unavailable",
  );
  await rm(dir, { recursive: true, force: true });
});

test("a malformed action id is rejected before anything is queued", () => {
  assert.throws(
    () => resolveActionId("../../etc/passwd", machine(["checkpoint.create"])),
    (error) => error.code === "invalid_action_id",
  );
  assert.throws(
    () => resolveActionId("noDots", machine(["noDots"])),
    (error) => error.code === "invalid_action_id",
  );
});
