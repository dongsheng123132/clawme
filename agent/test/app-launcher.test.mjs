// 在 owner 电脑上启动程序。
//
// 这一层唯一真正要守住的东西：**手机发的是 ID，不是命令行**。命令行只存在于
// 本机这份配置里。守不住这条，"远程开程序"和"远程任意代码执行"就是同一件事。

import assert from "node:assert/strict";
import test from "node:test";
import { AppLauncher } from "../src/app-launcher.mjs";
import { ShadowWorker } from "../src/shadow-worker.mjs";

function fakeSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 4321, unref() {} };
  };
}

const APPS = [
  { id: "vscode", name: "VS Code", label: "VS", color: "#0a84ff", command: "C:/Code.exe" },
  { id: "terminal", name: "终端", label: ">_", command: "wt.exe", args: ["-p", "PowerShell"] },
];

test("上报的清单里没有命令行", () => {
  const launcher = new AppLauncher(APPS);
  const manifest = launcher.manifest();

  assert.equal(manifest.length, 2);
  assert.deepEqual(manifest[0], {
    id: "vscode", name: "VS Code", label: "VS", color: "#0a84ff",
  });
  // 手机需要知道有什么、怎么画，不需要知道怎么执行。
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes("Code.exe"), "命令行不得进入心跳");
  assert.ok(!serialized.includes("wt.exe"), "命令行不得进入心跳");
  assert.ok(!serialized.includes("PowerShell"), "参数不得进入心跳");
});

test("按 ID 启动，用参数数组而不是拼 shell 字符串", async () => {
  const calls = [];
  const launcher = new AppLauncher(APPS, { spawnFn: fakeSpawn(calls) });

  const result = await launcher.launch("terminal");

  assert.equal(result.ok, true);
  assert.equal(result.pid, 4321);
  assert.equal(calls[0].command, "wt.exe");
  assert.deepEqual(calls[0].args, ["-p", "PowerShell"]);
  // shell:false 之下，配置里再古怪的字符也变不成命令注入。
  assert.equal(calls[0].options.shell, false);
  // 脱离 agent：agent 退出不该把用户刚打开的程序一起带走。
  assert.equal(calls[0].options.detached, true);
});

test("没登记过的 ID 一律拒绝，而且不会去 spawn 任何东西", async () => {
  const calls = [];
  const launcher = new AppLauncher(APPS, { spawnFn: fakeSpawn(calls) });

  for (const attempt of ["calc", "", null, undefined, "../../../bin/sh", "vscode; rm -rf /"]) {
    const result = await launcher.launch(attempt);
    assert.equal(result.ok, false, `${attempt} 不该被启动`);
  }
  assert.equal(calls.length, 0, "拒绝的请求不该触发任何进程");
});

test("声明不完整的程序被丢掉，而不是变成一条半残的入口", () => {
  const launcher = new AppLauncher([
    { id: "ok", name: "可以", command: "a.exe" },
    { id: "no-command", name: "没有命令行" },
    { id: "no-name", command: "b.exe" },
    { id: "bad id", name: "id 不合法", command: "c.exe" },
    { id: "ok", name: "重复", command: "d.exe" },
    "不是对象",
  ]);
  assert.equal(launcher.size, 1);
  assert.equal(launcher.manifest()[0].id, "ok");
});

test("worker 会处理 app_launch，而它不属于任何任务流", async () => {
  const calls = [];
  const launcher = new AppLauncher(APPS, { spawnFn: fakeSpawn(calls) });
  const reported = [];

  const relay = {
    getCommands: async () => [
      // 注意没有 taskId：它是对这台机器的操作。早先的实现按任务过滤命令，
      // 于是这条永远轮不到被看见。
      { id: "cmd-1", type: "app_launch", payload: { app_id: "vscode" } },
    ],
    reportCommandResult: async (id, result) => { reported.push({ id, result }); },
    acknowledge: async () => {},
    addEvent: async () => {},
    getShadowCursor: async () => undefined,
    importShadowDelta: async () => ({ imported: 0, cursor: "c1", hasMore: false }),
  };
  const worker = new ShadowWorker({
    relay,
    bridge: { events: async () => ({}), handle: async () => ({}) },
    relayTaskId: "task-1",
    launcher,
  });

  await worker.runOnce();

  assert.equal(reported.length, 1);
  assert.equal(reported[0].id, "cmd-1");
  assert.equal(reported[0].result.ok, true);
  assert.equal(calls[0].command, "C:/Code.exe");
});

test("没配任何程序时，启动请求得到一个说得清的拒绝", async () => {
  const reported = [];
  const relay = {
    getCommands: async () => [{ id: "cmd-1", type: "app_launch", payload: { app_id: "vscode" } }],
    reportCommandResult: async (id, result) => { reported.push(result); },
    acknowledge: async () => {},
    addEvent: async () => {},
    getShadowCursor: async () => undefined,
    importShadowDelta: async () => ({ imported: 0, cursor: "c1", hasMore: false }),
  };
  const worker = new ShadowWorker({
    relay,
    bridge: { events: async () => ({}), handle: async () => ({}) },
    relayTaskId: "task-1",
  });

  await worker.runOnce();

  // 手机那边要能显示原因，而不是转圈到超时。
  assert.equal(reported[0].ok, false);
  assert.match(reported[0].error, /没有开放/);
});
