/**
 * ai.js — Client-side AI processing.
 * Calls user's own AI API key directly from the extension.
 * No server needed. Supports DeepSeek / OpenAI / any OpenAI-compatible API.
 */

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

规则：
- fill_form 时，直接用用户提供的 CSS 选择器作为 fields 的 key
- select 下拉框用选项的 value 或 text
- 只返回 JSON，不要其他文字`;

/**
 * Call AI with user's own API key.
 * Returns { ok, instruction?, error? }
 */
export async function callAI(text) {
  const { aiApiKey, aiBaseUrl, aiModel } = await chrome.storage.local.get({
    aiApiKey: "",
    aiBaseUrl: "https://api.deepseek.com/v1",
    aiModel: "deepseek-chat",
  });

  if (!aiApiKey) {
    return { ok: false, error: "未设置 AI API Key，请在设置中填写" };
  }

  const baseUrl = aiBaseUrl.replace(/\/$/, "");
  const userPrompt = text + "\n\n请生成对应的 ClawMe 指令 JSON。只返回 JSON。";

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${aiApiKey}`,
    },
    body: JSON.stringify({
      model: aiModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, error: `AI API ${res.status}: ${errText.slice(0, 200)}` };
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { ok: false, error: "AI 未返回有效 JSON", raw: content.slice(0, 300) };
  }

  const instruction = JSON.parse(jsonMatch[0]);
  if (!instruction.type) {
    return { ok: false, error: "AI 返回的指令缺少 type" };
  }

  return { ok: true, instruction: { type: instruction.type, payload: instruction.payload || {} } };
}
