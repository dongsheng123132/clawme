import { fetchPending } from "../lib/api.js";

/**
 * Poll for pending instructions, update badge, return new instructions.
 * Compares against lastKnownIds stored in chrome.storage.local to detect new ones.
 */
export async function poll() {
  const data = await fetchPending();
  const instructions = data.instructions || [];

  // Update badge
  const count = instructions.length;
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: count > 0 ? "#ef4444" : "#10b981" });

  // Detect new instructions
  const { lastKnownIds = [] } = await chrome.storage.local.get("lastKnownIds");
  const knownSet = new Set(lastKnownIds);
  const newInstructions = instructions.filter((inst) => !knownSet.has(inst.id));

  // Save current ids
  const currentIds = instructions.map((inst) => inst.id);
  await chrome.storage.local.set({ lastKnownIds: currentIds });

  return { instructions, newInstructions };
}
