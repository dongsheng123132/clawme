/**
 * 只做一件事的 owner 端：把本机开放的程序清单报上去，并执行手机点下来的启动。
 *
 * 现有的 run / shadow 两个模式各自绑着一个重依赖（Codex、UURescue）。想让手机
 * 上出现几个图标不该先装一套 AI 工具链，所以这里单开一条最短路径：心跳 + 命令。
 */
export class AppHost {
  constructor({
    relay,
    launcher,
    machineName,
    platform,
    agentVersion = "0.4.0",
    pollIntervalMs = 1500,
    heartbeatIntervalMs = 30_000,
    onError = (error) => console.error("[app-host]", error.message),
    onNotice = (message) => console.log("[app-host]", message),
  }) {
    this.relay = relay;
    this.launcher = launcher;
    this.machineName = machineName;
    this.platform = platform;
    this.agentVersion = agentVersion;
    this.pollIntervalMs = pollIntervalMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.onError = onError;
    this.onNotice = onNotice;
    this.stopped = false;
  }

  /**
   * 心跳带上程序清单 —— 但只带身份和怎么画。命令行留在本机，不上行。
   * 同时刷新 last seen，否则手机上这台机器会一直显示成早就下线的样子。
   */
  async maybeHeartbeat() {
    const now = Date.now();
    if (this.lastHeartbeatAt && now - this.lastHeartbeatAt < this.heartbeatIntervalMs) return;
    await this.relay.heartbeat({
      name: this.machineName,
      platform: this.platform,
      agentVersion: this.agentVersion,
      capabilities: ["app.launch"],
      apps: this.launcher.manifest(),
    });
    this.lastHeartbeatAt = now;
  }

  async runOnce() {
    await this.maybeHeartbeat();
    const commands = await this.relay.getCommands();
    for (const command of commands) {
      // 这个模式只管启动程序。别的命令留给能处理它们的模式去认领，
      // 在这里回绝会把 shadow 模式的命令吃掉。
      if (command.type !== "app_launch") continue;
      try {
        const appId = command.payload?.app_id;
        const result = await this.launcher.launch(appId);
        await this.relay.reportCommandResult(command.id, result);
        this.onNotice(
          result.ok
            ? `已打开 ${command.payload?.app_name ?? appId}（pid ${result.pid ?? "?"}）`
            : `无法打开 ${appId}：${result.error}`,
        );
      } catch (error) {
        // 传输失败不确认，relay 会重投；启动带幂等键，重投不会开出两个窗口。
        this.onError(error, command);
      }
    }
  }

  async start() {
    this.stopped = false;
    this.onNotice(`开放 ${this.launcher.size} 个程序：${
      this.launcher.manifest().map((a) => a.name).join("、") || "（无）"
    }`);
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (error) {
        this.onError(error);
      }
      if (this.stopped) break;
      await new Promise((resolve) => {
        this.timer = setTimeout(resolve, this.pollIntervalMs);
      });
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
