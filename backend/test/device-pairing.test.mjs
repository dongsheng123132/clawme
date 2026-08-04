// 设备配对与吊销。
//
// 这一层要解决的是今天那个事故暴露的操作现实：凭据如果只能靠改环境变量再重启，
// 实践中就没人会去吊销它。所以凭据必须能单独签发、单独作废、立即生效。

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import {
  getIdentityFromRequest,
  isRootIdentity,
  isTokenAllowed,
  useDeviceResolver,
} from "../dist/auth.js";
import { DeviceStore } from "../dist/devices.js";
import { installDeviceRoutes } from "../dist/v3-routes.js";

const TEMPLATE = {
  name: "测试手机",
  actorKind: "device",
  surface: "android",
  role: "controller",
  machineIds: [],
};

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "clawme-devices-"));
  const file = join(dir, "devices.json");
  const store = new DeviceStore(file);
  await store.load();
  return { store, file, dir };
}

const request = (token) => ({ headers: { "x-clawme-token": token } });

test("配对码换出的设备令牌可用，而配对码本身一次性作废", async () => {
  const { store, dir } = await freshStore();
  try {
    const { code } = store.createPairingCode(TEMPLATE);
    // 给人手输的码：分组显示、不含容易看错的字符。
    assert.match(code, /^[0-9A-HJ-NP-TV-Z]{5}-[0-9A-HJ-NP-TV-Z]{5}$/);

    const { token, device } = store.redeemPairingCode(code);
    assert.equal(device.surface, "android");
    assert.equal(device.role, "controller");
    assert.ok(store.resolve(token), "刚签发的令牌必须能解析");

    // 同一个码不能换第二台设备 —— 否则截图泄露一次等于永久后门。
    assert.throws(() => store.redeemPairingCode(code), /invalid or expired/);
  } finally {
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test("配对码会过期", async () => {
  const { store, dir } = await freshStore();
  try {
    const { code } = store.createPairingCode(TEMPLATE, -1);
    assert.throws(() => store.redeemPairingCode(code), /invalid or expired/);
  } finally {
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test("兑换时容忍大小写、连字符和空格", async () => {
  const { store, dir } = await freshStore();
  try {
    const { code } = store.createPairingCode(TEMPLATE);
    // 用户是照着屏幕念出来输进去的，格式不该成为失败原因。
    const messy = ` ${code.toLowerCase().replace("-", " ")} `;
    assert.ok(store.redeemPairingCode(messy).token);
  } finally {
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test("吊销立即生效，不需要重启，也不波及其他设备", async () => {
  const { store, dir } = await freshStore();
  try {
    const first = store.redeemPairingCode(store.createPairingCode(TEMPLATE).code);
    const second = store.redeemPairingCode(store.createPairingCode(TEMPLATE).code);

    store.revokeDevice(first.device.id);

    assert.equal(store.resolve(first.token), null, "被吊销的设备必须立刻失效");
    assert.ok(store.resolve(second.token), "吊销一台不该影响另一台");

    const listed = store.listDevices().find((d) => d.id === first.device.id);
    assert.ok(listed.revokedAt, "吊销要留下痕迹");
  } finally {
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test("落盘的凭据文件里没有明文令牌，也没有明文配对码", async () => {
  const { store, file, dir } = await freshStore();
  try {
    const { code } = store.createPairingCode(TEMPLATE);
    const { token } = store.redeemPairingCode(code);
    await store.flush();

    const raw = await readFile(file, "utf8");
    // 文件被拖走也不能被重放 —— 只留哈希。
    assert.ok(!raw.includes(token), "令牌明文不得落盘");
    assert.ok(!raw.includes(code.replace("-", "")), "配对码明文不得落盘");
    assert.ok(raw.includes("tokenHash"), "应当存的是哈希");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("重启后设备令牌仍然有效，被吊销的仍然无效", async () => {
  const { store, file, dir } = await freshStore();
  try {
    const alive = store.redeemPairingCode(store.createPairingCode(TEMPLATE).code);
    const dead = store.redeemPairingCode(store.createPairingCode(TEMPLATE).code);
    store.revokeDevice(dead.device.id);
    await store.flush();

    const reloaded = new DeviceStore(file);
    await reloaded.load();
    assert.ok(reloaded.resolve(alive.token), "重启不该让有效设备掉线");
    assert.equal(reloaded.resolve(dead.token), null, "重启不该让吊销复活");
    await reloaded.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("大量错误兑换会被限速", async () => {
  const { store, dir } = await freshStore();
  try {
    let throttled = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        store.redeemPairingCode("22222-22222");
      } catch (error) {
        if (error.code === "too_many_attempts") { throttled = true; break; }
      }
    }
    // 配对码短到能手输，就必须假设有人会去猜。
    assert.ok(throttled, "连续失败必须触发限速");
  } finally {
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test("设备令牌是设备身份，不是根凭据", async () => {
  const previous = process.env.CLAWME_TOKENS;
  process.env.CLAWME_TOKENS = "root-token";
  const { store, dir } = await freshStore();
  useDeviceResolver(store);
  try {
    const { token } = store.redeemPairingCode(store.createPairingCode(TEMPLATE).code);

    const root = getIdentityFromRequest(request("root-token"));
    const device = getIdentityFromRequest(request(token));

    assert.ok(isRootIdentity(root), "环境变量凭据是根凭据");
    assert.equal(isRootIdentity(device), false, "配对出来的设备不是根凭据");
    assert.equal(device.source, "device");
    assert.equal(device.role, "controller");
    assert.equal(device.surface, "android");
    assert.ok(isTokenAllowed(token));

    // 未登记的令牌依然进不来。
    assert.equal(isTokenAllowed("someone-elses-token"), false);
  } finally {
    useDeviceResolver(null);
    await store.flush();
    await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CLAWME_TOKENS;
    else process.env.CLAWME_TOKENS = previous;
  }
});

test("配置了身份映射时，设备令牌仍然能通过", async () => {
  const previous = process.env.CLAWME_IDENTITIES;
  process.env.CLAWME_IDENTITIES = JSON.stringify({
    "owner-token": { actor_id: "owner-1", actor_kind: "service", role: "owner", machine_ids: ["pc-1"] },
  });
  const { store, dir } = await freshStore();
  useDeviceResolver(store);
  try {
    const { token } = store.redeemPairingCode(store.createPairingCode(TEMPLATE).code);
    // 早期实现里身份映射一旦存在，就会把不在映射里的令牌全部拒掉，
    // 设备凭据于是永远无法启用。
    assert.ok(isTokenAllowed(token), "设备令牌不该被身份映射挡住");
    assert.ok(isTokenAllowed("owner-token"));
    assert.equal(isTokenAllowed("nope"), false);
  } finally {
    useDeviceResolver(null);
    await store.flush();
    await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CLAWME_IDENTITIES;
    else process.env.CLAWME_IDENTITIES = previous;
  }
});

test("HTTP：根凭据能签发和吊销，设备凭据不能", async () => {
  const previous = process.env.CLAWME_TOKENS;
  process.env.CLAWME_TOKENS = "root-token";
  const { store, dir } = await freshStore();
  useDeviceResolver(store);

  const app = express();
  app.use(express.json());
  installDeviceRoutes(app, store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = { "Content-Type": "application/json", "X-ClawMe-Token": "root-token" };

  try {
    const issued = await fetch(`${base}/v3/pairing/codes`, {
      method: "POST",
      headers: root,
      body: JSON.stringify({ name: "我的手机", surface: "android", role: "controller" }),
    });
    assert.equal(issued.status, 201);
    const { code } = await issued.json();

    // 兑换不需要鉴权：配对码本身就是那一次的凭据，新手机还没有别的东西。
    const redeemed = await fetch(`${base}/v3/pairing/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, device_name: "Pixel" }),
    });
    assert.equal(redeemed.status, 201);
    const device = await redeemed.json();
    assert.ok(device.token);
    assert.equal(device.name, "Pixel");

    // 配对出来的手机不能再去配对别的手机。
    const escalation = await fetch(`${base}/v3/pairing/codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ClawMe-Token": device.token },
      body: JSON.stringify({ name: "偷偷加一台" }),
    });
    assert.equal(escalation.status, 403);
    assert.equal((await escalation.json()).error, "root_credential_required");

    const listed = await fetch(`${base}/v3/devices`, { headers: root });
    const { devices } = await listed.json();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].tokenHash, undefined, "列表不该回传哈希");

    const revoked = await fetch(`${base}/v3/devices/${device.device_id}/revoke`, {
      method: "POST",
      headers: root,
    });
    assert.equal(revoked.status, 200);
    assert.equal(store.resolve(device.token), null, "吊销后立即失效");
  } finally {
    useDeviceResolver(null);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await store.flush();
    await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CLAWME_TOKENS;
    else process.env.CLAWME_TOKENS = previous;
  }
});
