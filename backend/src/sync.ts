import { randomUUID } from "node:crypto";
import type { AttentionRequest, DutyTask, TaskEvent } from "./v3-types.js";

export const SYNC_PROTOCOL = "action-parity/sync@0.1";
const CURSOR_PREFIX = "cm1.";
const SENSITIVE_FIELD =
  /(^|_)(api_?key|token|secret|password|credential|authorization|cookie|command_?path|executable|cwd|path)$/i;

export class SyncCursorError extends Error {
  readonly code = "invalid_cursor";

  constructor(message: string) {
    super(message);
    this.name = "SyncCursorError";
  }
}

export function syncCursor(taskId: string, sequence: number): string {
  const encoded = Buffer.from(
    JSON.stringify({ task_id: taskId, sequence }),
    "utf8",
  ).toString("base64url");
  return `${CURSOR_PREFIX}${encoded}`;
}

export function syncSequence(cursor: string, taskId: string): number {
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new SyncCursorError("Cursor format is invalid");
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { task_id?: unknown; sequence?: unknown };
    if (
      value.task_id !== taskId
      || !Number.isSafeInteger(value.sequence)
      || Number(value.sequence) < 0
    ) {
      throw new Error("cursor mismatch");
    }
    return Number(value.sequence);
  } catch {
    throw new SyncCursorError("Cursor is damaged or belongs to another task");
  }
}

export function redactForSync(value: unknown, key = ""): unknown {
  if (SENSITIVE_FIELD.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactForSync(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([field, item]) => [field, redactForSync(item, field)]),
    );
  }
  return value;
}

function baseEnvelope(type: "sync.snapshot" | "sync.delta", taskId: string) {
  return {
    protocol: SYNC_PROTOCOL,
    type,
    stream_id: `clawme:task:${taskId}`,
    message_id: randomUUID(),
    sent_at: new Date().toISOString(),
  };
}

export function taskSnapshotEnvelope(
  task: DutyTask,
  attention: AttentionRequest[],
  head: number,
) {
  return {
    ...baseEnvelope("sync.snapshot", task.id),
    payload: {
      cursor: syncCursor(task.id, head),
      state_version: head,
      schema_version: "clawme.task@1",
      state: redactForSync({ task, attention }),
    },
  };
}

export function taskDeltaEnvelope(
  taskId: string,
  previousSequence: number,
  events: TaskEvent[],
  head: number,
) {
  const end = events.at(-1)?.sequence ?? previousSequence;
  return {
    ...baseEnvelope("sync.delta", taskId),
    payload: {
      previous_cursor: syncCursor(taskId, previousSequence),
      cursor: syncCursor(taskId, end),
      state_version: end,
      has_more: end < head,
      events: events.map((event) => ({
        event_id: event.id,
        sequence: event.sequence,
        kind: event.type,
        occurred_at: event.createdAt,
        entity: {
          type: "task",
          id: taskId,
        },
        payload: redactForSync({
          message: event.message,
          ...(event.data ?? {}),
        }),
      })),
    },
  };
}
