/**
 * upload_file — Download an image/file from URL and upload it to a web page's
 * file input, drag-drop zone, or paste target.
 *
 * payload:
 *   url:        string (required) — page URL to navigate to first (optional if already on page)
 *   file_url:   string (required) — URL of the file/image to upload
 *   file_name:  string (optional) — filename, defaults to last segment of file_url
 *   selector:   string (optional) — CSS selector for file input or drop zone
 *   method:     string (optional) — "auto" | "input" | "drop" | "paste" (default "auto")
 *   wait:       number (optional) — ms to wait after navigation for SPA rendering (default 2000)
 */

import { navigateAndWait, getActiveTabId } from "../utils.js";

export function renderPayload(payload) {
  const name = payload?.file_name || payload?.file_url?.split("/").pop() || "file";
  return `📎 上传文件 ${name}${payload?.url ? " → " + new URL(payload.url).hostname : ""}`;
}

export async function execute(payload) {
  const { file_url } = payload || {};
  if (!file_url) return { status: "failed", result: "缺少 file_url" };

  // Navigate if needed
  let tabId;
  if (payload?.url) {
    tabId = await navigateAndWait(payload.url);
    await new Promise((r) => setTimeout(r, payload.wait || 2000));
  } else {
    tabId = await getActiveTabId();
  }

  // Fetch the file in service worker context (no CORS issues)
  let base64, mimeType;
  try {
    const response = await fetch(file_url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    // Convert to base64 in chunks to avoid call stack overflow
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    base64 = btoa(binary);
    mimeType = response.headers.get("content-type") || "image/png";
  } catch (e) {
    return { status: "failed", result: "下载文件失败: " + e.message };
  }

  const fileName = payload.file_name || file_url.split("/").pop()?.split("?")[0] || "upload.png";
  const selector = payload.selector || null;
  const method = payload.method || "auto";

  // Inject script into the page's MAIN world
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: doUpload,
      args: [base64, mimeType, fileName, selector, method],
    });

    const data = res?.[0]?.result ?? { success: false, error: "无返回" };
    if (data.success) {
      return { status: "ok", result: `已上传「${fileName}」(${data.method})` };
    } else {
      return { status: "failed", result: data.error || "上传失败" };
    }
  } catch (e) {
    return { status: "failed", result: "脚本注入失败: " + e.message };
  }
}

/**
 * Injected into the page's MAIN world.
 * Tries multiple strategies to upload the file.
 */
function doUpload(base64Data, mimeType, fileName, selector, method) {
  // Reconstruct File from base64
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const file = new File([bytes], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  });

  // Strategy 1: Set input.files via DataTransfer
  function tryFileInput() {
    let input;
    if (selector) {
      input = document.querySelector(selector);
      if (input && input.tagName !== "INPUT") input = null;
    }
    if (!input) {
      // Find all file inputs, prefer visible ones
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      input = inputs.find((el) => el.offsetParent !== null) || inputs[0];
    }
    if (!input) return false;

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // React compatibility
    const reactKey = Object.keys(input).find(
      (k) => k.startsWith("__reactProps$") || k.startsWith("__reactEventHandlers$")
    );
    if (reactKey && input[reactKey]?.onChange) {
      input[reactKey].onChange({ target: input });
    }
    return true;
  }

  // Strategy 2: Simulate drag-and-drop
  function tryDragDrop() {
    let dropZone;
    if (selector) {
      dropZone = document.querySelector(selector);
    }
    if (!dropZone) {
      const selectors = [
        '[class*="upload-area"]', '[class*="upload-zone"]', '[class*="dropzone"]',
        '[class*="drop-area"]', '[class*="drag-upload"]', '[class*="file-upload"]',
        '[class*="image-upload"]', '[class*="upload"]',
        '[data-testid*="upload"]', '[data-role*="upload"]',
        ".ql-editor", '[contenteditable="true"]',
      ];
      for (const s of selectors) {
        dropZone = document.querySelector(s);
        if (dropZone) break;
      }
    }
    if (!dropZone) return false;

    const dt = new DataTransfer();
    dt.items.add(file);
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
    dropZone.dispatchEvent(new DragEvent("dragenter", opts));
    dropZone.dispatchEvent(new DragEvent("dragover", opts));
    dropZone.dispatchEvent(new DragEvent("drop", opts));
    return true;
  }

  // Strategy 3: Simulate paste event
  function tryPaste() {
    let target;
    if (selector) target = document.querySelector(selector);
    if (!target) target = document.querySelector('[contenteditable="true"]');
    if (!target) target = document.activeElement || document.body;

    const dt = new DataTransfer();
    dt.items.add(file);
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    target.dispatchEvent(pasteEvent);
    return true;
  }

  // Execute based on method
  if (method === "input") {
    return tryFileInput()
      ? { success: true, method: "input" }
      : { success: false, error: "未找到 file input" };
  }
  if (method === "drop") {
    return tryDragDrop()
      ? { success: true, method: "drop" }
      : { success: false, error: "未找到拖放区域" };
  }
  if (method === "paste") {
    return tryPaste()
      ? { success: true, method: "paste" }
      : { success: false, error: "粘贴失败" };
  }

  // Auto: try all strategies
  if (tryFileInput()) return { success: true, method: "input" };
  if (tryDragDrop()) return { success: true, method: "drop" };
  if (tryPaste()) return { success: true, method: "paste" };
  return { success: false, error: "未找到 file input、拖放区域或可粘贴目标" };
}
