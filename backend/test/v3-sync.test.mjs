import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { V3Store } from "../dist/v3-store.js";

test("native shadows receive a snapshot and then cursor deltas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawme-sync-"));
  try {
    const store = new V3Store(join(dir, "relay.json"));
    await store.load();
    store.upsertTask({
      id: "task-sync",
      machineId: "pc-1",
      provider: "codex",
      title: "Cross-platform task",
      status: "running",
      metadata: {
        api_key: "must-not-leave-owner",
        local_path: "C:\\private\\project",
      },
    });

    const snapshot = store.syncTask("task-sync");
    assert.equal(snapshot.type, "sync.snapshot");
    assert.equal(snapshot.protocol, "action-parity/sync@0.1");
    assert.equal(snapshot.payload.state.task.status, "running");
    assert.equal(snapshot.payload.state.task.metadata.api_key, "[redacted]");
    assert.equal(snapshot.payload.state.task.metadata.local_path, "[redacted]");
    const cursor = snapshot.payload.cursor;

    store.addEvent("task-sync", {
      type: "task.progress",
      message: "2/3",
      data: { completed: 2, total: 3 },
    });
    const delta = store.syncTask("task-sync", cursor);
    assert.equal(delta.type, "sync.delta");
    assert.equal(delta.payload.events.length, 1);
    assert.equal(delta.payload.events[0].kind, "task.progress");
    assert.equal(delta.payload.previous_cursor, cursor);

    const empty = store.syncTask("task-sync", delta.payload.cursor);
    assert.equal(empty.type, "sync.delta");
    assert.deepEqual(empty.payload.events, []);
    assert.equal(empty.payload.cursor, delta.payload.cursor);
    await store.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attention changes are visible on the same task event stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawme-attention-sync-"));
  try {
    const store = new V3Store(join(dir, "relay.json"));
    await store.load();
    store.upsertTask({
      id: "task-attention",
      machineId: "pc-1",
      provider: "codex",
      title: "Approval task",
      status: "running",
    });
    const initial = store.syncTask("task-attention");
    const attention = store.addAttention({
      taskId: "task-attention",
      machineId: "pc-1",
      kind: "approval",
      title: "Run tests",
      options: [
        { id: "accept", label: "Allow once" },
        { id: "decline", label: "Decline" },
      ],
    });
    const waiting = store.syncTask("task-attention", initial.payload.cursor);
    assert.ok(
      waiting.payload.events.some((event) => event.kind === "attention.input_required"),
    );

    const cursor = waiting.payload.cursor;
    store.decideAttention(attention.id, "accept");
    const decided = store.syncTask("task-attention", cursor);
    assert.ok(
      decided.payload.events.some((event) => event.kind === "attention.decided"),
    );
    assert.ok(
      decided.payload.events.some((event) => event.kind === "command.queued"),
    );
    await store.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
