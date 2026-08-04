// 影核动作同步 vs 屏幕流：流量对比基准。
//
// 诚实声明，两个数字的来源不一样，别混为一谈：
//
//   * 影核那一列是**实测**：真的建一个 relay，跑一段真实任务活动，
//     再按手机的轮询节奏逐次调 syncTask，把手机实际收到的信封字节数加起来。
//   * 屏幕流那一列是**按码率估算**：本脚本不测 UU 远程或任何第三方产品，
//     只是把"每秒 N 比特"乘以时长。码率档位是参数，可以按你自己的实测改。
//
//   node scripts/bandwidth-benchmark.mjs
//   node scripts/bandwidth-benchmark.mjs --minutes 30 --poll 3 --json
//   node scripts/bandwidth-benchmark.mjs --markdown   # 输出可贴进文档的表格

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { V3Store } from "../dist/v3-store.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= args.length) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};

const MINUTES = flag("minutes", 10);
const POLL_SECONDS = flag("poll", 3);
/**
 * 每个 HTTP 往返的头部开销估算（请求行 + 头 + 响应头，含 TLS 记录开销的粗略值）。
 * 空轮询时头部比正文还大，所以不算进去会把结论美化得不诚实。
 */
const HTTP_OVERHEAD_BYTES = flag("overhead", 350);

/** 屏幕流码率档位。这是估算参数，不是对任何产品的实测。 */
const SCREEN_PROFILES = [
  { id: "idle", label: "静止画面（高效编码器）", mbps: 0.3 },
  { id: "light", label: "轻度操作（滚动、切窗口）", mbps: 1.5 },
  { id: "active", label: "持续操作（打字、拖动）", mbps: 4.0 },
];

const TASK_ID = "bench-task";
const MACHINE_ID = "bench-pc";

/**
 * 造一段有代表性的 AI 任务活动。
 * 不是"什么都不发"的理想情况，而是带进度、带追问、带一次写动作确认的真实节奏。
 */
function buildTimeline(minutes) {
  const events = [];
  const totalSeconds = minutes * 60;

  // 每 20 秒一条进度：长任务里 agent 大致就是这个汇报密度。
  for (let t = 20; t < totalSeconds; t += 20) {
    events.push({
      at: t,
      run: (store) => store.addEvent(TASK_ID, {
        type: "task.progress",
        message: `已完成 ${Math.round((t / totalSeconds) * 100)}%`,
        status: "running",
      }),
    });
  }

  // 中途一次需要人拍板的追问。
  events.push({
    at: Math.floor(totalSeconds * 0.4),
    run: (store) => store.addAttention({
      taskId: TASK_ID,
      machineId: MACHINE_ID,
      kind: "approval",
      title: "要不要覆盖已存在的输出文件？",
      detail: "out/report.md 已存在",
      options: [
        { id: "overwrite", label: "覆盖", tone: "danger" },
        { id: "keep", label: "保留", tone: "neutral" },
      ],
    }),
  });

  // 一次完整的写动作：挑战 → 确认 → owner 回执。
  events.push({
    at: Math.floor(totalSeconds * 0.7),
    run: (store) => {
      const queued = store.requestCheckpointChallenge({
        taskId: TASK_ID,
        actor: { id: "phone-1", kind: "device", surface: "android" },
        reason: "手机确认保存当前接班点",
        confirmationMode: "biometric",
        requestKey: "bench-request-1",
      });
      store.completeCommand(queued.command.id, MACHINE_ID, {
        ok: true,
        challenge: {
          challenge_id: "bench-challenge",
          action_id: "checkpoint.create",
          actor: queued.command.payload.actor,
          mode: "biometric",
          input_sha256: "a".repeat(64),
          expected_state_version: 4,
          issued_at: new Date(Date.now() - 1000).toISOString(),
          expires_at: new Date(Date.now() + 240_000).toISOString(),
        },
      });
      const confirmed = store.confirmCheckpointChallenge({
        taskId: TASK_ID,
        requestId: queued.command.id,
        actor: { id: "phone-1", kind: "device", surface: "android" },
        confirmedAt: new Date().toISOString(),
      });
      store.completeCommand(confirmed.command.id, MACHINE_ID, {
        ok: true,
        response: {
          protocol: "action-parity/sync@0.1",
          type: "sync.result",
          stream_id: "uu-rescue:task:owner-1",
          message_id: "bench-result",
          sent_at: new Date().toISOString(),
          payload: {
            action_id: "checkpoint.create",
            execution_id: confirmed.command.payload.envelope.payload.execution_id,
            ok: true,
            data: { checkpoint_id: "cp-1", checkpoint_sha256: "b".repeat(64) },
            error: null,
            state_version: 7,
          },
        },
      });
    },
  });

  return events.sort((a, b) => a.at - b.at);
}

