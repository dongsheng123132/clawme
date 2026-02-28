/**
 * scan-form.js
 * Extracts all form fields from the current page.
 * Injected into the active tab via chrome.scripting.executeScript.
 * Returns a structured description of the form for AI Agent to generate fill content.
 */

/**
 * Extract form fields from the active tab.
 * Returns { pageUrl, pageTitle, fields: [...] }
 */
export async function scanCurrentForm() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法获取当前标签页");

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractFormFields,
    world: "MAIN",
  });

  const data = results?.[0]?.result;
  if (!data || data.fields.length === 0) {
    throw new Error("当前页面未找到表单字段");
  }

  return {
    pageUrl: tab.url,
    pageTitle: tab.title,
    ...data,
  };
}

/**
 * Runs in page context (MAIN world).
 * Finds all visible form fields and extracts their metadata.
 */
function extractFormFields() {
  const fields = [];

  // Helper: get the label text for a field
  function getLabel(el) {
    // 1. Explicit <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.textContent.trim();
    }
    // 2. Parent label
    const parentLabel = el.closest("label");
    if (parentLabel) return parentLabel.textContent.trim();
    // 3. aria-label
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    // 4. Previous sibling or parent text
    let prev = el.previousElementSibling;
    while (prev) {
      const text = prev.textContent.trim();
      if (text && text.length < 100) return text;
      prev = prev.previousElementSibling;
    }
    // 5. Closest container with text
    const container = el.closest("div, fieldset, section");
    if (container) {
      const heading = container.querySelector("label, h1, h2, h3, h4, h5, h6, legend, [class*=label]");
      if (heading && heading.textContent.trim().length < 100) return heading.textContent.trim();
    }
    // 6. placeholder
    if (el.placeholder) return el.placeholder;
    return "";
  }

  // Helper: build a unique CSS selector for an element
  function buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
    // Fallback: nth-of-type path
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      const idx = siblings.indexOf(el) + 1;
      const parentSel = parent.id ? `#${CSS.escape(parent.id)}` : "";
      if (parentSel) return `${parentSel} > ${tag}:nth-of-type(${idx})`;
    }
    return tag;
  }

  // Helper: check if element is visible
  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
      && el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  // Collect inputs, textareas, selects
  const elements = document.querySelectorAll(
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select, [contenteditable=true]"
  );

  for (const el of elements) {
    if (!isVisible(el)) continue;

    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") || (tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text");
    const label = getLabel(el);
    const selector = buildSelector(el);
    const currentValue = el.value || el.textContent?.trim() || "";

    const field = {
      label,
      selector,
      type,
      currentValue: currentValue.slice(0, 200),
      placeholder: el.placeholder || "",
      required: el.required || el.getAttribute("aria-required") === "true",
    };

    // For select, include options
    if (tag === "select") {
      field.options = Array.from(el.options)
        .filter(o => o.value)
        .map(o => ({ value: o.value, text: o.textContent.trim() }))
        .slice(0, 20);
    }

    // For checkbox/radio, include checked state
    if (type === "checkbox" || type === "radio") {
      field.checked = el.checked;
      field.name = el.name;
    }

    fields.push(field);
  }

  return { fields };
}
