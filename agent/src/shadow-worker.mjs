const SHADOW_COMMANDS = new Set(["shadow_challenge", "shadow_execute"]);

export class ShadowWorker {
  constructor({
    relay,
    bridge,
    relayTaskId,
    pollIntervalMs = 1500,
    onError = (error) => console.error("[shadow-worker]", error.message),
  }) {
    this.relay = relay;
    this.bridge = bridge;
    this.relayTaskId = relayTaskId;
    this.pollIntervalMs = pollIntervalMs;
    this.onError = onError;
    this.cursorLoaded = false;
    this.stopped = false;
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

  async runOnce() {
    await this.syncOwnerEvents();
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
    return this.syncOwnerEvents();
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
