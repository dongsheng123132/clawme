// 在 owner 电脑上启动程序。
//
// 这一层最要紧的不是"能不能开起来"，而是"手机能不能让电脑执行它想执行的东西"。
// 答案必须是不能：手机只发一个 ID，命令行由 owner 从自己的白名单里查。少了这道
// 墙，"远程开程序"就是"远程任意代码执行"换了个名字。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { installV3Routes } from "../dist/v3-routes.js";
import { V3Store } from "../dist/v3-store.js";

async function harness() {
  const previous = process.env.CLAWME_IDENTITIES;
  process.env.CLAWME_IDENTITIES = JSON.stringify({
    "phone-token": {
      actor_id: "phone-1", actor_kind: "device", surface: "android", role: "controller",
    },
    "owner-token": {
      actor_id: "owner-1", actor_kind: "service", surface: "win32", role: "owner",
      machine_ids: ["pc-1"],
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "clawme-launch-"));
  const store = new V3Store(join(dir, "relay.json"));
  await store.load();
  const app = express();
  app.use(express.json());
  installV3Routes(app, store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    store,
    base,
    phone: { "Content-Type": "application/json", "X-ClawMe-Token": "phone-token" },
    owner: { "Content-Type": "application/json", "X-ClawMe-Token": "owner-token" },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await store.flush().catch(() => {});
      await rm(dir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.CLAWME_IDENTITIES;
      else process.env.CLAWME_IDENTITIES = previous;
    },
  };
}

async function registerMachine(h, apps) {
  return fetch(`${h.base}/v3/machines/heartbeat`, {
    method: "POST",
    headers: h.owner,
    body: JSON.stringify({
      id: "pc-1", name: "主机", platform: "win32", agentVersion: "0.4.0",
      capabilities: ["checkpoint.create"], apps,
    }),
  });
}

test("owner 声明的程序清单会到手机手上，但命令行不会", async () => {
  const h = await harness();
  try {
    // owner 端配置里当然有命令行，但它不该出现在上行里；这里模拟一个粗心的
    // agent 把 command 一起发上来，relay 必须把它丢掉。
    await registerMachine(h, [
      { id: "vscode", name: "VS Code", label: "VS", color: "#0a84ff", command: "C:/vscode.exe" },
      { id: "chrome", name: "Chrome", label: "Ch" },
    ]);

    const listed = await fetch(`${h.base}/v3/machines`, { headers: h.phone });
    const { machines } = await listed.json();
    const apps = machines[0].apps;

    assert.equal(apps.length, 2);
    assert.equal(apps[0].id, "vscode");
    assert.equal(apps[0].label, "VS");
    assert.equal(apps[0].color, "#0a84ff");
    // relay 只转发身份和怎么画，不转发怎么执行。
    assert.equal(apps[0].command, undefined);
    assert.ok(!JSON.stringify(machines).includes("vscode.exe"), "命令行不得过网");
  } finally {
    await h.close();
  }
});

test("非法或重复的程序声明被丢掉，而不是让整次心跳失败", async () => {
  const h = await harness();
  try {
    await registerMachine(h, [
      { id: "ok", name: "可以" },
      { id: "ok", name: "重复的" },
      { id: "", name: "没有 id" },
      { id: "bad id with spaces", name: "id 不合法" },
      { id: "../../etc/passwd", name: "路径穿越" },
      "不是对象",
      { id: "color", name: "颜色不合法", color: "red" },
    ]);
    const { machines } = await (await fetch(`${h.base}/v3/machines`, { headers: h.phone })).json();
    const ids = machines[0].apps.map((a) => a.id);

    assert.deepEqual(ids, ["ok", "color"]);
    // 颜色格式不对就当没写，而不是把 "red" 原样塞给界面。
    assert.equal(machines[0].apps[1].color, undefined);
  } finally {
    await h.close();
  }
});

test("点图标只排队一个 ID，owner 拿到的也只有 ID", async () => {
  const h = await harness();
  try {
    await registerMachine(h, [{ id: "vscode", name: "VS Code" }]);

    const launched = await fetch(`${h.base}/v3/machines/pc-1/apps/vscode/launch`, {
      method: "POST", headers: h.phone,
    });
    assert.equal(launched.status, 202);
    const { command_id, status } = await launched.json();
    assert.equal(status, "queued");

    const polled = await (await fetch(`${h.base}/v3/agent/commands?machineId=pc-1`, {
      headers: h.owner,
    })).json();
    const command = polled.commands.find((c) => c.id === command_id);

    assert.equal(command.type, "app_launch");
    assert.equal(command.payload.app_id, "vscode");
    // owner 收到的是"开哪个"，不是"跑什么"。
    assert.equal(command.payload.command, undefined);
    assert.equal(command.payload.path, undefined);
  } finally {
    await h.close();
  }
});

test("没声明过的程序开不了", async () => {
  const h = await harness();
  try {
    await registerMachine(h, [{ id: "vscode", name: "VS Code" }]);
    const denied = await fetch(`${h.base}/v3/machines/pc-1/apps/calc/launch`, {
      method: "POST", headers: h.phone,
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error, "app_not_declared");

    const missing = await fetch(`${h.base}/v3/machines/pc-nope/apps/vscode/launch`, {
      method: "POST", headers: h.phone,
    });
    assert.equal(missing.status, 404);
  } finally {
    await h.close();
  }
});

test("重试不会开出两个窗口", async () => {
  const h = await harness();
  try {
    await registerMachine(h, [{ id: "vscode", name: "VS Code" }]);
    const headers = { ...h.phone, "Idempotency-Key": "tap-1" };
    const first = await (await fetch(`${h.base}/v3/machines/pc-1/apps/vscode/launch`,
      { method: "POST", headers })).json();
    const again = await (await fetch(`${h.base}/v3/machines/pc-1/apps/vscode/launch`,
      { method: "POST", headers })).json();

    // 命令至少一次投递，所以点一下网络重试两次是常态。
    assert.equal(first.command_id, again.command_id);
  } finally {
    await h.close();
  }
});

test("owner 回报结果后，手机能查到开没开起来", async () => {
  const h = await harness();
  try {
    await registerMachine(h, [{ id: "vscode", name: "VS Code" }]);
    const { command_id } = await (await fetch(`${h.base}/v3/machines/pc-1/apps/vscode/launch`,
      { method: "POST", headers: h.phone })).json();

    const done = await fetch(`${h.base}/v3/agent/commands/${command_id}/result`, {
      method: "POST",
      headers: h.owner,
      body: JSON.stringify({ machineId: "pc-1", result: { ok: true, pid: 4321 } }),
    });
    assert.equal(done.status, 200);

    const status = await (await fetch(`${h.base}/v3/commands/${command_id}`, {
      headers: h.phone,
    })).json();
    assert.equal(status.status, "completed");
    assert.equal(status.result.ok, true);
    assert.equal(status.result.pid, 4321);
  } finally {
    await h.close();
  }
});

test("启动不需要挑战确认，但仍然需要一个有效身份", async () => {
  const h = await harness();
  try {
    await registerMachine(h, [{ id: "vscode", name: "VS Code" }]);
    const anonymous = await fetch(`${h.base}/v3/machines/pc-1/apps/vscode/launch`, {
      method: "POST", headers: { "Content-Type": "application/json" },
    });
    // 配对本身就是授权 —— 但没配对的人当然什么都开不了。
    assert.equal(anonymous.status, 401);
  } finally {
    await h.close();
  }
});
