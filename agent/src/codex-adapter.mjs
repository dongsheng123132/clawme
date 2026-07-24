import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:os";
import { JsonRpcConnection } from "./json-rpc.mjs";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

function labelDecision(value) {
  if (value === "accept") return "允许一次";
  if (value === "acceptForSession") return "本次会话允许";
  if (value === "decline") return "拒绝";
  if (value === "cancel") return "取消任务";
  return String(value);
}

function approvalOptions(params) {
  const decisions = (params.availableDecisions ?? ["accept", "decline"])
    .filter((item) => typeof item === "string");
  const safe = decisions.filter((item) =>
    ["accept", "acceptForSession", "decline", "cancel"].includes(item));
  return (safe.length ? safe : ["accept", "decline"]).map((id) => ({
    id,
    label: labelDecision(id),
    tone: id === "accept" ? "primary" : id === "decline" ? "danger" : "neutral",
  }));
}

function approvalTitle(method, params) {
  if (method === "item/fileChange/requestApproval") return "Codex 请求修改文件";
  return "Codex 请求执行命令";
}

function approvalDetail(method, params) {
  if (method === "item/fileChange/requestApproval") {
    return params.reason || (params.grantRoot ? `写入目录：${params.grantRoot}` : "需要写入项目文件");
  }
  return [params.command, params.cwd ? `目录：${params.cwd}` : ""].filter(Boolean).join("\n");
}

function resolveCodexCommand(requested) {
  if (requested !== "codex" || platform() !== "win32") return requested;
  const npmArch = arch() === "arm64" ? "arm64" : "x64";
  const rustArch = npmArch === "arm64" ? "aarch64" : "x86_64";
  const npmBinary = process.env.APPDATA && join(
    process.env.APPDATA,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    `codex-win32-${npmArch}`,
    "vendor",
    `${rustArch}-pc-windows-msvc`,
    "bin",
    "codex.exe",
  );
  if (npmBinary && existsSync(npmBinary)) return npmBinary;
  const found = spawnSync("where.exe", ["codex.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const executable = found.stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith("\\codex.exe"));
  return executable || requested;
}

export class CodexAdapter {
  constructor({ relay, cwd, prompt, model, codexCommand = "codex" }) {
    this.relay = relay;
    this.cwd = cwd;
    this.prompt = prompt;
    this.model = model;
    this.codexCommand = codexCommand;
    this.taskId = randomUUID();
    this.pendingApprovals = new Map();
    this.stopped = false;
  }

  async start() {
    const executable = resolveCodexCommand(this.codexCommand);
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.rpc = new JsonRpcConnection(child);
    this.rpc.onRequest((message) => this.handleServerRequest(message));
    this.rpc.onNotification((message) => this.handleNotification(message));

    await this.rpc.request("initialize", {
      clientInfo: { name: "clawme-agent", title: "ClawMe Agent", version: "0.3.0" },
      capabilities: null,
    });
    this.rpc.notify("initialized");

    const started = await this.rpc.request("thread/start", {
      cwd: this.cwd,
      model: this.model || null,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ephemeral: false,
    });
    this.threadId = started.thread.id;

    await this.relay.upsertTask({
      id: this.taskId,
      provider: "codex",
      title: this.prompt.slice(0, 80),
      status: "queued",
      nativeThreadId: this.threadId,
      metadata: { cwd: this.cwd, model: started.model },
    });

    const turn = await this.rpc.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: this.prompt, text_elements: [] }],
    });
    this.turnId = turn.turn.id;
    await this.relay.upsertTask({
      id: this.taskId,
      provider: "codex",
      title: this.prompt.slice(0, 80),
      status: "running",
      nativeThreadId: this.threadId,
      nativeTurnId: this.turnId,
      metadata: { cwd: this.cwd, model: started.model },
    });

    this.pollTimer = setInterval(() => this.pollCommands(), 1500);
    await this.relay.addEvent(this.taskId, {
      type: "turn_started",
      status: "running",
      message: "Codex 已开始执行",
    });
    return { taskId: this.taskId, threadId: this.threadId, turnId: this.turnId };
  }

  async handleServerRequest(message) {
    if (!APPROVAL_METHODS.has(message.method)) {
      this.rpc.respondError(message.id, -32601, `ClawMe v0.3 does not handle ${message.method} yet`);
      return;
    }

    const params = message.params ?? {};
    const attention = await this.relay.addAttention({
      taskId: this.taskId,
      kind: "approval",
      title: approvalTitle(message.method, params),
      detail: approvalDetail(message.method, params),
      risk: params.reason || undefined,
      options: approvalOptions(params),
      nativeRequestId: message.id,
      nativeMethod: message.method,
      nativeParams: params,
    });
    this.pendingApprovals.set(String(attention.attention.id), {
      rpcId: message.id,
      method: message.method,
    });
    await this.relay.addEvent(this.taskId, {
      type: "approval_requested",
      status: "waiting",
      message: attention.attention.title,
    });
  }

  async pollCommands() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const command of await this.relay.getCommands()) {
        if (command.type === "attention_decision") {
          const pending = this.pendingApprovals.get(String(command.payload.attentionId));
          if (pending) {
            this.rpc.respond(pending.rpcId, { decision: command.payload.decision });
            this.pendingApprovals.delete(String(command.payload.attentionId));
            await this.relay.addEvent(this.taskId, {
              type: "approval_decided",
              status: "running",
              message: `手机决定：${labelDecision(command.payload.decision)}`,
            });
          }
        } else if (command.type === "user_message" && command.taskId === this.taskId) {
          await this.rpc.request("turn/steer", {
            threadId: this.threadId,
            expectedTurnId: this.turnId,
            input: [{ type: "text", text: String(command.payload.text), text_elements: [] }],
          });
        }
        await this.relay.acknowledge(command.id);
      }
    } catch (error) {
      console.error("[agent] command polling failed:", error.message);
    } finally {
      this.polling = false;
    }
  }

  async handleNotification(message) {
    const params = message.params ?? {};
    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      await this.relay.addEvent(this.taskId, {
        type: "agent_message",
        message: params.item.text?.slice(0, 1000),
        data: { itemId: params.item.id },
      });
      return;
    }
    if (message.method === "error") {
      await this.relay.addEvent(this.taskId, {
        type: "error",
        status: params.willRetry ? "running" : "failed",
        message: params.error?.message || "Codex 执行出错",
        data: params,
      });
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      await this.relay.addEvent(this.taskId, {
        type: "rate_limits_updated",
        message: "模型限额状态已更新",
        data: params,
      });
      return;
    }
    if (message.method === "turn/completed" && params.turn?.id === this.turnId) {
      const failed = params.turn.status === "failed";
      await this.relay.addEvent(this.taskId, {
        type: "turn_completed",
        status: failed ? "failed" : "completed",
        message: failed
          ? params.turn.error?.message || "Codex 任务失败"
          : "Codex 任务已完成",
        data: { status: params.turn.status, durationMs: params.turn.durationMs },
      });
      this.stop();
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.pollTimer);
    this.child?.kill();
  }
}
