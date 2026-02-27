import express from "express";
import { getTokenFromRequest, isTokenAllowed } from "./auth.js";
import { addInstruction, getPendingForTarget, getById, setResult } from "./store.js";
import { relayResultToOpenClaw } from "./relay.js";
import type { InstructionRequest, ResultRequest } from "./types.js";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 31871;

/** POST /v1/instructions — Agent 下发指令 */
app.post("/v1/instructions", (req, res) => {
  const token = getTokenFromRequest(req);
  if (!isTokenAllowed(token)) {
    return res.status(401).json({ error: "Invalid or missing token" });
  }
  const body = req.body as InstructionRequest;
  if (!body?.instruction?.type || !body?.target) {
    return res.status(400).json({ error: "Missing instruction.type and target" });
  }
  const target = body.target as "phone" | "browser" | "any";
  if (!["phone", "browser", "any"].includes(target)) {
    return res.status(400).json({ error: "target must be phone | browser | any" });
  }
  const stored = addInstruction(
    token!,
    body.id,
    target,
    { type: body.instruction.type, payload: body.instruction.payload ?? {} },
    body.meta
  );
  res.status(201).json({ id: stored.id, status: "pending" });
});

/** GET /v1/instructions/pending?target=browser|phone — 客户端轮询拉取待执行指令 */
app.get("/v1/instructions/pending", (req, res) => {
  const token = getTokenFromRequest(req) ?? (req.query.token as string) ?? null;
  if (!isTokenAllowed(token)) {
    return res.status(401).json({ error: "Invalid or missing token" });
  }
  const target = (req.query.target as string) === "phone" ? "phone" : "browser";
  const list = getPendingForTarget(token!, target);
  res.json({ instructions: list });
});

/** POST /v1/instructions/:id/result — 客户端上报执行结果（id 也可在 body.instruction_id） */
app.post("/v1/instructions/:id/result", (req, res) => {
  const token = getTokenFromRequest(req);
  if (!isTokenAllowed(token)) {
    return res.status(401).json({ error: "Invalid or missing token" });
  }
  const body = req.body as ResultRequest;
  const id = body.instruction_id ?? req.params.id;
  if (!body?.status || !["ok", "failed", "cancelled"].includes(body.status)) {
    return res.status(400).json({ error: "Missing or invalid status (ok|failed|cancelled)" });
  }
  const inst = setResult(
    token!,
    id,
    body.status,
    body.result
  );
  if (!inst) {
    return res.status(404).json({ error: "Instruction not found" });
  }
  const resultSummary = typeof body.result === "string" ? body.result : JSON.stringify(body.result ?? "");
  relayResultToOpenClaw(id, body.status, resultSummary).catch(() => {});
  res.json({ id, status: inst.status });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`ClawMe backend http://127.0.0.1:${PORT}`);
});
