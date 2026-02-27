import { DEFAULT_BASE, TYPE_LABELS, LOG_MAX_ENTRIES } from "../lib/constants.js";
import { fetchPending, reportResult } from "../lib/api.js";
import { renderPayload, executeInstruction, replayInstruction } from "../lib/executor.js";
import { groupByWorkflow, WorkflowRunner } from "../lib/workflow.js";

// --- DOM refs ---
const listEl = document.getElementById("list");
const logListEl = document.getElementById("logList");
const logCountEl = document.getElementById("logCount");
const baseUrlEl = document.getElementById("baseUrl");
const tokenEl = document.getElementById("token");
const autoPollEl = document.getElementById("autoPoll");
const autoExecuteEl = document.getElementById("autoExecute");

// --- State ---
let currentInstructions = [];
let executionLog = [];
let activeWorkflowRunners = new Map(); // workflowId → WorkflowRunner

// --- Config ---

async function loadConfig() {
  const r = await chrome.storage.local.get({
    baseUrl: DEFAULT_BASE,
    token: "",
    autoPoll: true,
    autoExecute: false,
  });
  baseUrlEl.value = r.baseUrl;
  tokenEl.value = r.token;
  autoPollEl.checked = r.autoPoll;
  autoExecuteEl.checked = r.autoExecute;
}

function saveConfig() {
  const baseUrl = baseUrlEl.value.trim() || DEFAULT_BASE;
  const token = tokenEl.value.trim();
  const autoPoll = autoPollEl.checked;
  const autoExecute = autoExecuteEl.checked;
  chrome.storage.local.set({ baseUrl, token, autoPoll, autoExecute });

  // Notify service worker about auto-poll change
  chrome.runtime.sendMessage({ type: "set-auto-poll", enabled: autoPoll }).catch(() => {});

  showStatus("已保存");
}

function showStatus(msg) {
  const existing = document.querySelector(".status-msg");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "status-msg";
  el.textContent = msg;
  document.getElementById("settingsSection").after(el);
  setTimeout(() => el.remove(), 1500);
}

// --- Log ---

function addLogEntry(type, status, result, instruction) {
  const entry = {
    time: new Date().toLocaleTimeString(),
    type,
    status,
    result: (result || "").slice(0, 200),
    instruction: instruction || null, // store for replay
  };
  executionLog.unshift(entry);
  if (executionLog.length > LOG_MAX_ENTRIES) {
    executionLog = executionLog.slice(0, LOG_MAX_ENTRIES);
  }
  renderLog();
}

function renderLog() {
  logCountEl.textContent = executionLog.length;
  if (executionLog.length === 0) {
    logListEl.innerHTML = '<div class="empty">暂无日志</div>';
    return;
  }
  logListEl.innerHTML = executionLog
    .map(
      (e, idx) => `<div class="log-entry">
      <span class="log-time">${e.time}</span>
      <span class="log-type">${TYPE_LABELS[e.type] || e.type}</span>
      <span class="log-status-${e.status}">${e.status}</span>
      <span class="log-result">${escapeHtml(e.result)}</span>
      ${e.instruction ? `<button class="log-replay" data-log-idx="${idx}">重新执行</button>` : ""}
    </div>`
    )
    .join("");
}

function clearLog() {
  executionLog = [];
  renderLog();
}

// --- Render instructions ---

