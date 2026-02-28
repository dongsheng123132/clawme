import express from "express";
import { getTokenFromRequest, isTokenAllowed } from "./auth.js";
import { addInstruction, getPendingForTarget, getById, setResult, addMessage, getPendingMessages, markMessageRelayed } from "./store.js";
import { relayResultToOpenClaw, relayMessageToOpenClaw } from "./relay.js";
import type { InstructionRequest, ResultRequest, UserMessage } from "./types.js";

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-ClawMe-Token, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = Number(process.env.PORT) || 31871;

/** POST /v1/instructions — Agent / OpenClaw 下发指令 */
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

/** POST /v1/instructions/:id/result — 客户端上报执行结果 */
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

/** POST /v1/messages — 浏览器插件 Chat 发消息 */
app.post("/v1/messages", async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!isTokenAllowed(token)) {
    return res.status(401).json({ error: "Invalid or missing token" });
  }
  const body = req.body as UserMessage;
  if (!body?.text?.trim()) {
    return res.status(400).json({ error: "Missing text" });
  }

  // Store in message queue (any AI agent can poll this)
  const stored = addMessage(token!, body.text, body.action);

  // Also try relaying to OpenClaw if configured
  const prefix = body.action ? `[${body.action}] ` : "";
  relayMessageToOpenClaw(`${prefix}${body.text}`).catch(() => {});

  res.status(201).json({ ok: true, id: stored.id, message: "已发送给 Agent" });
});

/** GET /v1/messages/pending — AI agent 拉取待处理消息 */
app.get("/v1/messages/pending", (req, res) => {
  const token = getTokenFromRequest(req) ?? (req.query.token as string) ?? null;
  if (!isTokenAllowed(token)) {
    return res.status(401).json({ error: "Invalid or missing token" });
  }
  const ack = req.query.ack === "true"; // auto-acknowledge after read
  const messages = getPendingMessages(token!);
  if (ack) {
    for (const m of messages) markMessageRelayed(token!, m.id);
  }
  res.json({ messages });
});

/** POST /v1/messages/:id/ack — AI agent 确认已处理消息 */
app.post("/v1/messages/:id/ack", (req, res) => {
  const token = getTokenFromRequest(req);
  if (!isTokenAllowed(token)) {
    return res.status(401).json({ error: "Invalid or missing token" });
  }
  markMessageRelayed(token!, req.params.id);
  res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`ClawMe backend http://127.0.0.1:${PORT}`);
  if (process.env.OPENCLAW_HOOK_URL) {
    console.log(`  OpenClaw relay: ${process.env.OPENCLAW_HOOK_URL}`);
  } else {
    console.log(`  OpenClaw relay: OFF (set OPENCLAW_HOOK_URL to enable)`);
  }
});
