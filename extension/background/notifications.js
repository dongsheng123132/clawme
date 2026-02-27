import { TYPE_LABELS } from "../lib/constants.js";

/**
 * Show a desktop notification for a new instruction.
 */
export function notifyNewInstruction(inst) {
  const type = inst.instruction?.type || "unknown";
  const label = TYPE_LABELS[type] || type;

  chrome.notifications.create(inst.id, {
    type: "basic",
    iconUrl: "icons/48.png",
    title: `ClawMe: 新${label}指令`,
    message: `收到一条 ${label} 指令，点击查看`,
    priority: 1,
  });
}

/**
 * Show notification for multiple new instructions.
 */
export function notifyBatch(newInstructions) {
  if (newInstructions.length === 0) return;

  if (newInstructions.length === 1) {
    notifyNewInstruction(newInstructions[0]);
    return;
  }

  chrome.notifications.create("clawme-batch", {
    type: "basic",
    iconUrl: "icons/48.png",
    title: `ClawMe: ${newInstructions.length} 条新指令`,
    message: "点击侧边栏查看并执行",
    priority: 1,
  });
}
