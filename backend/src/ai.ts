/**
 * ai.ts — Built-in AI for ClawMe.
 * Supports two API formats:
 *   1. Anthropic (Claude) — set CLAWME_AI_PROVIDER=anthropic
 *   2. OpenAI-compatible (DeepSeek, Kimi, OpenAI, etc.) — default
 *
 * Environment variables:
 *   CLAWME_AI_API_KEY    — Required. API key for the AI provider.
 *   CLAWME_AI_BASE_URL   — API base URL (default: https://api.deepseek.com/v1)
 *   CLAWME_AI_MODEL      — Model ID (default: deepseek-chat)
 *   CLAWME_AI_PROVIDER   — "anthropic" or "openai" (default: openai)
 */

import { addInstruction } from "./store.js";

const AI_API_KEY = process.env.CLAWME_AI_API_KEY || "";
const AI_BASE_URL = (process.env.CLAWME_AI_BASE_URL || "https://api.deepseek.com/v1").replace(/\/$/, "");
const AI_MODEL = process.env.CLAWME_AI_MODEL || "deepseek-chat";
const AI_PROVIDER = process.env.CLAWME_AI_PROVIDER || "openai"; // "openai" or "anthropic"

export function isAIEnabled(): boolean {
  return AI_API_KEY.trim().length > 0;
}

export function aiInfo(): string {
  return `${AI_PROVIDER}/${AI_MODEL} @ ${AI_BASE_URL}`;
}

const SYSTEM_PROMPT = `你是 ClawMe AI 助手，帮用户自动填写网页表单和执行浏览器操作。

当用户发来表单扫描结果时，根据表单字段生成 fill_form 指令。
当用户发来其他请求时，生成对应的 ClawMe 指令。

你的回复必须是一个合法的 JSON 对象，格式：
{
  "type": "<指令类型>",
  "payload": { ... }
}

支持的指令类型：
- fill_form: {"fields": {"CSS选择器": "值"}}
- remind: {"title": "标题", "body": "内容"}
- open_url: {"url": "https://...", "in_new_tab": true}
- compose_tweet: {"text": "推文内容"}
- compose_email: {"to": "收件人", "subject": "主题", "body": "正文", "use_gmail": true}
- click: {"selector": "CSS选择器", "url": "可选URL"}
- extract: {"selector": "CSS选择器", "url": "可选URL"}
- add_calendar: {"title": "标题", "start": "ISO时间", "end": "ISO时间", "location": "地点"}
- upload_file: {"url": "页面URL", "file_url": "文件URL", "selector": "input选择器"}

规则：
- fill_form 时，直接用用户提供的 CSS 选择器作为 fields 的 key
- select 下拉框用选项的 value 或 text
- 只返回 JSON，不要其他文字`;

async function callAnthropic(userPrompt: string): Promise<string> {
  const res = await fetch(`${AI_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": AI_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json() as { content: Array<{ type: string; text?: string }> };
  return data.content?.find((c) => c.type === "text")?.text || "";
}

async function callOpenAI(userPrompt: string): Promise<string> {
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content || "";
}

export interface AIResult {
  ok: boolean;
  instruction?: { type: string; payload: Record<string, unknown> };
  error?: string;
}

/**
 * Process a user message with AI and create instruction(s).
 * Returns the generated instruction so the caller can relay it back to the user.
 */
export async function processWithAI(
  token: string,
  message: string,
  action?: string
): Promise<AIResult> {
  if (!isAIEnabled()) return { ok: false, error: "AI not enabled" };

  try {
    const userPrompt = message + "\n\n请生成对应的 ClawMe 指令 JSON。只返回 JSON。";

    console.log(`[ai] Processing message (${AI_PROVIDER}/${AI_MODEL})...`);
    const text = AI_PROVIDER === "anthropic"
      ? await callAnthropic(userPrompt)
      : await callOpenAI(userPrompt);

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[ai] No JSON in response:", text.slice(0, 200));
      return { ok: false, error: "AI 未返回有效 JSON" };
    }

    const instruction = JSON.parse(jsonMatch[0]);
    if (!instruction.type) {
      console.error("[ai] Invalid instruction:", instruction);
      return { ok: false, error: "AI 返回的指令缺少 type" };
    }

    addInstruction(
      token,
      undefined,
      "browser",
      { type: instruction.type, payload: instruction.payload || {} },
      { from: "clawme-ai", auto_generated: true }
    );

    console.log(`[ai] Created ${instruction.type} instruction`);
    return {
      ok: true,
      instruction: { type: instruction.type, payload: instruction.payload || {} },
    };
  } catch (e: any) {
    console.error("[ai] Error:", e);
    return { ok: false, error: e.message || String(e) };
  }
}
