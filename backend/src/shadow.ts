import { randomUUID } from "node:crypto";
import type { ClawMeIdentity } from "./auth.js";
import type { AgentCommand, DutyTask, Machine, TaskStatus } from "./v3-types.js";

export const SHADOW_PROTOCOL = "action-parity/sync@0.1";
export const SHADOW_ACTION = "checkpoint.create";
export const LEGACY_SHADOW_CAPABILITY = "shadowcore-owner";
export const SHADOW_MODES = new Set(["explicit", "biometric", "system"]);

export class ShadowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ShadowError";
  }
}

export interface ShadowActor {
  id: string;
  kind: string;
  surface?: string;
}

export function shadowActor(identity: ClawMeIdentity): ShadowActor {
  return {
    id: identity.actorId,
    kind: identity.actorKind,
    ...(identity.surface ? { surface: identity.surface } : {}),
  };
}

export function ownerTaskId(task: DutyTask): string {
  const configured = task.metadata?.owner_task_id;
  if (typeof configured === "string" && configured.trim()) return configured;
  return task.id;
}

/** The owner's event stream for this task. The provider names it, not the relay. */
export function ownerStreamId(task: DutyTask): string {
  return `${task.provider}:task:${ownerTaskId(task)}`;
}

/**
 * The relay routes an action; it never decides that one exists. A machine only
 * receives actions its agent declared, which is what stops this from becoming a
 * second implementation of anyone's action core.
 */
export function resolveActionId(value: unknown, machine: Machine | undefined): string {
  const actionId = value === undefined || value === null ? SHADOW_ACTION : value;
  if (typeof actionId !== "string" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(actionId)) {
    throw new ShadowError("invalid_action_id", "action_id is not a valid Action ID");
  }
  if (!machine) {
    throw new ShadowError("machine_not_found", "This task's machine is not registered", 409);
  }
  // Agents on customer machines upgrade later than the relay. One that only
  // declares the legacy ShadowCore capability keeps its checkpoint action;
  // anything beyond that has to be declared explicitly.
  const declared = machine.capabilities.includes(actionId)
    || (actionId === SHADOW_ACTION && machine.capabilities.includes(LEGACY_SHADOW_CAPABILITY));
  if (!declared) {
    throw new ShadowError(
      "shadow_action_unavailable",
      `${machine.id} does not declare ${actionId}`,
      409,
      { declared: machine.capabilities },
    );
  }
  return actionId;
}

export function normalizeReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ShadowError("invalid_reason", "reason is required");
  }
  const reason = value.trim();
  if (reason.length > 500) {
    throw new ShadowError("invalid_reason", "reason must be at most 500 characters");
  }
  return reason;
}

export function normalizeMode(value: unknown): string {
  const mode = typeof value === "string" ? value : "explicit";
  if (!SHADOW_MODES.has(mode)) {
    throw new ShadowError("invalid_confirmation_mode", "confirmation_mode is invalid");
  }
  return mode;
}

export function normalizeRequestKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new ShadowError(
      "invalid_idempotency_key",
      "Idempotency-Key must be a non-empty string of at most 200 characters",
    );
  }
  return value.trim();
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShadowError("invalid_owner_result", `${field} must be an object`, 502);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ShadowError("invalid_owner_result", `${field} is required`, 502);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ShadowError("invalid_owner_result", `${field} must be a non-negative integer`, 502);
  }
  return Number(value);
}

export function validateChallengeResult(
  command: AgentCommand,
  result: Record<string, unknown>,
): Record<string, unknown> | null {
  if (result.ok === false) return null;
  if (result.ok !== true) {
    throw new ShadowError("invalid_owner_result", "owner challenge result must include ok", 502);
  }
  const challenge = record(result.challenge, "challenge");
  const expected = command.payload;
  const actor = record(challenge.actor, "challenge.actor");
  const expectedActor = record(expected.actor, "command.actor");
  if (
    challenge.action_id !== expected.action_id
    || actor.id !== expectedActor.id
    || actor.kind !== expectedActor.kind
    || (actor.surface ?? null) !== (expectedActor.surface ?? null)
    || challenge.mode !== expected.confirmation_mode
  ) {
    throw new ShadowError(
      "owner_challenge_mismatch",
      "owner challenge does not match the authenticated request",
      502,
    );
  }
  requiredString(challenge.challenge_id, "challenge.challenge_id");
  requiredString(challenge.input_sha256, "challenge.input_sha256");
  requiredString(challenge.issued_at, "challenge.issued_at");
  requiredString(challenge.expires_at, "challenge.expires_at");
  requiredInteger(challenge.expected_state_version, "challenge.expected_state_version");
  return challenge;
}

