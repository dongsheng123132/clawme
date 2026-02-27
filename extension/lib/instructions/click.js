import { navigateAndWait, getActiveTabId } from "../utils.js";

export function renderPayload(payload) {
  const target = payload.selector || "?";
  return `点击: ${target}${payload.url ? " @ " + payload.url : ""}`;
}

export async function execute(payload) {
  const selector = payload?.selector;
  if (!selector) return { status: "failed", result: "缺少 selector" };

  let tabId;
  if (payload?.url) {
    tabId = await navigateAndWait(payload.url);
  } else {
    tabId = await getActiveTabId();
  }

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { found: false };
        el.click();
        return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || "").slice(0, 50) };
      },
      args: [selector],
    });
    const data = res?.[0]?.result;
    if (!data?.found) {
      return { status: "failed", result: `未找到元素: ${selector}` };
    }
    return { status: "ok", result: `已点击 <${data.tag}> ${data.text}` };
  } catch (e) {
    return { status: "failed", result: "无法在该页执行: " + (e.message || e) };
  }
}
