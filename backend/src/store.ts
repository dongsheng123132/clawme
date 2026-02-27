import type { StoredInstruction } from "./types.js";
import { randomUUID } from "node:crypto";

const byToken = new Map<string, StoredInstruction[]>();

function getOrCreate(token: string): StoredInstruction[] {
  let list = byToken.get(token);
  if (!list) {
    list = [];
    byToken.set(token, list);
  }
  return list;
}

export function addInstruction(
  token: string,
  id: string | undefined,
  target: "phone" | "browser" | "any",
  instruction: { type: string; payload: Record<string, unknown> },
  meta?: Record<string, unknown>
): StoredInstruction {
  const storedId = id ?? randomUUID();
  const list = getOrCreate(token);
  const stored: StoredInstruction = {
    id: storedId,
    target,
    instruction,
    meta,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  list.push(stored);
  return stored;
}

export function getPendingForTarget(
  token: string,
  target: "browser" | "phone"
): StoredInstruction[] {
  const list = byToken.get(token) ?? [];
  return list.filter(
    (i) =>
      i.status === "pending" &&
      (i.target === target || i.target === "any")
  );
}

export function getById(token: string, id: string): StoredInstruction | undefined {
  const list = byToken.get(token) ?? [];
  return list.find((i) => i.id === id);
}

export function setResult(
  token: string,
  instructionId: string,
  status: "ok" | "failed" | "cancelled",
  result?: string | Record<string, unknown>
): StoredInstruction | undefined {
  const inst = getById(token, instructionId);
  if (!inst) return undefined;
  inst.status = status;
  inst.result = result;
  return inst;
}