export function buildCheckpointCommand(
  challengeRequest: AgentCommand,
  challenge: Record<string, unknown>,
  confirmedAt: string,
): Record<string, unknown> {
  const confirmed = Date.parse(confirmedAt);
  const issued = Date.parse(String(challenge.issued_at));
  const expires = Date.parse(String(challenge.expires_at));
  const now = Date.now();
  if (
    !Number.isFinite(confirmed)
    || !Number.isFinite(issued)
    || !Number.isFinite(expires)
    || confirmed < issued - 30_000
    || confirmed > now + 30_000
    || now >= expires
  ) {
    throw new ShadowError(
      "confirmation_expired",
      "The owner challenge is expired or the confirmation time is invalid",
      409,
    );
  }

  return {
    protocol: SHADOW_PROTOCOL,
    type: "sync.command",
    stream_id: challengeRequest.payload.stream_id,
    message_id: randomUUID(),
    sent_at: new Date().toISOString(),
    payload: {
      action_id: challengeRequest.payload.action_id,
      execution_id: `clawme-${randomUUID()}`,
      idempotency_key: `clawme:${challengeRequest.id}`,
      actor: challengeRequest.payload.actor,
      expected_state_version: challenge.expected_state_version,
      expires_at: challenge.expires_at,
      confirmation: {
        mode: challengeRequest.payload.confirmation_mode,
        challenge_id: challenge.challenge_id,
        confirmed_at: confirmedAt,
      },
      input: challengeRequest.payload.input,
    },
  };
}

export function taskStatusFromOwnerEvent(
  kind: string,
  payload: Record<string, unknown>,
): TaskStatus | undefined {
  if (kind !== "task.state_changed") return undefined;
  const state = typeof payload.to === "string"
    ? payload.to
    : typeof payload.state === "string" ? payload.state : "";
  if (state === "completed") return "completed";
  if (state === "takeover_failed") return "failed";
  if (
    [
      "blocked_limit",
      "blocked_error",
      "handoff_sent",
      "awaiting_user_paste",
      "handoff_confirmed",
    ].includes(state)
  ) {
    return "waiting";
  }
  if (state) return "running";
  return undefined;
}

export function flattenShadowResult(
  command: AgentCommand,
  result: Record<string, unknown>,
): { kind: string; data: Record<string, unknown> } {
  const requestId = String(command.payload.challenge_request_id ?? command.id);
  const response = record(result.response, "response");
  if (response.protocol !== SHADOW_PROTOCOL) {
    throw new ShadowError("invalid_owner_result", "owner response protocol is invalid", 502);
  }
  if (response.type === "sync.conflict") {
    const payload = record(response.payload, "response.payload");
    return {
      kind: "sync.conflict",
      data: {
        request_id: requestId,
        action_id: payload.action_id,
        execution_id: payload.execution_id,
        ok: false,
        expected_state_version: payload.expected_state_version,
        current_state_version: payload.current_state_version,
        resolution: payload.resolution,
      },
    };
  }
  if (response.type !== "sync.result") {
    throw new ShadowError("invalid_owner_result", "owner response type is invalid", 502);
  }
  const payload = record(response.payload, "response.payload");
  const actionData = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : {};
  const error = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error as Record<string, unknown>
    : {};
  return {
    kind: "sync.result",
    data: {
      request_id: requestId,
      action_id: payload.action_id,
      execution_id: payload.execution_id,
      ok: payload.ok === true,
      checkpoint_id: actionData.checkpoint_id,
      checkpoint_sha256: actionData.checkpoint_sha256,
      handoff_ref: actionData.handoff_ref,
      task_state: actionData.task_state,
      state_version: payload.state_version,
      recovered: payload.recovered,
      error_code: error.code,
      error_message: error.message,
    },
  };
}
