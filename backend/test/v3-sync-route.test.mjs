import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { installV3Routes } from "../dist/v3-routes.js";
import { V3Store } from "../dist/v3-store.js";

test("the relay exposes snapshot and delta over the existing authenticated HTTP API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawme-sync-route-"));
  const store = new V3Store(join(dir, "relay.json"));
  await store.load();
  store.upsertTask({
    id: "route-task",
    machineId: "pc-route",
    provider: "codex",
    title: "Route test",
    status: "running",
  });

  const app = express();
  app.use(express.json());
  installV3Routes(app, store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "X-ClawMe-Token": "test-token" };

  try {
    const snapshotResponse = await fetch(
      `${base}/v3/sync/tasks/route-task`,
      { headers },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.type, "sync.snapshot");

    store.addEvent("route-task", {
      type: "task.progress",
      data: { percent: 50 },
    });
    const deltaResponse = await fetch(
      `${base}/v3/sync/tasks/route-task?after=${encodeURIComponent(snapshot.payload.cursor)}`,
      { headers },
    );
    assert.equal(deltaResponse.status, 200);
    const delta = await deltaResponse.json();
    assert.equal(delta.type, "sync.delta");
    assert.equal(delta.payload.events[0].kind, "task.progress");

    const invalid = await fetch(
      `${base}/v3/sync/tasks/route-task?after=broken`,
      { headers },
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "invalid_cursor");
    await store.flush();
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(dir, { recursive: true, force: true });
  }
});
