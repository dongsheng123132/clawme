/**
 * OpenClaw plugin: register clawme_send tool to POST instructions to ClawMe backend.
 * Config: plugins.entries.clawme.config { baseUrl, clientToken }
 */
function getConfig(api) {
  const entries = api?.config?.plugins?.entries;
  const c = entries?.clawme?.config ?? {};
  return {
    baseUrl: (c.baseUrl || process.env.CLAWME_BASE_URL || "http://127.0.0.1:31871").replace(/\/$/, ""),
    clientToken: c.clientToken || process.env.CLAWME_CLIENT_TOKEN || "",
  };
}

export default function (api) {
  api.registerTool(
    {
      name: "clawme_send",
      description:
        "Send a structured instruction to ClawMe to be executed on the user's browser or phone. Use for: remind (title + body), open_url (open a URL), and later send_sms, run_shortcut, etc. Target is 'browser', 'phone', or 'any'.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["browser", "phone", "any"],
            description: "Which client should receive the instruction",
          },
          type: {
            type: "string",
            description: "Instruction type: remind, open_url, send_sms, run_shortcut, fill_form, click, extract, etc.",
          },
          payload: {
            type: "object",
            description: "Instruction payload (e.g. for remind: { title, body, action_label }; for open_url: { url, in_new_tab })",
          },
        },
        required: ["target", "type"],
      },
      async execute(_id, params) {
        const { baseUrl, clientToken } = getConfig(api);
        if (!clientToken) {
          return {
            content: [{ type: "text", text: "ClawMe not configured: set plugins.entries.clawme.config.clientToken or CLAWME_CLIENT_TOKEN." }],
          };
        }
        const target = params.target || "browser";
        const instruction = {
          type: params.type || "remind",
          payload: params.payload || {},
        };
        const body = {
          target,
          instruction,
          meta: { from: "openclaw", created_at: new Date().toISOString() },
        };
        const res = await fetch(`${baseUrl}/v1/instructions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${clientToken}`,
            "X-ClawMe-Token": clientToken,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.text();
          return {
            content: [{ type: "text", text: `ClawMe error ${res.status}: ${err}` }],
          };
        }
        const data = await res.json();
        return {
          content: [
            {
              type: "text",
              text: `ClawMe instruction queued (id: ${data.id}). User will see it in the ClawMe client and can execute it; result will be reported back.`,
            },
          ],
        };
      },
    },
    { optional: true }
  );
}
