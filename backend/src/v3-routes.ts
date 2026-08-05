import type { Express, Request, Response } from "express";
import {
  getIdentityFromRequest,
  identityHasRole,
  identityOwnsMachine,
  isRootIdentity,
  type ClawMeIdentity,
  type IdentityKind,
  type IdentityRole,
} from "./auth.js";
import { DeviceError, type DeviceStore } from "./devices.js";
import type { AttentionRequest, DutyTask, Machine, MachineApp, TaskStatus } from "./v3-types.js";
import { V3Store } from "./v3-store.js";
import { SyncCursorError } from "./sync.js";
import { shadowActor, ShadowError } from "./shadow.js";

const TASK_STATUSES = new Set<TaskStatus>([
  "queued", "running", "waiting", "completed", "failed", "paused",
]);

function authorizedIdentity(
  req: Request,
  res: Response,
  roles: IdentityRole[],
): ClawMeIdentity | undefined {
  const identity = getIdentityFromRequest(req);
  if (!identity || !identityHasRole(identity, roles)) {
    res.status(401).json({ error: "Invalid identity or role" });
    return undefined;
  }
  return identity;
}

function ownsMachine(
  identity: ClawMeIdentity,
  machineId: string,
  res: Response,
): boolean {
  if (identityOwnsMachine(identity, machineId)) return true;
  res.status(403).json({ error: "Identity is not allowed to operate this machine" });
  return false;
}

function shadowFailure(error: unknown, res: Response): boolean {
  if (!(error instanceof ShadowError)) return false;
  res.status(error.status).json({
    error: error.code,
    message: error.message,
    ...(error.details ?? {}),
  });
  return true;
}

/** Root credentials only. A paired device must not be able to pair more devices. */
function rootIdentity(req: Request, res: Response): ClawMeIdentity | undefined {
  const identity = getIdentityFromRequest(req);
  if (!identity) {
    res.status(401).json({ error: "Invalid identity" });
    return undefined;
  }
  if (!isRootIdentity(identity)) {
    res.status(403).json({
      error: "root_credential_required",
      message: "Only a relay-configured credential may manage devices",
    });
    return undefined;
  }
  return identity;
}

function deviceFailure(error: unknown, res: Response): boolean {
  if (!(error instanceof DeviceError)) return false;
  res.status(error.status).json({ error: error.code, message: error.message });
  return true;
}

const DEVICE_KINDS = new Set<IdentityKind>(["user", "device", "agent", "service"]);
const DEVICE_ROLES = new Set<IdentityRole>(["controller", "owner"]);

export function installDeviceRoutes(app: Express, devices: DeviceStore): void {
  /** Mint a short-lived pairing code. The code is returned once and never again. */
  app.post("/v3/pairing/codes", (req, res) => {
    if (!rootIdentity(req, res)) return;
    const body = req.body as {
      name?: string;
      role?: string;
      surface?: string;
      actor_kind?: string;
      machine_ids?: unknown;
      ttl_seconds?: unknown;
    };
    const role = (body.role ?? "controller") as IdentityRole;
    const actorKind = (body.actor_kind ?? "device") as IdentityKind;
    if (!DEVICE_ROLES.has(role)) {
      return res.status(400).json({ error: "invalid_role", message: "role must be controller or owner" });
    }
    if (!DEVICE_KINDS.has(actorKind)) {
      return res.status(400).json({ error: "invalid_actor_kind" });
    }
    const ttlSeconds = Number(body.ttl_seconds ?? 300);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3600) {
      return res.status(400).json({
        error: "invalid_ttl",
        message: "ttl_seconds must be between 30 and 3600",
      });
    }
    try {
      const issued = devices.createPairingCode(
        {
          name: String(body.name ?? "").trim(),
          actorKind,
          ...(typeof body.surface === "string" && body.surface.trim()
            ? { surface: body.surface.trim() }
            : {}),
          role,
          machineIds: Array.isArray(body.machine_ids)
            ? body.machine_ids.filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
            : [],
        },
        ttlSeconds * 1000,
      );
      res.status(201).json(issued);
    } catch (error) {
      if (deviceFailure(error, res)) return;
      throw error;
    }
  });

  /**
   * Redeem a pairing code for a device token.
   *
   * Deliberately unauthenticated: the code IS the one-time credential, which is
   * the whole point — a new phone has nothing else yet. The store rate-limits
   * failures because the code is short enough to be typed by a human.
   */
  app.post("/v3/pairing/redeem", (req, res) => {
    try {
      const { token, device } = devices.redeemPairingCode(
        (req.body as { code?: unknown })?.code,
        (req.body as { device_name?: string })?.device_name,
      );
      res.status(201).json({
        token,
        device_id: device.id,
        actor_id: device.actorId,
        role: device.role,
        ...(device.surface ? { surface: device.surface } : {}),
        name: device.name,
      });
    } catch (error) {
      if (deviceFailure(error, res)) return;
      throw error;
    }
  });

  app.get("/v3/devices", (req, res) => {
    if (!rootIdentity(req, res)) return;
    res.json({ devices: devices.listDevices() });
  });

  /** Revocation takes effect on the next request. No restart, no config edit. */
  app.post("/v3/devices/:id/revoke", (req, res) => {
    if (!rootIdentity(req, res)) return;
    try {
      res.json({ device: devices.revokeDevice(req.params.id) });
    } catch (error) {
      if (deviceFailure(error, res)) return;
      throw error;
    }
  });
}

