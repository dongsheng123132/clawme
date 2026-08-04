// 影核信封 fixture 生成器。
//
// 它跑一遍真实的 relay 闭环（注册机器 → 建任务 → 手机请求挑战 → owner 签发 →
// 手机确认 → owner 回结果），把途中产生的**真实**信封落到 fixtures/shadowcore/。
//
// 为什么要这么做：iOS、Android 和后端各写一份"我以为的线上格式"，就会漂三份
// （宪法 #8）。让三端读同一批由后端亲自吐出来的信封，格式一改，所有端一起红。
//
//   node scripts/emit-shadow-fixtures.mjs          # 写入 fixtures/
//   node scripts/emit-shadow-fixtures.mjs --check  # 只比对，有漂移退出码 1

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { V3Store } from "../dist/v3-store.js";

const backendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(backendRoot);
const fixtureDir = path.join(repoRoot, "fixtures", "shadowcore");

const CONTROLLER = { id: "phone-device-1", kind: "device", surface: "android" };
const MACHINE_ID = "pc-shadow";
const TASK_ID = "shadow-task";
const OWNER_TASK_ID = "owner-task-7";

/** 时间和 UUID 每次都不同；固定成占位符，fixture 才能逐字比对。 */
const STABLE_TIME = "2026-01-01T00:00:00.000Z";
const TIME_KEYS = new Set([
  "sent_at", "occurred_at", "createdAt", "updatedAt", "lastSeenAt",
  "challenge_issued_at", "challenge_expires_at", "issued_at", "expires_at",
  "confirmed_at", "decidedAt",
]);

function normalize(value, replacements, key = "") {
  if (typeof value === "string") {
    if (TIME_KEYS.has(key)) return STABLE_TIME;
    return replacements.get(value) ?? value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, normalize(item, replacements, field)]),
    );
  }
  return value;
}

async function generate() {
  const dir = await mkdtemp(path.join(tmpdir(), "clawme-fixture-"));
  const store = new V3Store(path.join(dir, "relay.json"));
  await store.load();

  try {
    store.heartbeat({
      id: MACHINE_ID,
      name: "Owner PC",
      platform: "win32",
      agentVersion: "0.4.0",
      capabilities: ["checkpoint.create"],
    });
    store.upsertTask({
      id: TASK_ID,
      machineId: MACHINE_ID,
      provider: "uu-rescue",
      title: "Save a handoff checkpoint",
      status: "running",
      summary: "Codex 正在续写第 3 节",
      metadata: { owner_task_id: OWNER_TASK_ID },
    });

    // 1. 基线快照：手机第一次连上时看到的东西。
    const snapshot = store.syncTask(TASK_ID);

    // 2. 一段普通的任务推进，产出 delta。
    store.addEvent(TASK_ID, { type: "task.progress", message: "已完成 3/8 段", status: "running" });
    store.addEvent(TASK_ID, { type: "task.progress", message: "已完成 5/8 段" });
    const progressDelta = store.syncTask(TASK_ID, snapshot.payload.cursor);

    // 3. 手机请求 owner 签发挑战。
    const queued = store.requestCheckpointChallenge({
      taskId: TASK_ID,
      actor: CONTROLLER,
      reason: "手机确认保存当前接班点",
      confirmationMode: "biometric",
      requestKey: "phone-request-1",
    });
    const requestId = queued.command.id;

    const issuedAt = new Date(Date.now() - 1000).toISOString();
    const expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
    store.completeCommand(requestId, MACHINE_ID, {
      ok: true,
      challenge: {
        challenge_id: "challenge-owner-1",
        action_id: "checkpoint.create",
        actor: queued.command.payload.actor,
        mode: "biometric",
        input_sha256: "a".repeat(64),
        expected_state_version: 4,
        issued_at: issuedAt,
        expires_at: expiresAt,
      },
    });
    const challengeDelta = store.syncTask(TASK_ID, progressDelta.payload.cursor);

    // 4. 手机确认 → owner 执行 → 结果回到同一条游标流。
    const confirmed = store.confirmCheckpointChallenge({
      taskId: TASK_ID,
      requestId,
      actor: CONTROLLER,
      confirmedAt: new Date().toISOString(),
    });
    const executeCommandId = confirmed.command.id;
    const executionId = confirmed.command.payload.envelope.payload.execution_id;
    store.completeCommand(executeCommandId, MACHINE_ID, {
      ok: true,
      response: {
        protocol: "action-parity/sync@0.1",
        type: "sync.result",
        stream_id: `uu-rescue:task:${OWNER_TASK_ID}`,
        message_id: "owner-result-1",
        sent_at: new Date().toISOString(),
        payload: {
          action_id: "checkpoint.create",
          execution_id: executionId,
          ok: true,
          data: {
            checkpoint_id: "checkpoint-1",
            checkpoint_sha256: "b".repeat(64),
            handoff_ref: `uu-rescue:task:${OWNER_TASK_ID}:checkpoint:checkpoint-1`,
            task_state: "ready",
          },
          error: null,
          state_version: 7,
        },
      },
    });
    const resultDelta = store.syncTask(TASK_ID, challengeDelta.payload.cursor);

    // 把这一轮生成的随机 ID 映射成稳定名字。
    const replacements = new Map([
      [requestId, "request-1"],
      [executeCommandId, "command-1"],
      [executionId, "execution-1"],
    ]);
    for (const envelope of [snapshot, progressDelta, challengeDelta, resultDelta]) {
      for (const event of envelope.payload.events ?? []) {
        replacements.set(event.event_id, `event-${event.sequence}`);
      }
      replacements.set(envelope.message_id, "message-fixture");
    }

    return {
      "task-snapshot.json": normalize(snapshot, replacements),
      "task-progress-delta.json": normalize(progressDelta, replacements),
      "checkpoint-challenge-delta.json": normalize(challengeDelta, replacements),
      "checkpoint-result-delta.json": normalize(resultDelta, replacements),
    };
  } finally {
    // 先让挂起的落盘写完，否则删目录会让 relay 打出一条无关的持久化告警。
    await store.flush().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

const fixtures = await generate();

if (process.argv.includes("--check")) {
  const drifted = [];
  for (const [name, value] of Object.entries(fixtures)) {
    const current = await readFile(path.join(fixtureDir, name), "utf8").catch(() => null);
    if (current !== serialize(value)) drifted.push(name);
  }
  if (drifted.length) {
    console.error(`影核 fixture 已漂移：${drifted.join(", ")}`);
    console.error("跑 `node scripts/emit-shadow-fixtures.mjs` 重新生成，并确认各端仍能解析。");
    process.exit(1);
  }
  console.log(`影核 fixture 与 relay 输出一致（${Object.keys(fixtures).length} 份）`);
} else {
  await mkdir(fixtureDir, { recursive: true });
  for (const [name, value] of Object.entries(fixtures)) {
    await writeFile(path.join(fixtureDir, name), serialize(value), "utf8");
  }
  console.log(`已写入 ${Object.keys(fixtures).length} 份影核 fixture → ${fixtureDir}`);
}
