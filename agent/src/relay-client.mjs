export class RelayClient {
  constructor({ baseUrl, token, machineId }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.machineId = machineId;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-ClawMe-Token": this.token,
        ...options.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        body.message || body.error || `ClawMe Relay HTTP ${response.status}`,
      );
      error.code = body.error;
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  heartbeat(info) {
    return this.request("/v3/machines/heartbeat", {
      method: "POST",
      body: JSON.stringify({ id: this.machineId, ...info }),
    });
  }

  upsertTask(task) {
    return this.request("/v3/tasks", {
      method: "POST",
      body: JSON.stringify({ ...task, machineId: this.machineId }),
    });
  }

  addEvent(taskId, event) {
    return this.request(`/v3/tasks/${encodeURIComponent(taskId)}/events`, {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  syncTask(taskId, { after, limit = 100 } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after) query.set("after", after);
    return this.request(
      `/v3/sync/tasks/${encodeURIComponent(taskId)}?${query}`,
    );
  }

  addAttention(attention) {
    return this.request("/v3/attention", {
      method: "POST",
      body: JSON.stringify({ ...attention, machineId: this.machineId }),
    });
  }

  async getCommands() {
    const query = new URLSearchParams({ machineId: this.machineId });
    return (await this.request(`/v3/agent/commands?${query}`)).commands ?? [];
  }

  acknowledge(commandId) {
    return this.request(`/v3/agent/commands/${encodeURIComponent(commandId)}/ack`, {
      method: "POST",
      body: JSON.stringify({ machineId: this.machineId }),
    });
  }

  reportCommandResult(commandId, result) {
    return this.request(`/v3/agent/commands/${encodeURIComponent(commandId)}/result`, {
      method: "POST",
      body: JSON.stringify({ machineId: this.machineId, result }),
    });
  }

  async getShadowCursor(taskId) {
    const response = await this.request(
      `/v3/agent/tasks/${encodeURIComponent(taskId)}/shadow-cursor`,
    );
    return response.cursor ?? undefined;
  }

  importShadowDelta(taskId, delta) {
    return this.request(`/v3/agent/tasks/${encodeURIComponent(taskId)}/shadow-delta`, {
      method: "POST",
      body: JSON.stringify({ delta }),
    });
  }
}
