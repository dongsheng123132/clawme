/**
 * Wait for a tab to finish loading (status === "complete").
 * Resolves when complete, rejects on timeout.
 */
export function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面加载超时"));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    // Check if already complete
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === "complete") {
        clearTimeout(timer);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  });
}

/**
 * Ensure we have host permission for a URL.
 * Uses optional_host_permissions — Chrome will prompt the user if needed.
 */
export async function ensureHostPermission(url) {
  try {
    const origin = new URL(url).origin + "/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error("用户拒绝了对 " + new URL(url).hostname + " 的访问权限");
    }
  } catch (e) {
    // If permission request fails (e.g. from service worker), proceed anyway
    // activeTab may still cover the current tab
  }
}

/**
 * Navigate to url in a tab and wait for it to load.
 * Returns the tabId.
 */
export async function navigateAndWait(url) {
  await ensureHostPermission(url);
  const tab = await chrome.tabs.create({ url });
  await waitForTabLoad(tab.id);
  return tab.id;
}

/**
 * Get the active tab ID in the current window.
 */
export async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error("请先打开要操作的页面");
  return tabs[0].id;
}
