import type { Express, Request, Response } from "express";
import { getTokenFromRequest, isTokenAllowed } from "./auth.js";
import type { AttentionRequest, DutyTask, Machine, TaskStatus } from "./v3-types.js";
import { V3Store } from "./v3-store.js";
import { SyncCursorError } from "./sync.js";

const TASK_STATUSES = new Set<TaskStatus>([
  "queued", "running", "waiting", "completed", "failed", "paused",
]);

function authorized(req: Request, res: Response): string | undefined {
  const token = getTokenFromRequest(req) ?? (req.query.token as string | undefined) ?? null;
  if (!isTokenAllowed(token)) {
    res.status(401).json({ error: "Invalid or missing token" });
    return undefined;
  }
  return token!;
}

export function installV3Routes(app: Express, store: V3Store): void {
  app.post("/v3/machines/heartbeat", (req, res) => {
    if (!authorized(req, res)) return;
    const body = req.body as Partial<Machine>;
    if (!body.id || !body.name) return res.status(400).json({ error: "id and name are required" });
    const machine = store.heartbeat({
      id: body.id,
      name: body.name,
      platform: body.platform ?? "unknown",
      agentVersion: body.agentVersion ?? "unknown",
      capabilities: body.capabilities ?? [],
    });
    res.json({ machine });
  });

  app.get("/v3/machines", (req, res) => {
    if (!authorized(req, res)) return;
    res.json({ machines: store.listMachines() });
  });

  app.post("/v3/tasks", (req, res) => {
    if (!authorized(req, res)) return;
    const body = req.body as Partial<DutyTask>;
    if (!body.id || !body.machineId || !body.title || !body.provider || !body.status) {
      return res.status(400).json({ error: "id, machineId, provider, title and status are required" });
    }
    if (!TASK_STATUSES.has(body.status)) return res.status(400).json({ error: "invalid status" });
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
    if (!authorized(req, res)) return;
    res.json({ tasks: store.listTasks(Number(req.query.limit) || 50) });
  });

  app.get("/v3/tasks/:id", (req, res) => {
    if (!authorized(req, res)) return;
    const task = store.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json({ task, events: store.listEvents(task.id) });
  });

  app.get("/v3/sync/tasks/:id", (req, res) => {
    if (!authorized(req, res)) return;
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

  app.post("/v3/tasks/:id/events", (req, res) => {
    if (!authorized(req, res)) return;
    if (!store.getTask(req.params.id)) return res.status(404).json({ error: "Task not found" });
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
    if (!authorized(req, res)) return;
    const body = req.body as Partial<AttentionRequest>;
    if (!body.taskId || !body.machineId || !body.kind || !body.title || !body.options?.length) {
      return res.status(400).json({ error: "taskId, machineId, kind, title and options are required" });
    }
    if (!store.getTask(body.taskId)) return res.status(404).json({ error: "Task not found" });
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
    if (!authorized(req, res)) return;
    res.json({ attention: store.listAttention(String(req.query.status ?? "pending")) });
  });

  app.post("/v3/attention/:id/decision", (req, res) => {
    if (!authorized(req, res)) return;
    const { decision, note } = req.body as { decision?: string; note?: string };
    if (!decision) return res.status(400).json({ error: "decision is required" });
    const attention = store.decideAttention(req.params.id, decision, note);
    if (!attention) return res.status(409).json({ error: "Request already decided or invalid decision" });
    res.json({ attention });
  });

  app.post("/v3/tasks/:id/messages", (req, res) => {
    if (!authorized(req, res)) return;
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
    if (!authorized(req, res)) return;
    const machineId = String(req.query.machineId ?? "");
    if (!machineId) return res.status(400).json({ error: "machineId is required" });
    res.json({ commands: store.pendingCommands(machineId) });
  });

  app.post("/v3/agent/commands/:id/ack", (req, res) => {
    if (!authorized(req, res)) return;
    const machineId = String(req.body?.machineId ?? "");
    const command = store.acknowledgeCommand(req.params.id, machineId);
    if (!command) return res.status(404).json({ error: "Command not found" });
    res.json({ command });
  });
}
