export function renderPayload(payload) {
  return `打开: ${payload.url || ""}`;
}

export async function execute(payload) {
  const url = payload?.url;
  if (!url) return { status: "failed", result: "缺少 url" };

  const inNewTab = payload?.in_new_tab !== false;
  if (inNewTab) {
    chrome.tabs.create({ url });
  } else {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) chrome.tabs.update(tabs[0].id, { url });
  }
  return { status: "ok", result: "已打开 " + url };
}
