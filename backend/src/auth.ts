import { createHash } from "node:crypto";

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return undefined;
}

export type IdentityRole = "controller" | "owner" | "legacy";
export type IdentityKind = "user" | "device" | "agent" | "service";

export interface ClawMeIdentity {
  actorId: string;
  actorKind: IdentityKind;
  surface?: string;
  role: IdentityRole;
  machineIds: string[];
}

interface ConfiguredIdentity {
  actor_id?: unknown;
  actor_kind?: unknown;
  surface?: unknown;
  role?: unknown;
  machine_ids?: unknown;
}

const IDENTITY_KINDS = new Set<IdentityKind>(["user", "device", "agent", "service"]);
const IDENTITY_ROLES = new Set<IdentityRole>(["controller", "owner"]);

function configuredIdentity(token: string): ClawMeIdentity | null | undefined {
  const raw = process.env.CLAWME_IDENTITIES?.trim();
  if (!raw) return undefined;
  try {
    const records = JSON.parse(raw) as Record<string, ConfiguredIdentity>;
    const record = records[token];
    if (!record || typeof record !== "object") return null;
    if (
      typeof record.actor_id !== "string"
      || !record.actor_id.trim()
      || typeof record.actor_kind !== "string"
      || !IDENTITY_KINDS.has(record.actor_kind as IdentityKind)
      || typeof record.role !== "string"
      || !IDENTITY_ROLES.has(record.role as IdentityRole)
    ) {
      return null;
    }
    const machineIds = Array.isArray(record.machine_ids)
      ? record.machine_ids.filter(
        (value): value is string => typeof value === "string" && Boolean(value.trim()),
      )
      : [];
    return {
      actorId: record.actor_id,
      actorKind: record.actor_kind as IdentityKind,
      ...(typeof record.surface === "string" && record.surface.trim()
        ? { surface: record.surface }
        : {}),
      role: record.role as IdentityRole,
      machineIds,
    };
  } catch {
    // A malformed production identity map must fail closed.
    return null;
  }
}

/**
 * Resolve client token from request.
 * Supports: Authorization: Bearer <token> or X-ClawMe-Token: <token>
 */
export function getTokenFromRequest(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const auth = firstHeader(req.headers.authorization);
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  const header = firstHeader(req.headers["x-clawme-token"]);
  if (header) return header.trim() || null;
  return null;
}

/** Validate token against allowed list (env CLAWME_TOKENS, comma-separated). */
export function isTokenAllowed(token: string | null): boolean {
  if (!token) return false;
  const identity = configuredIdentity(token);
  if (identity !== undefined) return identity !== null;
  const allowed = process.env.CLAWME_TOKENS ?? "";
  const list = allowed.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true; // no env = allow any (dev)
  return list.includes(token);
}

/**
 * Resolve the authenticated actor. When CLAWME_IDENTITIES is configured, a
 * token is bound to one actor, surface, role and optional machine allow-list.
 * Legacy token mode remains available for local development and migration.
 */
export function getIdentityFromRequest(
  req: { headers: Record<string, string | string[] | undefined> },
): ClawMeIdentity | null {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  const identity = configuredIdentity(token);
  if (identity !== undefined) return identity;
  if (!isTokenAllowed(token)) return null;
  return {
    actorId: `legacy-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`,
    actorKind: "device",
    role: "legacy",
    machineIds: [],
  };
}

export function identityHasRole(
  identity: ClawMeIdentity,
  roles: IdentityRole[],
): boolean {
  return identity.role === "legacy" || roles.includes(identity.role);
}

export function identityOwnsMachine(
  identity: ClawMeIdentity,
  machineId: string,
): boolean {
  return identity.role === "legacy"
    || (identity.role === "owner" && identity.machineIds.includes(machineId));
}
