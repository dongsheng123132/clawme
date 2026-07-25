import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const MAX_OUTPUT_BYTES = 1024 * 1024;

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
  return { executable: cliPath, args };
}

function parseMachineOutput(run) {
  const text = run.stdout.trim();
  if (!text) {
    throw new Error(
      `UURescue CLI returned no JSON${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""}`,
    );
  }
  if (text.split(/\r?\n/).length !== 1) {
    throw new Error("UURescue CLI polluted machine-readable stdout");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("UURescue CLI returned invalid JSON");
  }
}

export class UuRescueBridge {
  constructor({
    cwd,
    taskId,
    cliPath,
    timeoutMs = 30_000,
    runner = processRunner,
  }) {
    if (!cwd || !cliPath) {
      throw new Error("UURescue bridge requires cwd and cliPath");
    }
    this.cwd = resolve(cwd);
    this.taskId = taskId;
    this.cliPath = cliPath;
    this.timeoutMs = timeoutMs;
    this.runner = runner;
  }

  async run(args) {
    const command = commandFor(this.cliPath, args);
    const run = await this.runner(command.executable, command.args, {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
    });
    return parseMachineOutput(run);
  }

  async withJSONFile(name, value, operation) {
    const dir = await mkdtemp(join(tmpdir(), "clawme-uurescue-"));
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
    const result = await this.run([
      "status",
      ...(this.taskId ? ["--task", this.taskId] : []),
      "--json",
    ]);
    if (result.ok !== true) throw new Error(result.error || "UURescue status failed");
    if (!this.taskId && result.task_id) this.taskId = result.task_id;
    return result;
  }

  async events(after) {
    if (!this.taskId) throw new Error("UURescue task has not been discovered");
    const args = ["events", "--task", this.taskId, "--limit", "100", "--json"];
    if (after) args.push("--after", after);
    const result = await this.run(args);
    if (result.ok !== true || !result.delta) {
      throw new Error(result.error || "UURescue events failed");
    }
    return result.delta;
  }

  async issueChallenge(command) {
    const payload = command.payload ?? {};
    if (payload.owner_task_id !== this.taskId || payload.action_id !== "checkpoint.create") {
      throw new Error("Challenge command does not belong to this UURescue task");
    }
    const actor = payload.actor ?? {};
    return this.withJSONFile("challenge-input.json", payload.input, (file) => this.run([
      "sync-challenge",
      "--task",
      this.taskId,
      "--action",
      "checkpoint.create",
      "--actor",
      String(actor.id),
      "--actor-kind",
      String(actor.kind),
      ...(actor.surface ? ["--surface", String(actor.surface)] : []),
      "--mode",
      String(payload.confirmation_mode),
      "--input-file",
      file,
      "--json",
    ]));
  }

  async execute(command) {
    const payload = command.payload ?? {};
    if (payload.owner_task_id !== this.taskId || !payload.envelope) {
      throw new Error("Execute command does not belong to this UURescue task");
    }
    return this.withJSONFile("sync-command.json", payload.envelope, (file) => this.run([
      "sync-command",
      "--task",
      this.taskId,
      "--file",
      file,
      "--json",
    ]));
  }

  handle(command) {
    if (command.type === "shadow_challenge") return this.issueChallenge(command);
    if (command.type === "shadow_execute") return this.execute(command);
    throw new Error(`Unsupported ShadowCore command: ${command.type}`);
  }
}
