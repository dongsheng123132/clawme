import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const SHADOW_PROTOCOL = "action-parity/sync@0.1";
const CHALLENGE_ACTION = "checkpoint.challenge";
const CREATE_ACTION = "checkpoint.create";
const STATUS_ACTION = "task.status";
const EVENTS_ACTION = "task.events";

function processRunner(executable, args, { cwd, timeoutMs }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`UURescue CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(error, code = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveRun({ code, stdout, stderr });
    }

    function collect(current, chunk) {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("UURescue CLI output exceeded 1 MiB"));
        return current;
      }
      return next;
    }

    child.stdout.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(null, code));
  });
}

function commandFor(cliPath, args) {
  const extension = extname(cliPath).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return { executable: process.execPath, args: [resolve(cliPath), ...args] };
  }
  if (extension === ".ps1") {
    return {
      executable: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(cliPath), ...args],
    };
  }
  return { executable: cliPath, args };
}

/**
 * Two real ActionParity cores disagree on the wire: UURescue answers
 * {ok, data, error} behind --json, Open365 answers {ok, output, error} behind
 * -Json. The Action IDs are shared, the dialect is not, so the seam lives here
 * instead of leaking into the ShadowCore flow.
 */
export const ACTION_CLI_DIALECTS = {
  "uu-rescue": {
    runArgs: (actionId, file) => [
      "action", "run", actionId, "--input-file", file, "--json", "--no-input",
    ],
    payloadOf: (envelope) => envelope.data,
  },
  open365: {
    runArgs: (actionId, file) => [
      "action", "run", actionId, "-InputFile", file, "-Json",
    ],
    payloadOf: (envelope) => envelope.output,
  },
};

function parseMachineOutput(run, label) {
  const text = run.stdout.trim();
  if (!text) {
    throw new Error(
      `${label} CLI returned no JSON${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""}`,
    );
  }
  if (text.split(/\r?\n/).length !== 1) {
    throw new Error(`${label} CLI polluted machine-readable stdout`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} CLI returned invalid JSON`);
  }
}

/**
 * The generic action surface returns a flat result, so the agent wraps it back
 * into the sync envelope the relay projects onto the phone. A failed action
 * carries no state version: the phone's recovery path is to refresh and request
 * a new challenge, and the event sync that follows carries the fresh version.
 */
function resultEnvelope(envelope, inner, result, payload) {
  const data = payload ?? {};
  const checkpoint = data.checkpoint ?? {};
  const ok = result.ok === true;
  return {
    protocol: SHADOW_PROTOCOL,
    type: "sync.result",
    stream_id: envelope.stream_id,
    message_id: randomUUID(),
    sent_at: new Date().toISOString(),
    payload: {
      action_id: inner.action_id ?? CREATE_ACTION,
      execution_id: inner.execution_id,
      ok,
      data: ok
        ? {
          checkpoint_id: checkpoint.checkpoint_id,
          checkpoint_sha256: checkpoint.checkpoint_sha256,
          handoff_ref: checkpoint.handoff_ref,
          task_state: checkpoint.task_state,
        }
        : {},
      error: ok ? null : (result.error ?? { code: "owner_action_failed" }),
      state_version: data.state_version,
      recovered: data.recovered,
    },
  };
}

export class ActionCliBridge {
  constructor({
    cwd,
    taskId,
    cliPath,
    provider = "uu-rescue",
    timeoutMs = 30_000,
    runner = processRunner,
  }) {
    if (!cwd || !cliPath) {
      throw new Error("Action CLI bridge requires cwd and cliPath");
    }
    const dialect = ACTION_CLI_DIALECTS[provider];
    if (!dialect) {
      throw new Error(`No action CLI dialect is known for provider ${provider}`);
    }
    this.cwd = resolve(cwd);
    this.taskId = taskId;
    this.cliPath = cliPath;
    this.provider = provider;
    this.dialect = dialect;
    this.timeoutMs = timeoutMs;
    this.runner = runner;
  }

