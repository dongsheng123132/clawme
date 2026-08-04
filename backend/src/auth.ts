import { createHash } from "node:crypto";

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return undefined;
}

export type IdentityRole = "controller" | "owner" | "legacy";
export type IdentityKind = "user" | "device" | "agent" | "service";

/**
 * Where a credential came from.
 *
 * `env` credentials are the relay's root: they are configured out of band, on
 * the machine, and they are what mints and revokes everything else. `device`
 * credentials are minted through pairing and can be revoked one at a time
 * without touching the relay's configuration or restarting it.
 *
 * The distinction is what stops a paired phone from minting more phones.
 */
export type IdentitySource = "env" | "device";

export interface ClawMeIdentity {
  actorId: string;
  actorKind: IdentityKind;
  surface?: string;
  role: IdentityRole;
  machineIds: string[];
  source: IdentitySource;
  /** Present only for minted device credentials. */
  deviceId?: string;
}

interface DeviceResolver {
  resolve(token: string): {
    deviceId: string;
    actorId: string;
    actorKind: IdentityKind;
    surface?: string;
    role: IdentityRole;
    machineIds: string[];
  } | null;
}

let deviceResolver: DeviceResolver | null = null;

/**
 * Hand the auth layer a device store. Kept as injection rather than an import
 * so this module stays a pure function of its inputs and the tests can drive it
 * without a filesystem.
 */
export function useDeviceResolver(resolver: DeviceResolver | null): void {
  deviceResolver = resolver;
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
      source: "env",
    };
  } catch {
    // A malformed production identity map must fail closed.
    return null;
  }
}

/** True when CLAWME_IDENTITIES is set but cannot be parsed at all. */
function identityMapIsBroken(): boolean {
  const raw = process.env.CLAWME_IDENTITIES?.trim();
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return !parsed || typeof parsed !== "object" || Array.isArray(parsed);
  } catch {
    return true;
  }
}

function deviceIdentity(token: string): ClawMeIdentity | null {
  const device = deviceResolver?.resolve(token);
  if (!device) return null;
  return {
    actorId: device.actorId,
    actorKind: device.actorKind,
    ...(device.surface ? { surface: device.surface } : {}),
    role: device.role,
    machineIds: device.machineIds,
    source: "device",
    deviceId: device.deviceId,
  };
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

/**
 * True when this relay has no credentials configured at all.
 *
 * A relay in this state cannot authenticate anyone, so it refuses everyone.
 * It used to accept everyone — convenient on a laptop, catastrophic the moment
 * the same build sits behind a public tunnel, which is exactly what happened to
 * one deployment: any invented token got HTTP 200 from the open internet.
 * "Insecure unless configured" is not a default anybody opts into knowingly.
 */
export function isUnconfigured(): boolean {
  return !process.env.CLAWME_IDENTITIES?.trim() && !tokenList().length;
}

function tokenList(): string[] {
  return (process.env.CLAWME_TOKENS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve a token to an actor, in order of authority:
 *
 *   1. CLAWME_IDENTITIES — a root credential bound to one actor and role
 *   2. CLAWME_TOKENS     — a root credential with legacy (unrestricted) access
 *   3. a minted device credential — scoped, and revocable one at a time
 *   4. the explicit open-relay development mode
 *
 * A token that matches none of these is not authenticated. A CLAWME_IDENTITIES
 * value that cannot be parsed denies everything, device credentials included:
 * a relay whose configuration is broken should stop, not improvise.
 */
function resolveIdentity(token: string): ClawMeIdentity | null {
  if (identityMapIsBroken()) return null;

  const configured = configuredIdentity(token);
  if (configured) return configured;

  if (tokenList().includes(token)) {
    return {
      actorId: `root-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`,
      actorKind: "device",
      role: "legacy",
      machineIds: [],
      source: "env",
    };
  }

  const device = deviceIdentity(token);
  if (device) return device;

  if (isUnconfigured() && process.env.CLAWME_ALLOW_ANY_TOKEN === "1") {
    return {
      actorId: `legacy-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`,
      actorKind: "device",
      role: "legacy",
      machineIds: [],
      source: "env",
    };
  }

  return null;
}

/**
 * Validate a token against root credentials, minted device credentials, or the
 * explicit open-relay development mode.
 *
 * With no credentials configured the relay fails closed. Local development that
 * genuinely wants an open relay has to say so out loud with
 * CLAWME_ALLOW_ANY_TOKEN=1, which `npm start` refuses to combine with a
 * non-loopback bind.
 */
export function isTokenAllowed(token: string | null): boolean {
  return Boolean(token && resolveIdentity(token));
}

/** Resolve the authenticated actor behind a request, or null. */
export function getIdentityFromRequest(
  req: { headers: Record<string, string | string[] | undefined> },
): ClawMeIdentity | null {
  const token = getTokenFromRequest(req);
  return token ? resolveIdentity(token) : null;
}

/**
 * Only root credentials may mint or revoke device credentials.
 *
 * Without this a paired phone could pair more phones, and revoking the phone
 * you lost would not revoke whatever it enrolled while you were looking for it.
 */
export function isRootIdentity(identity: ClawMeIdentity): boolean {
  return identity.source === "env";
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