/**
 * owner 声明的可启动程序清单。
 *
 * 刻意只收 id / name / label / color：没有命令行、没有路径、没有图片。手机拿到的
 * 是身份和怎么画，不是怎么执行 —— 执行由 owner 从自己的白名单里查。
 */
function normalizeApps(value: unknown): MachineApp[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const apps: MachineApp[] = [];
  for (const item of value.slice(0, 60)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) continue;
    seen.add(id);
    apps.push({
      id,
      name: name.slice(0, 60),
      ...(typeof raw.label === "string" && raw.label.trim()
        ? { label: raw.label.trim().slice(0, 3) }
        : {}),
      ...(typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color.trim())
        ? { color: raw.color.trim() }
        : {}),
    });
  }
  return apps;
}

export function installV3Routes(app: Express, store: V3Store): void {
  app.post("/v3/machines/heartbeat", (req, res) => {
    const identity = authorizedIdentity(req, res, ["owner"]);
    if (!identity) return;
    const body = req.body as Partial<Machine>;
    if (!body.id || !body.name) return res.status(400).json({ error: "id and name are required" });
    if (!ownsMachine(identity, body.id, res)) return;
    const machine = store.heartbeat({
      id: body.id,
      name: body.name,
      platform: body.platform ?? "unknown",
      agentVersion: body.agentVersion ?? "unknown",
      capabilities: body.capabilities ?? [],
      apps: normalizeApps(body.apps),
    });
    res.json({ machine });
  });

  app.get("/v3/machines", (req, res) => {
    if (!authorizedIdentity(req, res, ["controller"])) return;
    res.json({ machines: store.listMachines() });
  });

  /**
   * 在 owner 电脑上启动一个它自己声明过的程序。
   *
   * 不走挑战确认：这是低风险、可逆的动作，配对本身就是授权。给每次启动都套一层
   * 生物识别，用户只会学会盲按确认 —— 那会稀释掉真正需要确认的写动作。
   */
  app.post("/v3/machines/:id/apps/:appId/launch", (req, res) => {
    if (!authorizedIdentity(req, res, ["controller"])) return;
    try {
      const command = store.launchApp(
        req.params.id,
        req.params.appId,
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined,
      );
      res.status(202).json({
        command_id: command.id,
        status: command.completedAt ? "completed" : "queued",
      });
    } catch (error) {
      if (shadowFailure(error, res)) return;
      throw error;
    }
  });

  /** 手机点完图标后短暂轮询这里，看 owner 到底开没开起来。 */
  app.get("/v3/commands/:id", (req, res) => {
    if (!authorizedIdentity(req, res, ["controller"])) return;
    const command = store.getCommand(req.params.id);
    if (!command) return res.status(404).json({ error: "Command not found" });
    res.json({
      command_id: command.id,
      type: command.type,
      status: command.completedAt ? "completed" : command.acknowledgedAt ? "acknowledged" : "queued",
      result: command.result ?? null,
    });
  });

  app.post("/v3/tasks", (req, res) => {
    const identity = authorizedIdentity(req, res, ["owner"]);
    if (!identity) return;
    const body = req.body as Partial<DutyTask>;
    if (!body.id || !body.machineId || !body.title || !body.provider || !body.status) {
      return res.status(400).json({ error: "id, machineId, provider, title and status are required" });
    }
    if (!TASK_STATUSES.has(body.status)) return res.status(400).json({ error: "invalid status" });
    if (!ownsMachine(identity, body.machineId, res)) return;
    const task = store.upsertTask({
      id: body.id,
      machineId: body.machineId,
      provider: body.provider,
      title: body.title,
      status: body.status,
      summary: body.summary,
      nativeThreadId: body.nativeThreadId,
      nativeTurnId: body.nativeTurnId,
      metadata: body.metadata,
    });
    res.status(201).json({ task });
  });

  app.get("/v3/tasks", (req, res) => {
    if (!authorizedIdentity(req, res, ["controller"])) return;
    res.json({ tasks: store.listTasks(Number(req.query.limit) || 50) });
  });

  app.get("/v3/tasks/:id", (req, res) => {
    if (!authorizedIdentity(req, res, ["controller"])) return;
    const task = store.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json({ task, events: store.listEvents(task.id) });
  });

  app.get("/v3/sync/tasks/:id", (req, res) => {
    if (!authorizedIdentity(req, res, ["controller"])) return;
    const rawLimit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 1000) {
      return res.status(400).json({ error: "limit must be an integer from 1 to 1000" });
    }
    try {
      const envelope = store.syncTask(
        req.params.id,
        req.query.after ? String(req.query.after) : undefined,
        rawLimit,
      );
      if (!envelope) return res.status(404).json({ error: "Task not found" });
      res.json(envelope);
    } catch (error) {
      if (error instanceof SyncCursorError) {
        return res.status(400).json({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  /**
   * 同一条游标流，改用长连接推。
   *
   * 轮询下 45% 的流量花在 HTTP 头上而不是内容上（backend/scripts/bandwidth-benchmark.mjs
   * 实测）。这里语义与 GET /v3/sync/tasks/:id 完全一致 —— 一样的信封、一样的
   * 不透明游标、一样的至少一次投递 —— 只是由 relay 在有变化时推给你，而不是你
   * 每三秒问一次。断线就退回轮询，游标不变，不需要第二套恢复规则。
   */
  app.get("/v3/sync/tasks/:id/stream", (req, res) => {
    if (!authorizedIdentity(req, res, ["controller"])) return;
    const task = store.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx 之类的反向代理默认会缓冲，缓冲了就不叫推送了。
      "X-Accel-Buffering": "no",
    });

    let cursor = req.query.after ? String(req.query.after) : undefined;
    let closed = false;
    let sending = false;

    const flush = () => {
      // 事件可能成串到达；同一时刻只跑一次，把能取的一次取完。
      if (closed || sending) return;
      sending = true;
      try {
        for (let page = 0; page < 20; page += 1) {
          const envelope = store.syncTask(req.params.id, cursor, 100);
          if (!envelope) break;
          cursor = envelope.payload.cursor;
          res.write(`event: sync\ndata: ${JSON.stringify(envelope)}\n\n`);
          if (!("has_more" in envelope.payload) || envelope.payload.has_more !== true) break;
        }
      } catch (error) {
        const code = error instanceof SyncCursorError ? error.code : "stream_failed";
        res.write(`event: error\ndata: ${JSON.stringify({ error: code })}\n\n`);
        closed = true;
        res.end();
      } finally {
        sending = false;
      }
    };

    // 先把游标之后欠的补齐，再进入等待 —— 否则连接建立瞬间发生的事件会漏掉。
    flush();
    const unsubscribe = store.subscribe(req.params.id, flush);

    // 空闲连接会被中间设备静默掐断，注释行是 SSE 规定的保活方式。
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": keep-alive\n\n");
    }, 25_000);

    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", stop);
    res.on("close", stop);
  });

  app.post("/v3/tasks/:id/events", (req, res) => {
    const identity = authorizedIdentity(req, res, ["owner"]);
    if (!identity) return;
    const task = store.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!ownsMachine(identity, task.machineId, res)) return;
    const body = req.body as { type?: string; message?: string; data?: Record<string, unknown>; status?: TaskStatus };
    if (!body.type) return res.status(400).json({ error: "type is required" });
    if (body.status && !TASK_STATUSES.has(body.status)) {
      return res.status(400).json({ error: "invalid status" });
    }
    res.status(201).json({ event: store.addEvent(req.params.id, {
      type: body.type, message: body.message, data: body.data, status: body.status,
    }) });
  });

  app.post("/v3/attention", (req, res) => {
    const identity = authorizedIdentity(req, res, ["owner"]);
    if (!identity) return;
    const body = req.body as Partial<AttentionRequest>;
    if (!body.taskId || !body.machineId || !body.kind || !body.title || !body.options?.length) {
      return res.status(400).json({ error: "taskId, machineId, kind, title and options are required" });
    }
    if (!store.getTask(body.taskId)) return res.status(404).json({ error: "Task not found" });
    if (!ownsMachine(identity, body.machineId, res)) return;
    const attention = store.addAttention({
      id: body.id,
      taskId: body.taskId,
      machineId: body.machineId,
      kind: body.kind,
      title: body.title,
      detail: body.detail,
      risk: body.risk,
      options: body.options,
      nativeRequestId: body.nativeRequestId,
      nativeMethod: body.nativeMethod,
      nativeParams: body.nativeParams,
    });
    res.status(201).json({ attention });
  });

  app.get("/v3/attention", (req, res) => {
    if (!authorizedIdentity(req, res, ["controller"])) return;
    res.json({ attention: store.listAttention(String(req.query.status ?? "pending")) });
  });

  app.post("/v3/attention/:id/decision", (req, res) => {
    if (!authorizedIdentity(req, res, ["controller"])) return;
    const { decision, note } = req.body as { decision?: string; note?: string };
    if (!decision) return res.status(400).json({ error: "decision is required" });
    const attention = store.decideAttention(req.params.id, decision, note);
    if (!attention) return res.status(409).json({ error: "Request already decided or invalid decision" });
    res.json({ attention });
  });

  app.post("/v3/tasks/:id/messages", (req, res) => {
    if (!authorizedIdentity(req, res, ["controller"])) return;
    const task = store.getTask(req.params.id);
    const text = String(req.body?.text ?? "").trim();
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!text) return res.status(400).json({ error: "text is required" });
    const command = store.addCommand({
      machineId: task.machineId,
      taskId: task.id,
      type: "user_message",
      payload: { text },
    });
    res.status(201).json({ command });
  });

  app.get("/v3/agent/commands", (req, res) => {
    const identity = authorizedIdentity(req, res, ["owner"]);
    if (!identity) return;
    const machineId = String(req.query.machineId ?? "");
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!ownsMachine(identity, machineId, res)) return;
    res.json({ commands: store.pendingCommands(machineId) });
  });

  app.post("/v3/agent/commands/:id/ack", (req, res) => {
    const identity = authorizedIdentity(req, res, ["owner"]);
    if (!identity) return;
    const machineId = String(req.body?.machineId ?? "");
    if (!ownsMachine(identity, machineId, res)) return;
    const command = store.acknowledgeCommand(req.params.id, machineId);
    if (!command) return res.status(404).json({ error: "Command not found" });
    res.json({ command });
  });

  app.post("/v3/tasks/:id/shadow/checkpoint-challenges", (req, res) => {
    const identity = authorizedIdentity(req, res, ["controller"]);
    if (!identity) return;
    try {
      const queued = store.requestCheckpointChallenge({
        taskId: req.params.id,
        actor: shadowActor(identity),
        reason: req.body?.reason,
        confirmationMode: req.body?.confirmation_mode,
        actionId: req.body?.action_id,
        requestKey: req.headers["idempotency-key"],
      });
      res.status(queued.created ? 202 : 200).json({
        request_id: queued.command.id,
        status: queued.command.completedAt ? "challenge_ready" : "pending",
        created: queued.created,
      });
    } catch (error) {
      if (shadowFailure(error, res)) return;
      throw error;
    }
  });

  app.post("/v3/tasks/:id/shadow/checkpoint-challenges/:requestId/confirm", (req, res) => {
    const identity = authorizedIdentity(req, res, ["controller"]);
    if (!identity) return;
    try {
      const queued = store.confirmCheckpointChallenge({
        taskId: req.params.id,
        requestId: req.params.requestId,
        actor: shadowActor(identity),
        confirmedAt: req.body?.confirmed_at,
      });
      res.status(queued.created ? 202 : 200).json({
        request_id: req.params.requestId,
        command_id: queued.command.id,
        status: queued.command.completedAt ? "completed" : "queued",
        created: queued.created,
      });
    } catch (error) {
      if (shadowFailure(error, res)) return;
      throw error;
    }
  });

  app.post("/v3/agent/commands/:id/result", (req, res) => {
    const identity = authorizedIdentity(req, res, ["owner"]);
    if (!identity) return;
    const machineId = String(req.body?.machineId ?? "");
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    if (!ownsMachine(identity, machineId, res)) return;
    if (!req.body?.result || typeof req.body.result !== "object") {
      return res.status(400).json({ error: "result is required" });
    }
    try {
      const command = store.completeCommand(req.params.id, machineId, req.body.result);
      if (!command) return res.status(404).json({ error: "Command not found" });
      res.json({ command });
    } catch (error) {
      if (shadowFailure(error, res)) return;
      throw error;
    }
  });

  app.get("/v3/agent/tasks/:id/shadow-cursor", (req, res) => {
    const identity = authorizedIdentity(req, res, ["owner"]);
    if (!identity) return;
    const task = store.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!ownsMachine(identity, task.machineId, res)) return;
    res.json({ cursor: store.getShadowCursor(task.id) ?? null });
  });

  app.post("/v3/agent/tasks/:id/shadow-delta", (req, res) => {
    const identity = authorizedIdentity(req, res, ["owner"]);
    if (!identity) return;
    const task = store.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!ownsMachine(identity, task.machineId, res)) return;
    try {
      res.json(store.importShadowDelta(task.id, req.body?.delta));
    } catch (error) {
      if (shadowFailure(error, res)) return;
      throw error;
    }
  });
}
