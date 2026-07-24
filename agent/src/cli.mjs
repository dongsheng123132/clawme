#!/usr/bin/env node
import { hostname, platform } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { RelayClient } from "./relay-client.mjs";
import { CodexAdapter } from "./codex-adapter.mjs";

function usage() {
  console.log(`
ClawMe Agent v0.3

用法:
  npm start -- run "让 Codex 完成的任务"

环境变量:
  CLAWME_BASE_URL       Relay 地址，例如 https://api.clawme.net
  CLAWME_TOKEN          配对 Token
  CLAWME_CWD            Codex 工作目录，默认当前目录
  CLAWME_MODEL          可选，指定 Codex 模型
  CLAWME_MACHINE_ID     可选，覆盖自动生成的设备 ID
`);
}

const [, , command, ...rest] = process.argv;
if (command !== "run" || rest.length === 0) {
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

await relay.heartbeat({
  name: machineName,
  platform: platform(),
  agentVersion: "0.3.0",
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