async function measureShadowCore() {
  const dir = await mkdtemp(path.join(tmpdir(), "clawme-bench-"));
  const store = new V3Store(path.join(dir, "relay.json"));
  await store.load();

  try {
    store.heartbeat({
      id: MACHINE_ID,
      name: "Bench PC",
      platform: "win32",
      agentVersion: "0.4.0",
      capabilities: ["checkpoint.create"],
    });
    store.upsertTask({
      id: TASK_ID,
      machineId: MACHINE_ID,
      provider: "uu-rescue",
      title: "长时间的代码重构任务",
      status: "running",
      metadata: { owner_task_id: "owner-1" },
    });

    const timeline = buildTimeline(MINUTES);
    let pending = 0;

    // 第一次连接：一份快照。之后全是增量。
    const snapshot = store.syncTask(TASK_ID);
    let cursor = snapshot.payload.cursor;
    let bodyBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    let requests = 1;
    let emptyPolls = 0;

    const totalSeconds = MINUTES * 60;
    for (let now = POLL_SECONDS; now <= totalSeconds; now += POLL_SECONDS) {
      while (pending < timeline.length && timeline[pending].at <= now) {
        timeline[pending].run(store);
        pending += 1;
      }
      const delta = store.syncTask(TASK_ID, cursor);
      cursor = delta.payload.cursor;
      bodyBytes += Buffer.byteLength(JSON.stringify(delta), "utf8");
      requests += 1;
      if ((delta.payload.events ?? []).length === 0) emptyPolls += 1;
    }

    return {
      measured: true,
      minutes: MINUTES,
      pollSeconds: POLL_SECONDS,
      requests,
      emptyPolls,
      bodyBytes,
      overheadBytes: requests * HTTP_OVERHEAD_BYTES,
      totalBytes: bodyBytes + requests * HTTP_OVERHEAD_BYTES,
    };
  } finally {
    await store.flush().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

function modelScreenStream(minutes) {
  return SCREEN_PROFILES.map((profile) => ({
    ...profile,
    modeled: true,
    totalBytes: Math.round((profile.mbps * 1_000_000 / 8) * minutes * 60),
  }));
}

const human = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const shadow = await measureShadowCore();
const screens = modelScreenStream(MINUTES);
const report = {
  minutes: MINUTES,
  poll_seconds: POLL_SECONDS,
  shadowcore: shadow,
  screen_stream_models: screens.map((item) => ({
    ...item,
    ratio_vs_shadowcore: Number((item.totalBytes / shadow.totalBytes).toFixed(1)),
  })),
};

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else if (args.includes("--markdown")) {
  console.log(`| 方案 | ${MINUTES} 分钟总流量 | 相对影核 | 数据来源 |`);
  console.log("| --- | --- | --- | --- |");
  console.log(
    `| **影核动作同步**（轮询 ${POLL_SECONDS}s） | **${human(shadow.totalBytes)}** | 1× | 实测 |`,
  );
  for (const item of report.screen_stream_models) {
    console.log(
      `| 屏幕流 · ${item.label} ${item.mbps} Mbps | ${human(item.totalBytes)} | ${item.ratio_vs_shadowcore}× | 按码率估算 |`,
    );
  }
} else {
  console.log(`ClawMe 流量基准 · ${MINUTES} 分钟任务会话 · 轮询间隔 ${POLL_SECONDS}s\n`);
  console.log("影核动作同步（实测）");
  console.log(`  请求数        ${shadow.requests}（其中 ${shadow.emptyPolls} 次无新事件）`);
  console.log(`  信封正文      ${human(shadow.bodyBytes)}`);
  console.log(`  HTTP 头开销   ${human(shadow.overheadBytes)}（按每次 ${HTTP_OVERHEAD_BYTES} B 估算）`);
  console.log(`  合计          ${human(shadow.totalBytes)}`);
  console.log(`  折合          ${human(shadow.totalBytes / MINUTES)}/分钟\n`);
  console.log("屏幕流（按码率估算，非对第三方产品的实测）");
  for (const item of report.screen_stream_models) {
    console.log(
      `  ${item.label.padEnd(22)} ${String(item.mbps).padStart(4)} Mbps  ` +
        `${human(item.totalBytes).padStart(10)}  ${item.ratio_vs_shadowcore}× 影核`,
    );
  }
  const overheadShare = shadow.overheadBytes / shadow.totalBytes;
  if (overheadShare > 0.4) {
    console.log(
      `\n注意：${(overheadShare * 100).toFixed(0)}% 的流量花在了轮询的 HTTP 头上，` +
        `不是内容本身。\n换成 SSE 长连接或推送唤醒还能再降一个量级 —— 这是下一步该做的事。`,
    );
  }
}
