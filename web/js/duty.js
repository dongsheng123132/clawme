const $ = (id) => document.getElementById(id);
const state = {
  config: JSON.parse(localStorage.getItem("clawme_duty_config") || "null"),
  tasks: [],
  attention: [],
  machines: [],
  selectedTask: null,
  timer: null,
};

const statusText = {
  queued: "排队中",
  running: "执行中",
  waiting: "等你处理",
  completed: "已完成",
  failed: "失败",
  paused: "已暂停",
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(path, options = {}) {
  const response = await fetch(`${state.config.baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-ClawMe-Token": state.config.token,
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function showDesk() {
  $("connect").classList.add("hidden");
  $("desk").classList.remove("hidden");
  refresh();
  clearInterval(state.timer);
  state.timer = setInterval(refresh, 5000);
}

$("connectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const baseUrl = $("baseUrl").value.trim().replace(/\/$/, "");
  const token = $("token").value.trim();
  state.config = { baseUrl, token };
  $("connectError").textContent = "";
  try {
    await api("/v3/tasks?limit=1");
    localStorage.setItem("clawme_duty_config", JSON.stringify(state.config));
    showDesk();
  } catch (error) {
    $("connectError").textContent = `连接失败：${error.message}`;
  }
});

$("settings").addEventListener("click", () => {
  clearInterval(state.timer);
  localStorage.removeItem("clawme_duty_config");
  state.config = null;
  $("desk").classList.add("hidden");
  $("connect").classList.remove("hidden");
});

$("refresh").addEventListener("click", refresh);

async function refresh() {
  try {
    const [tasks, attention, machines] = await Promise.all([
      api("/v3/tasks"),
      api("/v3/attention?status=pending"),
      api("/v3/machines"),
    ]);
    state.tasks = tasks.tasks || [];
    state.attention = attention.attention || [];
    state.machines = machines.machines || [];
    $("connection").textContent = "已连接";
    $("connection").className = "connection online";
    render();
  } catch (error) {
    $("connection").textContent = "连接中断";
    $("connection").className = "connection offline";
  }
}

function render() {
  $("attentionCount").textContent = state.attention.length;
  $("attentionList").innerHTML = state.attention.length
    ? state.attention.map(renderAttention).join("")
    : `<div class="empty"><span>✓</span><strong>目前不用你处理</strong><p>AI 正在自己干活。</p></div>`;
  $("taskList").innerHTML = state.tasks.length
    ? state.tasks.map(renderTask).join("")
    : `<div class="empty"><strong>还没有任务</strong><p>从电脑端启动 ClawMe Agent 后会出现在这里。</p></div>`;
  $("machineList").innerHTML = state.machines.length
    ? state.machines.map(renderMachine).join("")
    : `<div class="empty"><strong>还没有电脑上线</strong></div>`;

  document.querySelectorAll("[data-decision]").forEach((button) => {
    button.addEventListener("click", decide);
  });
  document.querySelectorAll("[data-task]").forEach((button) => {
    button.addEventListener("click", () => openTask(button.dataset.task));
  });
}

function renderAttention(item) {
  return `<article class="attention-card">
    <div class="card-head">
      <span class="kind">${item.kind === "approval" ? "授权请求" : "需要处理"}</span>
      <span class="pulse"></span>
    </div>
    <h3>${escapeHtml(item.title)}</h3>
    ${item.detail ? `<pre>${escapeHtml(item.detail)}</pre>` : ""}
    ${item.risk ? `<p class="risk">风险说明：${escapeHtml(item.risk)}</p>` : ""}
    <div class="decision-row">
      ${item.options.map((option) => `<button
        class="button ${option.tone === "primary" ? "primary" : option.tone === "danger" ? "danger" : "secondary"}"
        data-decision="${escapeHtml(option.id)}"
        data-attention="${escapeHtml(item.id)}">${escapeHtml(option.label)}</button>`).join("")}
    </div>
  </article>`;
}

function renderTask(task) {
  return `<button class="task-card" data-task="${escapeHtml(task.id)}">
    <span class="provider">${escapeHtml(task.provider)}</span>
    <span class="task-main">
      <strong>${escapeHtml(task.title)}</strong>
      <small>${escapeHtml(task.summary || "等待最新动态")}</small>
    </span>
    <span class="status ${escapeHtml(task.status)}">${statusText[task.status] || task.status}</span>
  </button>`;
}

function renderMachine(machine) {
  const age = Date.now() - Date.parse(machine.lastSeenAt);
  const online = age < 60_000;
  return `<article class="machine-card">
    <div class="computer-icon">▰</div>
    <div>
      <strong>${escapeHtml(machine.name)}</strong>
      <p>${escapeHtml(machine.platform)} · Agent ${escapeHtml(machine.agentVersion)}</p>
      <small>${machine.capabilities.map(escapeHtml).join(" · ")}</small>
    </div>
    <span class="machine-state ${online ? "online" : ""}">${online ? "在线" : "离线"}</span>
  </article>`;
}

async function decide(event) {
  const button = event.currentTarget;
  const card = button.closest(".attention-card");
  card.classList.add("busy");
  try {
    await api(`/v3/attention/${encodeURIComponent(button.dataset.attention)}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: button.dataset.decision }),
    });
    await refresh();
  } catch (error) {
    card.classList.remove("busy");
    alert(`处理失败：${error.message}`);
  }
}

async function openTask(taskId) {
  try {
    const data = await api(`/v3/tasks/${encodeURIComponent(taskId)}`);
    state.selectedTask = data.task;
    $("taskProvider").textContent = `${data.task.provider} · ${statusText[data.task.status] || data.task.status}`;
    $("taskTitle").textContent = data.task.title;
    $("taskSummary").textContent = data.task.summary || "";
    $("eventList").innerHTML = (data.events || []).slice().reverse().map((item) => `
      <div class="event">
        <i></i>
        <div><strong>${escapeHtml(item.message || item.type)}</strong>
        <small>${new Date(item.createdAt).toLocaleString()}</small></div>
      </div>`).join("");
    $("taskDialog").showModal();
  } catch (error) {
    alert(`读取任务失败：${error.message}`);
  }
}

$("closeTask").addEventListener("click", () => $("taskDialog").close());
$("messageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("messageText").value.trim();
  if (!text || !state.selectedTask) return;
  await api(`/v3/tasks/${encodeURIComponent(state.selectedTask.id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  $("messageText").value = "";
  $("taskDialog").close();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((item) => item.classList.add("hidden"));
    tab.classList.add("active");
    $(tab.dataset.panel).classList.remove("hidden");
  });
});

if (state.config?.baseUrl && state.config?.token) {
  $("baseUrl").value = state.config.baseUrl;
  $("token").value = state.config.token;
  showDesk();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/js/sw.js").catch(() => {});
