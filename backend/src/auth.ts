function firstHeader(v: string | string[] | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return undefined;
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
  const allowed = process.env.CLAWME_TOKENS ?? "";
  const list = allowed.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true; // no env = allow any (dev)
  return list.includes(token);
}
