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
      throw new Error(body.error || `ClawMe Relay HTTP ${response.status}`);
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
}
