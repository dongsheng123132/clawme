const SHADOW_COMMANDS = new Set(["shadow_challenge", "shadow_execute"]);

export class ShadowWorker {
  constructor({
    relay,
    bridge,
    relayTaskId,
    register,
    pollIntervalMs = 1500,
    onError = (error) => console.error("[shadow-worker]", error.message),
    onNotice = (message) => console.log("[shadow-worker]", message),
  }) {
    this.relay = relay;
    this.bridge = bridge;
    this.relayTaskId = relayTaskId;
    this.register = register;
    this.pollIntervalMs = pollIntervalMs;
    this.onError = onError;
    this.onNotice = onNotice;
    this.cursorLoaded = false;
    this.stopped = false;
  }

  /**
   * A relay that restarted from an older backup no longer knows this task. The
   * owner is the authority on it, so re-register and replay from the position
   * the relay actually has instead of looping on "Task not found" forever.
   */
  async recoverRegistration() {
    if (!this.register) return false;
    this.onNotice("Relay 不认识这个任务，正在重新注册");
    await this.register();
    this.cursorLoaded = false;
    this.cursor = undefined;
    return true;
  }

  async syncOwnerEvents() {
    if (!this.cursorLoaded) {
      this.cursor = await this.relay.getShadowCursor(this.relayTaskId);
      this.cursorLoaded = true;
    }
    for (let page = 0; page < 20; page += 1) {
      const delta = await this.bridge.events(this.cursor);
      try {
        const imported = await this.relay.importShadowDelta(this.relayTaskId, delta);
        this.cursor = imported.cursor;
        if (!imported.hasMore) return imported;
      } catch (error) {
        if (error.code === "shadow_cursor_conflict" && error.body?.current_cursor) {
          this.cursor = error.body.current_cursor;
          return { imported: 0, cursor: this.cursor, hasMore: true, reconciled: true };
        }
        throw error;
      }
    }
    throw new Error("Owner event sync exceeded 20 pages");
  }

  async syncWithRecovery() {
    try {
      return await this.syncOwnerEvents();
    } catch (error) {
      if (error.status !== 404) throw error;
      if (!(await this.recoverRegistration())) throw error;
      return this.syncOwnerEvents();
    }
  }

  async runOnce() {
    await this.syncWithRecovery();
    const commands = await this.relay.getCommands();
    for (const command of commands) {
      if (command.taskId !== this.relayTaskId || !SHADOW_COMMANDS.has(command.type)) continue;
      try {
        const result = await this.bridge.handle(command);
        await this.relay.reportCommandResult(command.id, result);
      } catch (error) {
        // Do not acknowledge transport/process failures. The relay will redeliver,
        // and UURescue's idempotency ledger makes execute retries safe.
        this.onError(error, command);
      }
    }
    return this.syncWithRecovery();
  }

  async start() {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (error) {
        this.onError(error);
      }
      if (this.stopped) break;
      await new Promise((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, this.pollIntervalMs);
      });
      this.wake = undefined;
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.wake?.();
  }
}
