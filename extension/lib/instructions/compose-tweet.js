function buildTweetUrl(text) {
  return "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text || "");
}

export function renderPayload(payload) {
  const text = payload.text || "";
  return `发推: ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`;
}

export async function execute(payload) {
  const url = buildTweetUrl(payload?.text);
  chrome.tabs.create({ url });
  return { status: "ok", result: "已打开发推页，请点发推" };
}
