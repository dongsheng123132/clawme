function buildEmailUrl(payload) {
  const { to = "", subject = "", body = "", use_gmail = true } = payload || {};
  if (use_gmail) {
    const params = new URLSearchParams();
    if (to) params.set("to", to);
    if (subject) params.set("su", subject);
    if (body) params.set("body", body);
    return "https://mail.google.com/mail/?view=cm&fs=1&" + params.toString();
  }
  return "mailto:" + (to ? encodeURIComponent(to) : "") +
    (subject ? "?subject=" + encodeURIComponent(subject) : "") +
    (body ? (subject ? "&" : "?") + "body=" + encodeURIComponent(body) : "");
}

export function renderPayload(payload) {
  return `写邮件 → ${payload.to || "?"}: ${payload.subject || "(无主题)"}`;
}

export async function execute(payload) {
  const url = buildEmailUrl(payload);
  chrome.tabs.create({ url });
  return { status: "ok", result: "已打开写邮件，请点发送" };
}