  async run(args) {
    const command = commandFor(this.cliPath, args);
    const run = await this.runner(command.executable, command.args, {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
    });
    return parseMachineOutput(run, this.provider);
  }

  async withJSONFile(name, value, operation) {
    const dir = await mkdtemp(join(tmpdir(), "clawme-action-"));
    const file = join(dir, name);
    try {
      await writeFile(file, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return await operation(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async status() {
    const result = await this.runAction(STATUS_ACTION, {
      ...(this.taskId ? { task: this.taskId } : {}),
    });
    if (result.ok !== true) {
      throw new Error(result.error?.message || result.error?.code || "task.status failed");
    }
    const payload = this.dialect.payloadOf(result) ?? {};
    const task = payload.task ?? {};
    if (!this.taskId && task.id) this.taskId = task.id;
    return {
      task_id: task.id,
      title: task.title,
      state: task.state,
      next_step: payload.next,
    };
  }

  async events(after) {
    if (!this.taskId) throw new Error("The owner task has not been discovered");
    const result = await this.runAction(EVENTS_ACTION, {
      task: this.taskId,
      limit: 100,
      ...(after ? { after } : {}),
    });
    const delta = result.ok === true ? this.dialect.payloadOf(result)?.delta : undefined;
    if (!delta) {
      throw new Error(result.error?.message || result.error?.code || "task.events failed");
    }
    return delta;
  }

  /**
   * The one way this bridge reaches an action core. The Action ID is shared with
   * the relay and the phone; only the dialect differs per provider. Input travels
   * through a private temp file, never the command line, because the command
   * line is readable by other processes on the machine.
   */
  async runAction(actionId, input) {
    return this.withJSONFile("action-input.json", input, (file) => this.run(
      this.dialect.runArgs(actionId, file),
    ));
  }

  async issueChallenge(command) {
    const payload = command.payload ?? {};
    if (payload.owner_task_id !== this.taskId || payload.action_id !== CREATE_ACTION) {
      throw new Error("Challenge command does not belong to this UURescue task");
    }
    const result = await this.runAction(CHALLENGE_ACTION, {
      task: this.taskId,
      reason: (payload.input ?? {}).reason,
      mode: payload.confirmation_mode,
      actor: payload.actor,
    });
    if (result.ok !== true) {
      return {
        ok: false,
        error: result.error ?? { code: "owner_challenge_failed" },
      };
    }
    return { ok: true, challenge: (this.dialect.payloadOf(result) ?? {}).challenge };
  }

  async execute(command) {
    const payload = command.payload ?? {};
    const envelope = payload.envelope;
    if (payload.owner_task_id !== this.taskId || !envelope) {
      throw new Error("Execute command does not belong to this UURescue task");
    }
    const inner = envelope.payload ?? {};
    const confirmation = inner.confirmation ?? {};
    // Every field the owner's idempotency ledger fingerprints comes from the
    // relay's stored envelope, so a redelivery reproduces it exactly and the
    // ledger returns the first result instead of writing twice.
    const result = await this.runAction(CREATE_ACTION, {
      task: this.taskId,
      reason: (inner.input ?? {}).reason,
      challenge_id: confirmation.challenge_id,
      idempotency_key: inner.idempotency_key,
      execution_id: inner.execution_id,
      expected_state_version: inner.expected_state_version,
      confirmation_mode: confirmation.mode,
      confirmed_at: confirmation.confirmed_at,
      expires_at: inner.expires_at,
      actor: inner.actor,
    });
    return {
      ok: result.ok === true,
      response: resultEnvelope(envelope, inner, result, this.dialect.payloadOf(result)),
    };
  }

  handle(command) {
    if (command.type === "shadow_challenge") return this.issueChallenge(command);
    if (command.type === "shadow_execute") return this.execute(command);
    throw new Error(`Unsupported ShadowCore command: ${command.type}`);
  }
}
