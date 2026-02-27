import { navigateAndWait, getActiveTabId } from "../utils.js";

export function renderPayload(payload) {
  const fields = payload.fields ? Object.keys(payload.fields) : [];
  return `填表单${payload.url ? " " + payload.url : "（当前页）"}: ${fields.length} 个字段`;
}

export async function execute(payload) {
  const fields = payload?.fields && typeof payload.fields === "object" ? payload.fields : {};
  if (Object.keys(fields).length === 0) {
    return { status: "failed", result: "缺少 fields" };
  }

  let tabId;
  if (payload?.url) {
    tabId = await navigateAndWait(payload.url);
  } else {
    tabId = await getActiveTabId();
  }

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (fieldsObj) => {
        let n = 0;
        for (const [sel, val] of Object.entries(fieldsObj)) {
          const el = document.querySelector(sel);
          if (el) {
            if ("value" in el) {
              el.value = val;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
            n++;
          }
        }
        return n;
      },
      args: [fields],
    });
    const filled = res?.[0]?.result ?? 0;
    return { status: "ok", result: `已填 ${filled} 个字段，请检查后提交` };
  } catch (e) {
    return { status: "failed", result: "无法在该页执行: " + (e.message || e) };
  }
}
