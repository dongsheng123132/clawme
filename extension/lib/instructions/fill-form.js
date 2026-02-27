import { navigateAndWait, getActiveTabId } from "../utils.js";

/**
 * Normalize fields to [{selector, value}] from either:
 *  - array:  [{selector:"...", value:"..."}]
 *  - object: {"selector": "value"}
 */
function normalizeFields(raw) {
  if (Array.isArray(raw)) return raw.filter((f) => f.selector && f.value != null);
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([selector, value]) => ({ selector, value }));
  }
  return [];
}

export function renderPayload(payload) {
  const fields = normalizeFields(payload.fields);
  return `填表单${payload.url ? " " + payload.url : "（当前页）"}: ${fields.length} 个字段`;
}

export async function execute(payload) {
  const fields = normalizeFields(payload?.fields);
  if (fields.length === 0) {
    return { status: "failed", result: "缺少 fields" };
  }

  let tabId;
  if (payload?.url) {
    tabId = await navigateAndWait(payload.url);
  } else {
    tabId = await getActiveTabId();
  }

  // Wait a bit for SPA pages to render after navigation
  if (payload?.url) {
    await new Promise((r) => setTimeout(r, payload.wait || 2000));
  }

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (fieldsList) => {
        let filled = 0;
        const errors = [];

        for (const { selector, value } of fieldsList) {
          const el = document.querySelector(selector);
          if (!el) {
            errors.push(`未找到: ${selector}`);
            continue;
          }

          const tag = el.tagName.toLowerCase();
          const isContentEditable =
            el.isContentEditable ||
            el.getAttribute("contenteditable") === "true" ||
            el.getAttribute("contenteditable") === "";

          if (isContentEditable) {
            // Rich text editor (Xiaohongshu, Zhihu, etc.)
            el.focus();
            // Clear existing content
            el.innerHTML = "";
            // Insert text via execCommand for max compatibility with frameworks
            document.execCommand("insertText", false, value);
            // Also set textContent as fallback
            if (!el.textContent) {
              el.textContent = value;
            }
            // Fire events that React/Vue/frameworks listen for
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            filled++;
          } else if (tag === "select") {
            // Dropdown select
            el.value = value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            filled++;
          } else if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
            // Checkbox / radio
            el.checked = value === true || value === "true" || value === "1";
            el.dispatchEvent(new Event("change", { bubbles: true }));
            filled++;
          } else if ("value" in el) {
            // Standard input / textarea
            // Use native setter to bypass React's synthetic event system
            const nativeSetter = Object.getOwnPropertyDescriptor(
              Object.getPrototypeOf(el), "value"
            )?.set;
            if (nativeSetter) {
              nativeSetter.call(el, value);
            } else {
              el.value = value;
            }
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            filled++;
          } else {
            // Last resort: set textContent
            el.textContent = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            filled++;
          }
        }

        return { filled, total: fieldsList.length, errors };
      },
      args: [fields],
    });
    const data = res?.[0]?.result ?? { filled: 0 };
    const msg = `已填 ${data.filled}/${data.total} 个字段`;
    if (data.errors?.length) {
      return { status: data.filled > 0 ? "ok" : "failed", result: `${msg}; ${data.errors.join("; ")}` };
    }
    return { status: "ok", result: `${msg}，请检查后提交` };
  } catch (e) {
    return { status: "failed", result: "无法在该页执行: " + (e.message || e) };
  }
}
