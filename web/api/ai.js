/**
 * Vercel Serverless Function: /api/ai
 *
 * Receives user message (e.g. scanned form fields) → calls AI (DeepSeek) →
 * returns ClawMe instruction JSON. Optionally forwards the instruction to
 * the user's ClawMe backend so the browser extension can poll and execute it.
 *
 * Environment variables (set in Vercel dashboard):
 *   CLAWME_AI_API_KEY   — DeepSeek / OpenAI API key
 *   CLAWME_AI_BASE_URL  — API base (default: https://api.deepseek.com/v1)
 *   CLAWME_AI_MODEL     — Model ID (default: deepseek-chat)
 */

const AI_API_KEY = process.env.CLAWME_AI_API_KEY || "";
const AI_BASE_URL = (process.env.CLAWME_AI_BASE_URL || "https://api.deepseek.com/v1").replace(/\/$/, "");
const AI_MODEL = process.env.CLAWME_AI_MODEL || "deepseek-chat";

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

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-ClawMe-Token");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!AI_API_KEY) {
    return res.status(500).json({ ok: false, error: "AI not configured on server" });
  }

  const { text, action, backendUrl, token } = req.body || {};
  if (!text?.trim()) {
    return res.status(400).json({ ok: false, error: "Missing text" });
  }

  try {
    // Call AI
    const userPrompt = text + "\n\n请生成对应的 ClawMe 指令 JSON。只返回 JSON。";
    const aiRes = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AI_API_KEY}`,
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

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(502).json({ ok: false, error: `AI API ${aiRes.status}: ${errText.slice(0, 200)}` });
    }

    const aiData = await aiRes.json();
    const content = aiData.choices?.[0]?.message?.content || "";

    // Extract JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(200).json({ ok: false, error: "AI 未返回有效 JSON", raw: content.slice(0, 300) });
    }

    const instruction = JSON.parse(jsonMatch[0]);
    if (!instruction.type) {
      return res.status(200).json({ ok: false, error: "AI 返回的指令缺少 type" });
    }

    const result = { type: instruction.type, payload: instruction.payload || {} };

    // Optionally forward to user's ClawMe backend
    if (backendUrl && token) {
      fetch(`${backendUrl.replace(/\/$/, "")}/v1/instructions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ClawMe-Token": token,
        },
        body: JSON.stringify({
          target: "browser",
          instruction: result,
          meta: { from: "clawme-ai-vercel", auto_generated: true },
        }),
      }).catch(() => {}); // fire and forget
    }

    return res.status(200).json({ ok: true, instruction: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