async function refresh() {
  try {
    const data = await fetchPending();
    currentInstructions = data.instructions || [];
    renderInstructions();

    // Auto-execute if enabled
    const { autoExecute = false } = await chrome.storage.local.get("autoExecute");
    if (autoExecute && currentInstructions.length > 0) {
      autoExecuteAll();
    }
  } catch (e) {
    listEl.innerHTML = `<div class="error">拉取失败: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

function renderInstructions() {
  if (currentInstructions.length === 0) {
    listEl.innerHTML = '<div class="empty">暂无待执行指令</div>';
    return;
  }

  const groups = groupByWorkflow(currentInstructions);
  let html = "";

  // Batch action bar (for non-workflow instructions)
  const hasIndividual = groups.has(null) && groups.get(null).length > 0;
  if (hasIndividual || currentInstructions.length > 1) {
    html += `<div class="batch-bar">
      <button class="btn btn-exec" data-action="exec-selected">执行选中</button>
      <label style="font-size:11px;cursor:pointer"><input type="checkbox" id="selectAll" checked style="margin-right:3px">全选</label>
    </div>`;
  }

  for (const [wfId, items] of groups) {
    if (wfId === null) {
      // Individual instructions
      for (const inst of items) {
        html += renderSingleInstruction(inst);
      }
    } else {
      // Workflow group
      html += renderWorkflow(wfId, items);
    }
  }

  listEl.innerHTML = html;
}

function renderSingleInstruction(inst) {
  const type = inst.instruction.type;
  const label = TYPE_LABELS[type] || type;
  const payload = renderPayload(type, inst.instruction.payload || {});

  return `<div class="instruction" data-id="${inst.id}">
    <input type="checkbox" class="inst-check" data-id="${inst.id}" checked>
    <div class="inst-body">
      <span class="type-badge">${label}</span>
      <div class="payload">${escapeHtml(payload)}</div>
      <div class="actions">
        <button class="btn btn-exec" data-action="execute" data-id="${inst.id}">执行</button>
        <button class="btn btn-skip" data-action="skip" data-id="${inst.id}">跳过</button>
      </div>
    </div>
  </div>`;
}

function renderWorkflow(wfId, items) {
  const steps = items
    .map(
      (inst, i) => {
        const type = inst.instruction.type;
        const label = TYPE_LABELS[type] || type;
        return `<div class="wf-step" data-wf-step="${i}" data-wf-id="${wfId}">
        <input type="checkbox" class="wf-step-check" data-wf-id="${wfId}" data-step="${i}" checked>
        <span class="step-num">${i + 1}</span>
        <span>${label}: ${escapeHtml(renderPayload(type, inst.instruction.payload || {}))}</span>
      </div>`;
      }
    )
    .join("");

  return `<div class="workflow-card" data-wf-id="${wfId}">
    <div class="wf-header">
      <span class="wf-title">Workflow: ${escapeHtml(wfId)}</span>
      <div class="wf-actions">
        <button class="btn btn-exec" data-action="run-workflow" data-wf-id="${wfId}">执行选中</button>
        <button class="btn btn-skip" data-action="abort-workflow" data-wf-id="${wfId}" style="display:none">中止</button>
      </div>
    </div>
    ${steps}
    <div class="wf-progress"><div class="wf-progress-bar" style="width:0%"></div></div>
  </div>`;
}

// --- Execute ---

async function executeSingle(instId) {
  const inst = currentInstructions.find((i) => i.id === instId);
  if (!inst) return;

  const type = inst.instruction.type;
  addLogEntry(type, "running", "执行中...", inst);

  const outcome = await executeInstruction(inst);
  // Update the last log entry
  executionLog[0].status = outcome.status;
  executionLog[0].result = outcome.result;
  renderLog();

  refresh();
}

async function skipSingle(instId) {
  const inst = currentInstructions.find((i) => i.id === instId);
  if (!inst) return;
  await reportResult(instId, "cancelled", "用户跳过");
  addLogEntry(inst.instruction.type, "cancelled", "用户跳过");
  refresh();
}

async function runWorkflow(wfId) {
  const groups = groupByWorkflow(currentInstructions);
  const items = groups.get(wfId);
  if (!items || items.length === 0) return;

  // Show abort button, hide run button
  const card = document.querySelector(`.workflow-card[data-wf-id="${wfId}"]`);

  // Determine which steps to skip based on unchecked checkboxes
  const skipSteps = new Set();
  if (card) {
    const checkboxes = card.querySelectorAll(".wf-step-check");
    checkboxes.forEach((cb, i) => {
      if (!cb.checked) skipSteps.add(i);
    });

    const runBtn = card.querySelector('[data-action="run-workflow"]');
    const abortBtn = card.querySelector('[data-action="abort-workflow"]');
    if (runBtn) runBtn.style.display = "none";
    if (abortBtn) abortBtn.style.display = "";
  }

  const runner = new WorkflowRunner(items, {
    skipSteps,
    onStep: (stepIndex, status, result) => {
      // Update step UI
      if (card) {
        const stepEl = card.querySelectorAll(".wf-step")[stepIndex];
        if (stepEl) {
          stepEl.className = `wf-step ${status}`;
        }
        // Update progress bar
        const progressBar = card.querySelector(".wf-progress-bar");
        if (progressBar) {
          const pct = Math.round(((stepIndex + 1) / items.length) * 100);
          progressBar.style.width = pct + "%";
          if (status === "failed") progressBar.style.background = "var(--danger)";
        }
      }

      const type = items[stepIndex]?.instruction?.type || "unknown";
      const inst = items[stepIndex] || null;
      addLogEntry(type, status, result || "", inst);
    },
  });

  activeWorkflowRunners.set(wfId, runner);
  await runner.run();
  activeWorkflowRunners.delete(wfId);

  refresh();
}

function abortWorkflow(wfId) {
  const runner = activeWorkflowRunners.get(wfId);
  if (runner) runner.abort();
}

async function autoExecuteAll() {
  const groups = groupByWorkflow(currentInstructions);

  for (const [wfId, items] of groups) {
    if (wfId === null) {
      for (const inst of items) {
        await executeSingle(inst.id);
      }
    } else {
      await runWorkflow(wfId);
    }
  }
}

// --- Batch / selective execution ---

async function execSelected() {
  // Execute checked individual instructions
  const checked = listEl.querySelectorAll(".inst-check:checked");
  for (const cb of checked) {
    await executeSingle(cb.dataset.id);
  }
}

// --- Replay from log ---

async function replayFromLog(logIdx) {
  const entry = executionLog[logIdx];
  if (!entry?.instruction) return;

  const inst = entry.instruction;
  const type = inst.instruction.type;
  addLogEntry(type, "running", "重新执行中...", inst);

  // Execute only, don't report to backend (old instruction ID is stale)
  const outcome = await replayInstruction(inst);
  executionLog[0].status = outcome.status;
  executionLog[0].result = "[重放] " + outcome.result;
  renderLog();
}

// --- Event delegation (bound once) ---

listEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  if (action === "execute") executeSingle(btn.dataset.id);
  else if (action === "skip") skipSingle(btn.dataset.id);
  else if (action === "run-workflow") runWorkflow(btn.dataset.wfId);
  else if (action === "abort-workflow") abortWorkflow(btn.dataset.wfId);
  else if (action === "exec-selected") execSelected();
});

// Select-all checkbox toggle
listEl.addEventListener("change", (e) => {
  if (e.target.id === "selectAll") {
    const checked = e.target.checked;
    listEl.querySelectorAll(".inst-check, .wf-step-check").forEach((cb) => {
      cb.checked = checked;
    });
  }
});

// Replay button in log
logListEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".log-replay");
  if (!btn) return;
  const idx = parseInt(btn.dataset.logIdx, 10);
  if (!isNaN(idx)) replayFromLog(idx);
});

// --- Listen for messages from service worker ---

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "poll-result") {
    currentInstructions = msg.instructions || [];
    renderInstructions();
  }
});

// --- Utilities ---

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---

document.getElementById("saveConfig").addEventListener("click", () => {
  saveConfig();
  refresh();
});

document.getElementById("refreshBtn").addEventListener("click", () => {
  // Trigger poll via service worker
  chrome.runtime.sendMessage({ type: "poll-now" }, (result) => {
    if (result?.error) {
      listEl.innerHTML = `<div class="error">拉取失败: ${escapeHtml(result.error)}</div>`;
    } else if (result) {
      currentInstructions = result.instructions || [];
      renderInstructions();
    }
  });
});

document.getElementById("clearLog").addEventListener("click", clearLog);

// Load config and do initial fetch
loadConfig().then(() => refresh());
renderLog();
