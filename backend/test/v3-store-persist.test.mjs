import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { V3Store } from "../dist/v3-store.js";

const machine = (id) => ({
  id,
  name: id,
  platform: "win32",
  agentVersion: "0.4.0",
  capabilities: [],
});

test("a failed write neither crashes the relay nor stops later writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawme-persist-"));
  const blocked = join(dir, "state");
  const target = join(blocked, "relay.json");
  const store = new V3Store(target);
  await store.load();

  // Occupy the parent directory with a file so the write cannot land.
  await writeFile(blocked, "not a directory", "utf8");
  store.heartbeat(machine("pc-1"));

  // The relay must stay up: flush reports, it does not reject.
  await store.flush();
  assert.ok(store.persistError, "a failed write should be recorded");

  // In-memory state is still served while the disk is unavailable.
  assert.equal(store.listMachines().length, 1);

  // Once the obstruction clears, the save chain must still be usable.
  await rm(blocked, { force: true });
  store.heartbeat(machine("pc-2"));
  await store.flush();

  assert.equal(store.persistError, undefined, "a later success should clear the error");
  const written = JSON.parse(await readFile(target, "utf8"));
  assert.deepEqual(written.machines.map((m) => m.id).sort(), ["pc-1", "pc-2"]);

  await rm(dir, { recursive: true, force: true });
});

test("a destroyed main file falls back to the previous good copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawme-rollback-"));
  const target = join(dir, "relay.json");
  const store = new V3Store(target);
  await store.load();

  store.heartbeat(machine("pc-1"));
  await store.flush();
  store.heartbeat(machine("pc-2"));
  await store.flush();

  // A backup of the previous state must exist alongside the current one.
  const backup = JSON.parse(await readFile(`${target}.bak`, "utf8"));
  assert.deepEqual(backup.machines.map((m) => m.id), ["pc-1"]);

  // Reproduce the observed failure: the swap removed the destination and the
  // relay restarted. It must come back with the backup, not an empty world.
  await rm(target, { force: true });
  const restarted = new V3Store(target);
  await restarted.load();
  assert.deepEqual(restarted.listMachines().map((m) => m.id), ["pc-1"]);

  await rm(dir, { recursive: true, force: true });
});

test("a torn main file falls back instead of starting empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawme-torn-"));
  const target = join(dir, "relay.json");
  const store = new V3Store(target);
  await store.load();

  store.heartbeat(machine("pc-1"));
  await store.flush();
  store.heartbeat(machine("pc-2"));
  await store.flush();

  await writeFile(target, '{"machines": [{"id": "pc-2"', "utf8");
  const restarted = new V3Store(target);
  await restarted.load();
  assert.deepEqual(restarted.listMachines().map((m) => m.id), ["pc-1"]);

  await rm(dir, { recursive: true, force: true });
});

test("an orphaned temp file is recovered when nothing else survives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawme-orphan-"));
  const target = join(dir, "relay.json");
  const store = new V3Store(target);
  await store.load();
  store.heartbeat(machine("pc-1"));
  await store.flush();

  // Exactly the wreckage the crash left behind: only a valid .tmp remained.
  await writeFile(`${target}.tmp`, await readFile(target, "utf8"), "utf8");
  await rm(target, { force: true });
  await rm(`${target}.bak`, { force: true });

  const restarted = new V3Store(target);
  await restarted.load();
  assert.deepEqual(restarted.listMachines().map((m) => m.id), ["pc-1"]);

  await rm(dir, { recursive: true, force: true });
});
