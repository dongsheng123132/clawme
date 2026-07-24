import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { V3Store } from "../dist/v3-store.js";

test("persists a task, attention decision, and agent command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawme-store-"));
  const file = join(dir, "relay.json");
  try {
    const store = new V3Store(file);
    await store.load();
    store.heartbeat({
      id: "pc-1",
      name: "Test PC",
      platform: "win32",
      agentVersion: "0.3.0",
      capabilities: ["codex-native"],
    });
    store.upsertTask({
      id: "task-1",
      machineId: "pc-1",
      provider: "codex",
      title: "Run tests",
      status: "running",
    });
    const attention = store.addAttention({
      taskId: "task-1",
      machineId: "pc-1",
      kind: "approval",
      title: "Run npm test",
      options: [
        { id: "accept", label: "允许一次" },
        { id: "decline", label: "拒绝" },
      ],
      nativeRequestId: 7,
      nativeMethod: "item/commandExecution/requestApproval",
    });
    assert.equal(store.getTask("task-1")?.status, "waiting");
    assert.equal(store.decideAttention(attention.id, "accept")?.decision, "accept");
    assert.equal(store.pendingCommands("pc-1")[0]?.payload.nativeRequestId, 7);
    await store.flush();

    const restored = new V3Store(file);
    await restored.load();
    assert.equal(restored.listMachines()[0]?.name, "Test PC");
    assert.equal(restored.listTasks()[0]?.id, "task-1");
    assert.equal(restored.listAttention("decided")[0]?.decision, "accept");
    const persisted = await readFile(file, "utf8");
    assert.doesNotThrow(() => JSON.parse(persisted));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
