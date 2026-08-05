#!/usr/bin/env node
import { hostname, platform } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { RelayClient } from "./relay-client.mjs";
import { CodexAdapter } from "./codex-adapter.mjs";
import { ShadowWorker } from "./shadow-worker.mjs";
import { ActionCliBridge } from "./action-cli-bridge.mjs";
import { AppLauncher } from "./app-launcher.mjs";
import { AppHost } from "./app-host.mjs";

function usage() {
  console.log(`
ClawMe Agent v0.4

用法:
  npm start -- run "让 Codex 完成的任务"
  npm start -- shadow
  npm start -- apps                只上报可启动程序并执行手机点下来的启动

环境变量:
  CLAWME_BASE_URL       Relay 地址，例如 https://api.clawme.net
  CLAWME_TOKEN          配对 Token
  CLAWME_CWD            Codex 工作目录，默认当前目录
  CLAWME_MODEL          可选，指定 Codex 模型
  CLAWME_MACHINE_ID     可选，覆盖自动生成的设备 ID
  CLAWME_UU_RESCUE_BIN  shadow 模式必填，UURescue 的 bin/uu-rescue.js
  CLAWME_UU_RESCUE_TASK_ID  可选，默认使用当前 UURescue 任务
  CLAWME_RELAY_TASK_ID  可选，覆盖 Relay 内的影核任务 ID
  CLAWME_APPS           apps 模式的程序清单，默认 ./clawme-apps.json
`);
}

const [, , command, ...rest] = process.argv;
if (!["run", "shadow", "apps"].includes(command) || (command === "run" && rest.length === 0)) {
  usage();
  process.exit(command ? 1 : 0);
}

const baseUrl = process.env.CLAWME_BASE_URL;
const token = process.env.CLAWME_TOKEN;
if (!baseUrl || !token) {
  console.error("缺少 CLAWME_BASE_URL 或 CLAWME_TOKEN");
  process.exit(1);
}

const machineName = hostname();
const machineId = process.env.CLAWME_MACHINE_ID
  || `pc-${createHash("sha256").update(`${machineName}:${platform()}`).digest("hex").slice(0, 12)}`;
const cwd = resolve(process.env.CLAWME_CWD || process.cwd());
const relay = new RelayClient({ baseUrl, token, machineId });

function relayStatus(ownerState) {
  if (ownerState === "completed") return "completed";
  if (ownerState === "takeover_failed") return "failed";
  if (["blocked_limit", "blocked_error", "handoff_sent"].includes(ownerState)) {
    return "waiting";
  }
  return "running";
}

if (command === "apps") {
  // 最短路径：只上报本机开放的程序，并执行手机点下来的启动。
  // 不需要 Codex，也不需要 UURescue —— 想让手机上出现几个图标，不该先装一套
  // AI 工具链。
  const launcher = await AppLauncher.fromFile(
    resolve(process.env.CLAWME_APPS || "clawme-apps.json"),
  );
  if (launcher.size === 0) {
    console.error(
      "没有可启动的程序。复制 clawme-apps.example.json 成 clawme-apps.json 填上你的路径，"
        + "或用 CLAWME_APPS 指定文件。",
    );
    process.exit(1);
  }
  const host = new AppHost({ relay, launcher, machineName, platform: platform() });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { host.stop(); process.exit(0); });
  }
  console.log(`ClawMe app host: ${machineName} (${machineId}) -> ${baseUrl}`);
  await host.start();
} else if (command === "shadow") {
  const cliPath = process.env.CLAWME_UU_RESCUE_BIN;
  if (!cliPath) {
    console.error("shadow 模式缺少 CLAWME_UU_RESCUE_BIN");
    process.exit(1);
  }
  const bridge = new ActionCliBridge({
    cwd,
    taskId: process.env.CLAWME_UU_RESCUE_TASK_ID,
    cliPath,
    provider: process.env.CLAWME_ACTION_PROVIDER || "uu-rescue",
  });
  await bridge.status(); // discovers the current task when none was configured
  const ownerTaskId = bridge.taskId;
  const relayTaskId = process.env.CLAWME_RELAY_TASK_ID
    || `uu-rescue:${machineId}:${ownerTaskId}`;

  // Also used to recover after a relay restart, so it re-reads the live owner
  // state rather than replaying whatever was true at agent startup.
  function heartbeat() {
    return relay.heartbeat({
      name: machineName,
      platform: platform(),
      agentVersion: "0.4.0",
      capabilities: [
        "shadowcore-owner",
        "checkpoint.create",
        "task-events",
        "owner-challenge",
      ],
    });
  }

  async function register() {
    const current = await bridge.status();
    await heartbeat();
    await relay.upsertTask({
      id: relayTaskId,
      provider: "uu-rescue",
      title: current.title,
      status: relayStatus(current.state),
      summary: current.next_step,
      metadata: { owner_task_id: ownerTaskId },
    });
  }

  await register();

  const worker = new ShadowWorker({ relay, bridge, relayTaskId, register, heartbeat });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => worker.stop());
  }
  console.log("ClawMe 已连接 UURescue 动作核心");
  console.log(`任务 ID: ${relayTaskId}`);
  console.log(`Owner 任务: ${ownerTaskId}`);
  await worker.start();
  process.exit(0);
}

function codexHeartbeat() {
  return relay.heartbeat({
    name: machineName,
    platform: platform(),
    agentVersion: "0.4.0",
    capabilities: ["codex-native", "approval", "task-events"],
  });
}

await codexHeartbeat();
// Keep "last seen" moving; a stamp frozen at startup makes the duty desk show
// a machine that may have been offline for hours as online.
const heartbeatTimer = setInterval(() => {
  codexHeartbeat().catch((error) => console.error("[agent] 心跳失败:", error.message));
}, 30_000);
heartbeatTimer.unref();

const adapter = new CodexAdapter({
  relay,
  cwd,
  prompt: rest.join(" "),
  model: process.env.CLAWME_MODEL,
  codexCommand: process.env.CLAWME_CODEX_PATH || "codex",
});

const session = await adapter.start();
console.log(`ClawMe 已接管 Codex 原生会话`);
console.log(`任务 ID: ${session.taskId}`);
console.log(`手机值班台: ${baseUrl.replace("api.", "www.")}/app.html`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(heartbeatTimer);
    adapter.stop();
    process.exit(0);
  });
}
