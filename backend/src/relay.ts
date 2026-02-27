/**
 * Relay a user message to OpenClaw so the Agent can act on it.
 */
export async function relayMessageToOpenClaw(text: string): Promise<void> {
  const url = process.env.OPENCLAW_HOOK_URL;
  const token = process.env.OPENCLAW_HOOK_TOKEN;
  if (!url?.trim() || !token?.trim()) return;

  try {
    const res = await fetch(url.replace(/\/$/, "") + "/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: text,
        deliver: true,
        channel: "last",
      }),
    });
    if (!res.ok) {
      console.error("[relay] OpenClaw message hook failed:", res.status);
    }
  } catch (err) {
    console.error("[relay] OpenClaw message hook error:", err);
  }
}

/**
 * On instruction result, optionally POST to OpenClaw /hooks/agent so the user sees the result in chat.
 */
export async function relayResultToOpenClaw(
  instructionId: string,
  status: string,
  resultSummary: string
): Promise<void> {
  const url = process.env.OPENCLAW_HOOK_URL;
  const token = process.env.OPENCLAW_HOOK_TOKEN;
  if (!url?.trim() || !token?.trim()) return;

  const message = `ClawMe 执行结果（${instructionId}）：${status}${resultSummary ? ` — ${resultSummary}` : ""}`;
  try {
    const res = await fetch(url.replace(/\/$/, "") + "/hooks/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        message,
        deliver: true,
        channel: "last",
      }),
    });
    if (!res.ok) {
      console.error("[relay] OpenClaw hook failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("[relay] OpenClaw hook error:", err);
  }
}
