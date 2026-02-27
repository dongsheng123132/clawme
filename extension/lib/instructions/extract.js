import { navigateAndWait, getActiveTabId } from "../utils.js";

export function renderPayload(payload) {
  const target = payload.selector || "?";
  const attr = payload.attribute ? `[${payload.attribute}]` : "";
  return `抓取: ${target}${attr}${payload.url ? " @ " + payload.url : ""}`;
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
      func: (sel, attr) => {
        const el = document.querySelector(sel);
        if (!el) return { found: false };
        const value = attr ? el.getAttribute(attr) : el.textContent;
        return { found: true, value: (value || "").slice(0, 2000) };
      },
      args: [selector, payload?.attribute || null],
    });
    const data = res?.[0]?.result;
    if (!data?.found) {
      return { status: "failed", result: `未找到元素: ${selector}` };
    }
    return { status: "ok", result: data.value };
  } catch (e) {
    return { status: "failed", result: "无法在该页执行: " + (e.message || e) };
  }
}
