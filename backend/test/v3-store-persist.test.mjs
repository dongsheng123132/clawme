import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { V3Store } from "../dist/v3-store.js";

test("a failed write neither crashes the relay nor stops later writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawme-persist-"));
  const target = join(dir, "relay.json");
  const store = new V3Store(target);
  await store.load();

  // Occupy the destination with a directory so the atomic rename cannot succeed.
  await mkdir(target);
  store.heartbeat({
    id: "pc-1",
    name: "first",
    platform: "win32",
    agentVersion: "0.4.0",
    capabilities: [],
  });

  // The relay must stay up: flush reports, it does not reject.
  await store.flush();
  assert.ok(store.persistError, "a failed write should be recorded");

  // In-memory state is still served while the disk is unavailable.
  assert.equal(store.listMachines().length, 1);

  // Once the obstruction clears, the save chain must still be usable.
  await rm(target, { recursive: true, force: true });
  store.heartbeat({
    id: "pc-2",
    name: "second",
    platform: "win32",
    agentVersion: "0.4.0",
    capabilities: [],
  });
  await store.flush();

  assert.equal(store.persistError, undefined, "a later success should clear the error");
  const written = JSON.parse(await readFile(target, "utf8"));
  assert.deepEqual(written.machines.map((m) => m.id).sort(), ["pc-1", "pc-2"]);

  await rm(dir, { recursive: true, force: true });
});
