// ===== ClawMe PWA App =====

const TYPE_LABELS = {
  remind: "提醒", open_url: "打开链接", compose_tweet: "发推",
  compose_email: "写邮件", fill_form: "填表单", click: "点击", extract: "抓取",
};

// --- State ---
let config = { baseUrl: "", token: "" };
let instructions = [];
let logEntries = [];
let pollTimer = null;

// --- DOM ---
const $ = (id) => document.getElementById(id);

// --- Config persistence ---
function saveConfig() {
  localStorage.setItem("clawme_config", JSON.stringify(config));
}
function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem("clawme_config"));
    if (saved?.baseUrl && saved?.token) { config = saved; return true; }
  } catch {}
  return false;
}

// --- API ---
async function fetchPending() {
  const res = await fetch(`${config.baseUrl}/v1/instructions/pending?target=browser`, {
    headers: { "X-ClawMe-Token": config.token },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function reportResult(id, status, result) {
  await fetch(`${config.baseUrl}/v1/instructions/${id}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ClawMe-Token": config.token },
    body: JSON.stringify({ instruction_id: id, status, result }),
  });
}

// --- Screens ---
function showScreen(name) {
  ["connectScreen", "scanScreen", "mainScreen"].forEach((id) => {
    $(id).classList.toggle("hidden", id !== name);
  });
}

// --- Connect ---
$("btnConnect").addEventListener("click", async () => {
  const url = $("inputUrl").value.trim().replace(/\/$/, "");
  const token = $("inputToken").value.trim();
  if (!url || !token) { $("connectError").textContent = "请填写 URL 和 Token"; return; }

  $("connectError").textContent = "";
  $("btnConnect").textContent = "连接中...";
  $("btnConnect").disabled = true;

  try {
    config = { baseUrl: url, token };
    await fetchPending(); // test connection
    saveConfig();
    enterMain();
  } catch (e) {
    $("connectError").textContent = "连接失败: " + (e.message || e);
  } finally {
    $("btnConnect").textContent = "连接";
    $("btnConnect").disabled = false;
  }
});

// --- QR Scan ---
$("btnScan").addEventListener("click", () => {
  showScreen("scanScreen");
  startScan();
});
$("btnBackFromScan").addEventListener("click", () => {
  stopScan();
  showScreen("connectScreen");
});

let scanStream = null;
async function startScan() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    scanStream = stream;
    const video = $("scanVideo");
    video.srcObject = stream;
    video.play();

    // Use BarcodeDetector if available, otherwise poll
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const scanLoop = async () => {
        if (!scanStream) return;
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) {
            handleQrResult(barcodes[0].rawValue);
            return;
          }
        } catch {}
        requestAnimationFrame(scanLoop);
      };
      requestAnimationFrame(scanLoop);
    }
  } catch (e) {
    alert("无法访问摄像头: " + e.message);
    showScreen("connectScreen");
  }
}

function stopScan() {
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
}

function handleQrResult(raw) {
  stopScan();
  try {
    // QR format: clawme://<url>?token=<token>
    // or JSON: { "url": "...", "token": "..." }
    let url, token;
    if (raw.startsWith("clawme://")) {
      const u = new URL(raw.replace("clawme://", "https://"));
      url = u.origin;
      token = u.searchParams.get("token") || "";
    } else {
      const obj = JSON.parse(raw);
      url = obj.url || obj.baseUrl;
      token = obj.token;
    }
    if (url && token) {
      config = { baseUrl: url.replace(/\/$/, ""), token };
      saveConfig();
      enterMain();
    } else {
      alert("无效的二维码");
      showScreen("connectScreen");
    }
  } catch {
    alert("无法识别二维码内容");
    showScreen("connectScreen");
  }
}

// --- Main screen ---
function enterMain() {
  showScreen("mainScreen");
  $("settingUrl").value = config.baseUrl;
  $("settingToken").value = config.token;
  generateQR();
  refresh();
  startPolling();
}

// --- Polling ---
function startPolling() {
  stopPolling();
  if ($("togglePoll").checked) {
    pollTimer = setInterval(refresh, 30000);
  }
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

$("togglePoll").addEventListener("change", () => {
  if ($("togglePoll").checked) startPolling();
  else stopPolling();
});

// --- Refresh ---
async function refresh() {
  const dot = $("statusDot");
  try {
    const data = await fetchPending();
    instructions = data.instructions || [];
    dot.className = "status-dot connected";
    renderInstructions();

    // Auto-execute
    if ($("toggleAutoExec").checked && instructions.length > 0) {
      for (const inst of [...instructions]) {
        await executeInstr(inst);
      }
    }
  } catch (e) {
    dot.className = "status-dot error";
    $("instrList").innerHTML = `<div class="empty-state" style="color:var(--danger)">连接失败: ${esc(e.message)}</div>`;
  }
}

$("btnRefresh").addEventListener("click", refresh);

// --- Render ---
function renderInstructions() {
  const list = $("instrList");
  if (instructions.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无指令，等待 Agent 下发...</div>';
    return;
  }

  // Group by workflow
  const singles = [];
  const workflows = new Map();
  for (const inst of instructions) {
    const wfId = inst.meta?.workflow_id;
    if (wfId) {
      if (!workflows.has(wfId)) workflows.set(wfId, []);
      workflows.get(wfId).push(inst);
    } else {
      singles.push(inst);
    }
  }

  // Sort workflow steps
  for (const items of workflows.values()) {
    items.sort((a, b) => (a.meta?.step ?? 0) - (b.meta?.step ?? 0));
  }

  let html = "";
  for (const inst of singles) {
    html += renderCard(inst);
  }
  for (const [wfId, items] of workflows) {
    html += renderWorkflow(wfId, items);
  }
  list.innerHTML = html;

  // Bind buttons
  list.querySelectorAll("[data-action=exec]").forEach((btn) => {
    btn.onclick = () => {
      const inst = instructions.find((i) => i.id === btn.dataset.id);
      if (inst) executeInstr(inst);
    };
  });
  list.querySelectorAll("[data-action=skip]").forEach((btn) => {
    btn.onclick = () => skipInstr(btn.dataset.id);
  });
  list.querySelectorAll("[data-action=run-wf]").forEach((btn) => {
    btn.onclick = () => runWorkflow(btn.dataset.wfId);
  });
}

function renderCard(inst) {
  const type = inst.instruction.type;
  const label = TYPE_LABELS[type] || type;
  const payload = renderPayload(type, inst.instruction.payload || {});
  return `<div class="instr-card">
    <span class="type-badge">${label}</span>
    <div class="payload">${esc(payload)}</div>
    <div class="card-actions">
      <button class="btn-exec" data-action="exec" data-id="${inst.id}">执行</button>
      <button class="btn-skip" data-action="skip" data-id="${inst.id}">跳过</button>
    </div>
  </div>`;
}

function renderWorkflow(wfId, items) {
  const steps = items.map((inst, i) => {
    const label = TYPE_LABELS[inst.instruction.type] || inst.instruction.type;
    return `<div class="wf-step"><span class="wf-step-num">${i + 1}</span><span>${label}</span></div>`;
  }).join("");
  return `<div class="workflow-card">
    <div class="wf-title">Workflow: ${esc(wfId)}</div>
    ${steps}
    <div class="wf-progress"><div class="wf-progress-bar"></div></div>
    <div class="wf-actions">
      <button class="btn-exec" data-action="run-wf" data-wf-id="${wfId}" style="flex:1">全部执行</button>
    </div>
  </div>`;
}

function renderPayload(type, p) {
  if (type === "remind") return `${p.title || "提醒"}: ${p.body || ""}`;
  if (type === "open_url") return `打开: ${p.url || ""}`;
  if (type === "compose_tweet") return `发推: ${(p.text || "").slice(0, 60)}`;
  if (type === "compose_email") return `写邮件 → ${p.to || "?"}: ${p.subject || ""}`;
  if (type === "fill_form") return `填表单: ${p.fields ? Object.keys(p.fields).length : 0} 个字段`;
  if (type === "click") return `点击: ${p.selector || "?"}`;
  if (type === "extract") return `抓取: ${p.selector || "?"}`;
  return JSON.stringify(p);
}

// --- Execute ---
async function executeInstr(inst) {
  const type = inst.instruction.type;
  const payload = inst.instruction.payload || {};
  let status = "ok", result = "";

  try {
    if (type === "remind") {
      // Show as notification or alert
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(payload.title || "ClawMe 提醒", { body: payload.body || "" });
      } else {
        alert(`${payload.title || "提醒"}\n\n${payload.body || ""}`);
      }
      result = "已查看提醒";
    } else if (type === "open_url") {
      if (!payload.url) { status = "failed"; result = "缺少 url"; }
      else { window.open(payload.url, "_blank"); result = "已打开 " + payload.url; }
    } else if (type === "compose_tweet") {
      const url = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(payload.text || "");
      window.open(url, "_blank");
      result = "已打开发推页";
    } else if (type === "compose_email") {
      const { to = "", subject = "", body = "", use_gmail = true } = payload;
      let url;
      if (use_gmail) {
        const params = new URLSearchParams();
        if (to) params.set("to", to);
        if (subject) params.set("su", subject);
        if (body) params.set("body", body);
        url = "https://mail.google.com/mail/?view=cm&fs=1&" + params;
      } else {
        url = "mailto:" + encodeURIComponent(to) +
          (subject ? "?subject=" + encodeURIComponent(subject) : "") +
          (body ? (subject ? "&" : "?") + "body=" + encodeURIComponent(body) : "");
      }
      window.open(url, "_blank");
      result = "已打开写邮件";
    } else if (type === "fill_form" || type === "click" || type === "extract") {
      // These require browser extension, PWA can only open the URL
      if (payload.url) {
        window.open(payload.url, "_blank");
        result = `已打开页面，请使用浏览器插件完成 ${TYPE_LABELS[type]} 操作`;
      } else {
        status = "failed";
        result = `${TYPE_LABELS[type]} 需要浏览器插件执行`;
      }
    } else {
      status = "failed";
      result = "不支持的指令类型: " + type;
    }
  } catch (e) {
    status = "failed";
    result = e.message || String(e);
  }

  await reportResult(inst.id, status, result);
  addLog(type, status, result);
  refresh();
}

async function skipInstr(id) {
  await reportResult(id, "cancelled", "用户跳过");
  const inst = instructions.find((i) => i.id === id);
  addLog(inst?.instruction?.type || "?", "cancelled", "用户跳过");
  refresh();
}

async function runWorkflow(wfId) {
  const items = instructions
    .filter((i) => i.meta?.workflow_id === wfId)
    .sort((a, b) => (a.meta?.step ?? 0) - (b.meta?.step ?? 0));
  for (const inst of items) {
    await executeInstr(inst);
  }
}

// --- Log ---
function addLog(type, status, result) {
  logEntries.unshift({
    time: new Date().toLocaleTimeString(),
    type, status,
    result: (result || "").slice(0, 200),
  });
  if (logEntries.length > 100) logEntries.length = 100;
  renderLog();
}

function renderLog() {
  $("logBadge").textContent = logEntries.length;
  const list = $("logList");
  if (logEntries.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无日志</div>';
    return;
  }
  list.innerHTML = logEntries.map((e) =>
    `<div class="log-entry">
      <span class="log-time">${e.time}</span>
      <span class="log-type">${TYPE_LABELS[e.type] || e.type}</span>
      <span class="log-${e.status}">${e.status}</span>
      <span class="log-result">${esc(e.result)}</span>
    </div>`
  ).join("");
}

// --- Settings ---
$("btnSettings").addEventListener("click", () => {
  $("settingsPanel").classList.remove("hidden");
});
$("btnCloseSettings").addEventListener("click", () => {
  $("settingsPanel").classList.add("hidden");
});
$("btnDisconnect").addEventListener("click", () => {
  stopPolling();
  localStorage.removeItem("clawme_config");
  config = { baseUrl: "", token: "" };
  $("settingsPanel").classList.add("hidden");
  $("inputUrl").value = "";
  $("inputToken").value = "";
  showScreen("connectScreen");
});

// --- QR Code generation (simple SVG-based) ---
function generateQR() {
  const data = JSON.stringify({ url: config.baseUrl, token: config.token });
  // Use a simple QR display — show the connection info as text for now,
  // and encode as a data URL for actual QR generation
  const qrDiv = $("qrCode");
  // Generate a simple QR code using a canvas-free approach
  // For production, include a QR library. For now, show connection string.
  const encoded = btoa(data);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data)}`;
  qrDiv.innerHTML = `<img src="${qrUrl}" alt="QR Code" width="200" height="200" style="border-radius:8px">`;
}

// --- Notification permission ---
async function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

// --- Utils ---
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

// --- Service Worker registration ---
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/js/sw.js").catch(() => {});
}

// --- Init ---
requestNotificationPermission();
if (loadConfig()) {
  enterMain();
} else {
  showScreen("connectScreen");
}
