#!/usr/bin/env node
import { hostname, platform } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { RelayClient } from "./relay-client.mjs";
import { CodexAdapter } from "./codex-adapter.mjs";
import { ShadowWorker } from "./shadow-worker.mjs";
import { UuRescueBridge } from "./uurescue-bridge.mjs";

function usage() {
  console.log(`
ClawMe Agent v0.4

用法:
  npm start -- run "让 Codex 完成的任务"
  npm start -- shadow

环境变量:
  CLAWME_BASE_URL       Relay 地址，例如 https://api.clawme.net
  CLAWME_TOKEN          配对 Token
  CLAWME_CWD            Codex 工作目录，默认当前目录
  CLAWME_MODEL          可选，指定 Codex 模型
  CLAWME_MACHINE_ID     可选，覆盖自动生成的设备 ID
  CLAWME_UU_RESCUE_BIN  shadow 模式必填，UURescue 的 bin/uu-rescue.js
  CLAWME_UU_RESCUE_TASK_ID  可选，默认使用当前 UURescue 任务
  CLAWME_RELAY_TASK_ID  可选，覆盖 Relay 内的影核任务 ID
`);
}

const [, , command, ...rest] = process.argv;
if (!["run", "shadow"].includes(command) || (command === "run" && rest.length === 0)) {
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

if (command === "shadow") {
  const cliPath = process.env.CLAWME_UU_RESCUE_BIN;
  if (!cliPath) {
    console.error("shadow 模式缺少 CLAWME_UU_RESCUE_BIN");
    process.exit(1);
  }
  const bridge = new UuRescueBridge({
    cwd,
    taskId: process.env.CLAWME_UU_RESCUE_TASK_ID,
    cliPath,
  });
  await bridge.status(); // discovers the current task when none was configured
  const ownerTaskId = bridge.taskId;
  const relayTaskId = process.env.CLAWME_RELAY_TASK_ID
    || `uu-rescue:${machineId}:${ownerTaskId}`;

  // Also used to recover after a relay restart, so it re-reads the live owner
  // state rather than replaying whatever was true at agent startup.
  async function register() {
    const current = await bridge.status();
    await relay.heartbeat({
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

  const worker = new ShadowWorker({ relay, bridge, relayTaskId, register });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => worker.stop());
  }
  console.log("ClawMe 已连接 UURescue 动作核心");
  console.log(`任务 ID: ${relayTaskId}`);
  console.log(`Owner 任务: ${ownerTaskId}`);
  await worker.start();
  process.exit(0);
}

await relay.heartbeat({
  name: machineName,
  platform: platform(),
  agentVersion: "0.4.0",
  capabilities: ["codex-native", "approval", "task-events"],
});

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
    adapter.stop();
    process.exit(0);
  });
}
