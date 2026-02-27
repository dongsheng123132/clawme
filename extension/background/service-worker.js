import { POLL_ALARM_NAME, POLL_INTERVAL_SECONDS } from "../lib/constants.js";
import { poll } from "./poller.js";
import { notifyBatch } from "./notifications.js";

// --- Alarm-based polling ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== POLL_ALARM_NAME) return;

  const { autoPoll = true } = await chrome.storage.local.get("autoPoll");
  if (!autoPoll) return;

  try {
    const { instructions, newInstructions } = await poll();

    // Notify for new instructions
    notifyBatch(newInstructions);

    // Broadcast to side panel (may not be open — ignore errors)
    chrome.runtime.sendMessage({
      type: "poll-result",
      instructions,
      newCount: newInstructions.length,
    }).catch(() => {});
  } catch (e) {
    console.warn("[ClawMe] Poll error:", e.message);
  }
});

// --- Start alarm on install/startup ---

async function ensureAlarm() {
  const existing = await chrome.alarms.get(POLL_ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(POLL_ALARM_NAME, {
      delayInMinutes: 0.5,
      periodInMinutes: POLL_INTERVAL_SECONDS / 60,
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
});

// --- Message handling ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "poll-now") {
    poll()
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ error: e.message }));
    return true; // async response
  }

  if (msg.type === "set-auto-poll") {
    chrome.storage.local.set({ autoPoll: msg.enabled });
    if (msg.enabled) {
      ensureAlarm();
    } else {
      chrome.alarms.clear(POLL_ALARM_NAME);
    }
    sendResponse({ ok: true });
    return true;
  }
});

// --- Click on extension icon → open side panel ---

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// --- Click notification → open side panel ---

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.sidePanel.open({ tabId: tabs[0].id });
    }
  });
  chrome.notifications.clear(notificationId);
});
