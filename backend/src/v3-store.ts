import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentCommand,
  AttentionRequest,
  DutyTask,
  Machine,
  TaskEvent,
  TaskStatus,
  V3Snapshot,
} from "./v3-types.js";
import {
  SyncCursorError,
  syncSequence,
  taskDeltaEnvelope,
  taskSnapshotEnvelope,
} from "./sync.js";
import {
  buildCheckpointCommand,
  flattenShadowResult,
  normalizeMode,
  normalizeReason,
  normalizeRequestKey,
  ownerStreamId,
  ownerTaskId,
  resolveActionId,
  ShadowError,
  SHADOW_PROTOCOL,
  taskStatusFromOwnerEvent,
  validateChallengeResult,
  type ShadowActor,
} from "./shadow.js";

// Windows fails rename() with EPERM/EBUSY while an antivirus scanner, the search
// indexer or a backup agent still holds the destination handle. It clears in
// milliseconds, so a bounded retry keeps the atomic swap without a crash.
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;

async function renameAtomic(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

const EMPTY: V3Snapshot = {
  machines: [],
  tasks: [],
  events: [],
  eventHeads: {},
  attention: [],
  commands: [],
  shadowCursors: {},
};

export class V3Store {
  private data: V3Snapshot = structuredClone(EMPTY);
  private saveChain: Promise<void> = Promise.resolve();
  private lastPersistError: Error | undefined;

  constructor(private readonly filePath = process.env.CLAWME_DATA_FILE ?? "data/clawme-v3.json") {}

  private get tempPath(): string {
    return `${this.filePath}.tmp`;
  }

  private get backupPath(): string {
    return `${this.filePath}.bak`;
  }

  /**
   * Reads the newest snapshot that still parses. A write that dies mid-swap can
   * leave the main file missing or torn, so the previous good copy and the
   * pending temp file are tried in turn before giving up on the stored state.
   */
  private async readSnapshot(): Promise<Partial<V3Snapshot> | undefined> {
    const sources: Array<[string, string]> = [
      [this.filePath, ""],
      [this.backupPath, "主状态文件不可用，已回退到上一份备份"],
      [this.tempPath, "主状态文件和备份都不可用，已从未完成的临时文件恢复"],
    ];
    for (const [path, warning] of sources) {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        const parsed = JSON.parse(raw) as Partial<V3Snapshot>;
        if (warning) console.warn(`[clawme] ${warning}: ${path}`);
        return parsed;
      } catch {
        console.warn(`[clawme] 状态文件损坏，继续尝试下一份: ${path}`);
      }
    }
    return undefined;
  }

  async load(): Promise<void> {
    const parsed = await this.readSnapshot();
    if (parsed) {
      const derivedHeads: Record<string, number> = {};
      const events = (parsed.events ?? []).map((event) => {
        const previous = derivedHeads[event.taskId] ?? 0;
        const sequence = Number.isSafeInteger(event.sequence) && event.sequence > 0
          ? event.sequence
          : previous + 1;
        derivedHeads[event.taskId] = Math.max(previous, sequence);
        return { ...event, sequence };
      });
      const eventHeads = { ...derivedHeads };
      for (const [taskId, head] of Object.entries(parsed.eventHeads ?? {})) {
        if (Number.isSafeInteger(head) && head >= 0) {
          eventHeads[taskId] = Math.max(eventHeads[taskId] ?? 0, head);
        }
      }
      this.data = {
        machines: parsed.machines ?? [],
        tasks: parsed.tasks ?? [],
        events,
        eventHeads,
        attention: parsed.attention ?? [],
        commands: parsed.commands ?? [],
        shadowCursors: parsed.shadowCursors ?? {},
      };
    }
  }

  /**
   * Writes through a temp file and keeps the previous copy as a backup. Both
   * renames target a path that does not exist, because a replacing rename that
   * fails on Windows can remove the destination without moving the source —
   * which is how a single EPERM destroyed the whole relay state once.
   */
  private async writeSnapshot(body: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.tempPath, body, "utf8");
    await rm(this.backupPath, { force: true });
    try {
      await renameAtomic(this.filePath, this.backupPath);
    } catch (error) {
      // No main file yet on the very first write.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await renameAtomic(this.tempPath, this.filePath);
  }

  private persist(): void {
    const body = JSON.stringify(this.data, null, 2);
    // A rejected saveChain would both crash the relay on an unhandled rejection
    // and poison every later write, so each link resolves and reports instead.
    this.saveChain = this.saveChain.then(async () => {
      try {
        await this.writeSnapshot(body);
        this.lastPersistError = undefined;
      } catch (error) {
        this.lastPersistError = error as Error;
        console.error("[clawme] 持久化失败，relay 继续服务但状态未落盘:", error);
      }
    });
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }

  /** Set when the most recent write failed; cleared by the next successful write. */
  get persistError(): Error | undefined {
    return this.lastPersistError;
  }

  heartbeat(input: Omit<Machine, "lastSeenAt">): Machine {
    const now = new Date().toISOString();
    const existing = this.data.machines.find((item) => item.id === input.id);
    const machine = { ...input, lastSeenAt: now };
    if (existing) Object.assign(existing, machine);
    else this.data.machines.push(machine);
    this.persist();
    return machine;
  }

  listMachines(): Machine[] {
    return [...this.data.machines].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  upsertTask(input: Omit<DutyTask, "createdAt" | "updatedAt"> & { createdAt?: string }): DutyTask {
    const now = new Date().toISOString();
    const existing = this.data.tasks.find((item) => item.id === input.id);
    if (existing) {
      const changed =
        existing.status !== input.status
        || existing.summary !== input.summary
        || existing.nativeThreadId !== input.nativeThreadId
        || existing.nativeTurnId !== input.nativeTurnId;
      Object.assign(existing, input, { updatedAt: now });
      if (changed) {
        this.addEvent(existing.id, {
          type: "task.updated",
          data: {
            status: existing.status,
            summary: existing.summary,
          },
          status: existing.status,
        });
      } else {
        this.persist();
      }
      return existing;
    }
    const task: DutyTask = { ...input, createdAt: input.createdAt ?? now, updatedAt: now };
    this.data.tasks.push(task);
    this.addEvent(task.id, {
      type: "task.created",
      data: {
        provider: task.provider,
        title: task.title,
        status: task.status,
      },
      status: task.status,
    });
    return task;
  }

  listTasks(limit = 50): DutyTask[] {
    return [...this.data.tasks]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  getTask(id: string): DutyTask | undefined {
    return this.data.tasks.find((item) => item.id === id);
  }

  addEvent(
    taskId: string,
    input: Omit<TaskEvent, "id" | "taskId" | "sequence" | "createdAt">
      & { status?: TaskStatus },
  ): TaskEvent {
    const sequence = (this.data.eventHeads[taskId] ?? 0) + 1;
    const event: TaskEvent = {
      id: randomUUID(),
      taskId,
      sequence,
      type: input.type,
      message: input.message,
      data: input.data,
      createdAt: new Date().toISOString(),
    };
    this.data.eventHeads[taskId] = sequence;
    this.data.events.push(event);
    if (this.data.events.length > 5000) this.data.events = this.data.events.slice(-5000);
    const task = this.getTask(taskId);
    if (task) {
      if (input.status) task.status = input.status;
      if (input.message) task.summary = input.message;
      task.updatedAt = event.createdAt;
    }
    this.persist();
    return event;
  }

  listEvents(taskId: string): TaskEvent[] {
    return this.data.events
      .filter((item) => item.taskId === taskId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  syncTask(taskId: string, after?: string, limit = 100) {
    const task = this.getTask(taskId);
    if (!task) return undefined;
    const head = this.data.eventHeads[taskId] ?? 0;
    if (!after) {
      return taskSnapshotEnvelope(
        task,
        this.data.attention.filter((item) => item.taskId === taskId && item.status === "pending"),
        head,
      );
    }

    const sequence = syncSequence(after, taskId);
    if (sequence > head) {
      throw new SyncCursorError("Cursor is ahead of the task event stream");
    }
    const retained = this.listEvents(taskId);
    const earliest = retained[0]?.sequence ?? head + 1;
    if (sequence < earliest - 1) {
      return taskSnapshotEnvelope(
        task,
        this.data.attention.filter((item) => item.taskId === taskId && item.status === "pending"),
        head,
      );
    }
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const events = retained
      .filter((event) => event.sequence > sequence)
      .slice(0, safeLimit);
    return taskDeltaEnvelope(taskId, sequence, events, head);
  }

  addAttention(input: Omit<AttentionRequest, "id" | "status" | "createdAt"> & { id?: string }): AttentionRequest {
    const request: AttentionRequest = {
      ...input,
      id: input.id ?? randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.data.attention.push(request);
    const task = this.getTask(request.taskId);
    if (task) {
      task.status = "waiting";
      task.updatedAt = request.createdAt;
    }
    this.addEvent(request.taskId, {
      type: "attention.input_required",
      status: "waiting",
      data: {
        attention_id: request.id,
        kind: request.kind,
        title: request.title,
        risk: request.risk,
        options: request.options,
      },
    });
    return request;
  }

  listAttention(status = "pending"): AttentionRequest[] {
    return this.data.attention
      .filter((item) => status === "all" || item.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  decideAttention(id: string, decision: string, note?: string): AttentionRequest | undefined {
    const request = this.data.attention.find((item) => item.id === id);
    if (!request || request.status !== "pending") return undefined;
    if (!request.options.some((option) => option.id === decision)) return undefined;
    request.status = "decided";
    request.decision = decision;
    request.note = note;
    request.decidedAt = new Date().toISOString();
    this.addCommand({
      machineId: request.machineId,
      taskId: request.taskId,
      type: "attention_decision",
      payload: {
        attentionId: request.id,
        decision,
        note,
        nativeRequestId: request.nativeRequestId,
        nativeMethod: request.nativeMethod,
      },
    });
    this.addEvent(request.taskId, {
      type: "attention.decided",
      data: {
        attention_id: request.id,
        decision,
        note,
      },
    });
    return request;
  }

  addCommand(input: Omit<AgentCommand, "id" | "createdAt">): AgentCommand {
    const command: AgentCommand = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.data.commands.push(command);
    if (command.taskId) {
      this.addEvent(command.taskId, {
        type: "command.queued",
        data: {
          command_id: command.id,
          command_type: command.type,
        },
      });
    } else {
      this.persist();
    }
    return command;
  }

  pendingCommands(machineId: string): AgentCommand[] {
    return this.data.commands.filter(
      (item) => item.machineId === machineId && !item.acknowledgedAt,
    );
  }

  acknowledgeCommand(id: string, machineId: string): AgentCommand | undefined {
    const command = this.data.commands.find(
      (item) => item.id === id && item.machineId === machineId,
    );
    if (!command) return undefined;
    command.acknowledgedAt = new Date().toISOString();
    if (command.taskId) {
      this.addEvent(command.taskId, {
        type: "command.acknowledged",
        data: {
          command_id: command.id,
          command_type: command.type,
        },
      });
    } else {
      this.persist();
    }
    return command;
  }

  requestCheckpointChallenge(input: {
    taskId: string;
    actor: ShadowActor;
    reason: unknown;
    confirmationMode: unknown;
    requestKey: unknown;
    actionId?: unknown;
  }): { command: AgentCommand; created: boolean } {
    const task = this.getTask(input.taskId);
    if (!task) throw new ShadowError("task_not_found", "Task not found", 404);
    const machine = this.data.machines.find((item) => item.id === task.machineId);
    const actionId = resolveActionId(input.actionId, machine);
    const reason = normalizeReason(input.reason);
    const confirmationMode = normalizeMode(input.confirmationMode);
    const requestKey = normalizeRequestKey(input.requestKey);
    const existing = this.data.commands.find(
      (command) => command.type === "shadow_challenge"
        && command.taskId === task.id
        && command.payload.request_key === requestKey
        && (command.payload.actor as Record<string, unknown> | undefined)?.id === input.actor.id,
    );
    if (existing) {
      const previousInput = existing.payload.input as Record<string, unknown> | undefined;
      if (
        previousInput?.reason !== reason
        || existing.payload.confirmation_mode !== confirmationMode
        || existing.payload.action_id !== actionId
      ) {
        throw new ShadowError(
          "idempotency_key_reused",
          "Idempotency-Key cannot be reused for a different checkpoint request",
          409,
        );
      }
      return { command: existing, created: false };
    }

    const command = this.addCommand({
      machineId: task.machineId,
      taskId: task.id,
      type: "shadow_challenge",
      payload: {
        request_key: requestKey,
        action_id: actionId,
        owner_task_id: ownerTaskId(task),
        stream_id: ownerStreamId(task),
        actor: input.actor,
        confirmation_mode: confirmationMode,
        input: { reason },
      },
    });
    this.addEvent(task.id, {
      type: "sync.challenge.requested",
      data: {
        request_id: command.id,
        action_id: actionId,
        reason,
        confirmation_mode: confirmationMode,
        actor_id: input.actor.id,
      },
    });
    return { command, created: true };
  }

  confirmCheckpointChallenge(input: {
    taskId: string;
    requestId: string;
    actor: ShadowActor;
    confirmedAt: unknown;
  }): { command: AgentCommand; created: boolean } {
    const task = this.getTask(input.taskId);
    if (!task) throw new ShadowError("task_not_found", "Task not found", 404);
    const challengeRequest = this.data.commands.find(
      (command) => command.id === input.requestId
        && command.taskId === task.id
        && command.type === "shadow_challenge",
    );
    if (!challengeRequest) {
      throw new ShadowError("challenge_not_found", "Checkpoint challenge was not found", 404);
    }
    const requestActor = challengeRequest.payload.actor as Record<string, unknown> | undefined;
    if (
      requestActor?.id !== input.actor.id
      || requestActor.kind !== input.actor.kind
      || (requestActor.surface ?? null) !== (input.actor.surface ?? null)
    ) {
      throw new ShadowError(
        "challenge_actor_mismatch",
        "Checkpoint challenge belongs to another authenticated actor",
        403,
      );
    }
    if (!challengeRequest.result) {
      throw new ShadowError("challenge_pending", "Owner has not issued the challenge yet", 409);
    }
    const challenge = validateChallengeResult(challengeRequest, challengeRequest.result);
    if (!challenge) {
      throw new ShadowError("challenge_failed", "Owner could not issue the challenge", 409);
    }
    if (typeof input.confirmedAt !== "string") {
      throw new ShadowError("invalid_confirmation_time", "confirmed_at is required");
    }

    const existing = this.data.commands.find(
      (command) => command.type === "shadow_execute"
        && command.taskId === task.id
        && command.payload.challenge_request_id === challengeRequest.id,
    );
    if (existing) return { command: existing, created: false };

    const envelope = buildCheckpointCommand(challengeRequest, challenge, input.confirmedAt);
    const command = this.addCommand({
      machineId: task.machineId,
      taskId: task.id,
      type: "shadow_execute",
      payload: {
        challenge_request_id: challengeRequest.id,
        owner_task_id: ownerTaskId(task),
        envelope,
      },
    });
    this.addEvent(task.id, {
      type: "sync.command.confirmed",
      data: {
        request_id: challengeRequest.id,
        command_id: command.id,
        action_id: challengeRequest.payload.action_id,
        actor_id: input.actor.id,
      },
    });
    return { command, created: true };
  }

  completeCommand(
    id: string,
    machineId: string,
    result: Record<string, unknown>,
  ): AgentCommand | undefined {
    const command = this.data.commands.find(
      (item) => item.id === id && item.machineId === machineId,
    );
    if (!command) return undefined;
    if (command.result) return command;
    if (!["shadow_challenge", "shadow_execute"].includes(command.type)) {
      throw new ShadowError(
        "command_result_unsupported",
        "This command type does not accept an owner result",
        409,
      );
    }

    const completedAt = new Date().toISOString();
    let event: { kind: string; data: Record<string, unknown> };
    if (command.type === "shadow_challenge") {
      const challenge = validateChallengeResult(command, result);
      if (challenge) {
        const input = command.payload.input as Record<string, unknown>;
        event = {
          kind: "sync.challenge",
          data: {
            request_id: command.id,
            action_id: challenge.action_id,
            reason: input.reason,
            confirmation_mode: challenge.mode,
            challenge_id: challenge.challenge_id,
            expected_state_version: challenge.expected_state_version,
            challenge_issued_at: challenge.issued_at,
            challenge_expires_at: challenge.expires_at,
          },
        };
      } else {
        const error = result.error && typeof result.error === "object"
          ? result.error as Record<string, unknown>
          : {};
        event = {
          kind: "sync.challenge.failed",
          data: {
            request_id: command.id,
            action_id: command.payload.action_id,
            error_code: error.code ?? "owner_challenge_failed",
            error_message: error.message ?? "Owner could not issue a confirmation challenge",
          },
        };
      }
    } else {
      event = flattenShadowResult(command, result);
    }

    command.result = result;
    command.completedAt = completedAt;
    command.acknowledgedAt = completedAt;
    if (command.taskId) this.addEvent(command.taskId, { type: event.kind, data: event.data });
    else this.persist();
    return command;
  }

  getShadowCursor(taskId: string): string | undefined {
    return this.data.shadowCursors[taskId];
  }

  importShadowDelta(
    taskId: string,
    envelope: Record<string, unknown>,
  ): { imported: number; cursor: string; hasMore: boolean } {
    const task = this.getTask(taskId);
    if (!task) throw new ShadowError("task_not_found", "Task not found", 404);
    const expectedStream = ownerStreamId(task);
    if (
      envelope.protocol !== SHADOW_PROTOCOL
      || envelope.type !== "sync.delta"
      || envelope.stream_id !== expectedStream
    ) {
      throw new ShadowError(
        "shadow_delta_mismatch",
        "Owner delta does not belong to this task",
        409,
      );
    }
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (!payload || !Array.isArray(payload.events)) {
      throw new ShadowError("invalid_shadow_delta", "Owner delta payload is invalid");
    }
    if (payload.events.length > 1000) {
      throw new ShadowError("invalid_shadow_delta", "Owner delta exceeds 1000 events");
    }
    if (typeof payload.cursor !== "string" || typeof payload.previous_cursor !== "string") {
      throw new ShadowError("invalid_shadow_delta", "Owner delta cursors are required");
    }
    const previous = this.data.shadowCursors[taskId];
    if (previous && previous !== payload.previous_cursor) {
      throw new ShadowError(
        "shadow_cursor_conflict",
        "Relay already imported a different owner position",
        409,
        { current_cursor: previous },
      );
    }

    let imported = 0;
    for (const rawEvent of payload.events) {
      if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
        throw new ShadowError("invalid_shadow_delta", "Owner event is invalid");
      }
      const event = rawEvent as Record<string, unknown>;
      const entity = event.entity as Record<string, unknown> | undefined;
      const eventPayload = event.payload as Record<string, unknown> | undefined;
      if (
        typeof event.event_id !== "string"
        || !Number.isSafeInteger(event.sequence)
        || typeof event.kind !== "string"
        || entity?.id !== ownerTaskId(task)
        || !eventPayload
      ) {
        throw new ShadowError("invalid_shadow_delta", "Owner event fields are invalid");
      }
      const alreadyImported = this.data.events.some(
        (item) => item.taskId === taskId
          && item.data?.source_event_id === event.event_id
          && item.data?.source_stream_id === expectedStream,
      );
      if (alreadyImported) continue;
      this.addEvent(taskId, {
        type: event.kind,
        message: typeof eventPayload.message === "string" ? eventPayload.message : undefined,
        data: {
          ...eventPayload,
          source_event_id: event.event_id,
          source_sequence: event.sequence,
          source_stream_id: expectedStream,
        },
        status: taskStatusFromOwnerEvent(event.kind, eventPayload),
      });
      imported += 1;
    }
    this.data.shadowCursors[taskId] = payload.cursor;
    this.persist();
    return {
      imported,
      cursor: payload.cursor,
      hasMore: payload.has_more === true,
    };
  }
}
