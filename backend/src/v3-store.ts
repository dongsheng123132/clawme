import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentCommand,
  AttentionRequest,
  DutyTask,
  Machine,
  TaskEvent,
  TaskStatus,
  V3Snapshot,
} from "./v3-types.js";

const EMPTY: V3Snapshot = {
  machines: [],
  tasks: [],
  events: [],
  attention: [],
  commands: [],
};

export class V3Store {
  private data: V3Snapshot = structuredClone(EMPTY);
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = process.env.CLAWME_DATA_FILE ?? "data/clawme-v3.json") {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<V3Snapshot>;
      this.data = {
        machines: parsed.machines ?? [],
        tasks: parsed.tasks ?? [],
        events: parsed.events ?? [],
        attention: parsed.attention ?? [],
        commands: parsed.commands ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private persist(): void {
    const body = JSON.stringify(this.data, null, 2);
    const tempPath = `${this.filePath}.tmp`;
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tempPath, body, "utf8");
      await rename(tempPath, this.filePath);
    });
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }

  heartbeat(input: Omit<Machine, "lastSeenAt">): Machine {
    const now = new Date().toISOString();
    const existing = this.data.machines.find((item) => item.id === input.id);
    const machine = { ...input, lastSeenAt: now };
    if (existing) Object.assign(existing, machine);
    else this.data.machines.push(machine);
    this.persist();
    return machine;
  }

  listMachines(): Machine[] {
    return [...this.data.machines].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  upsertTask(input: Omit<DutyTask, "createdAt" | "updatedAt"> & { createdAt?: string }): DutyTask {
    const now = new Date().toISOString();
    const existing = this.data.tasks.find((item) => item.id === input.id);
    if (existing) {
      Object.assign(existing, input, { updatedAt: now });
      this.persist();
      return existing;
    }
    const task: DutyTask = { ...input, createdAt: input.createdAt ?? now, updatedAt: now };
    this.data.tasks.push(task);
    this.persist();
    return task;
  }

  listTasks(limit = 50): DutyTask[] {
    return [...this.data.tasks]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  getTask(id: string): DutyTask | undefined {
    return this.data.tasks.find((item) => item.id === id);
  }

  addEvent(taskId: string, input: Omit<TaskEvent, "id" | "taskId" | "createdAt"> & { status?: TaskStatus }): TaskEvent {
    const event: TaskEvent = {
      id: randomUUID(),
      taskId,
      type: input.type,
      message: input.message,
      data: input.data,
      createdAt: new Date().toISOString(),
    };
    this.data.events.push(event);
    if (this.data.events.length > 5000) this.data.events = this.data.events.slice(-5000);
    const task = this.getTask(taskId);
    if (task) {
      if (input.status) task.status = input.status;
      if (input.message) task.summary = input.message;
      task.updatedAt = event.createdAt;
    }
    this.persist();
    return event;
  }

  listEvents(taskId: string): TaskEvent[] {
    return this.data.events.filter((item) => item.taskId === taskId);
  }

  addAttention(input: Omit<AttentionRequest, "id" | "status" | "createdAt"> & { id?: string }): AttentionRequest {
    const request: AttentionRequest = {
      ...input,
      id: input.id ?? randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.data.attention.push(request);
    const task = this.getTask(request.taskId);
    if (task) {
      task.status = "waiting";
      task.updatedAt = request.createdAt;
    }
    this.persist();
    return request;
  }

  listAttention(status = "pending"): AttentionRequest[] {
    return this.data.attention
      .filter((item) => status === "all" || item.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  decideAttention(id: string, decision: string, note?: string): AttentionRequest | undefined {
    const request = this.data.attention.find((item) => item.id === id);
    if (!request || request.status !== "pending") return undefined;
    if (!request.options.some((option) => option.id === decision)) return undefined;
    request.status = "decided";
    request.decision = decision;
    request.note = note;
    request.decidedAt = new Date().toISOString();
    this.addCommand({
      machineId: request.machineId,
      taskId: request.taskId,
      type: "attention_decision",
      payload: {
        attentionId: request.id,
        decision,
        note,
        nativeRequestId: request.nativeRequestId,
        nativeMethod: request.nativeMethod,
      },
    });
    this.persist();
    return request;
  }

  addCommand(input: Omit<AgentCommand, "id" | "createdAt">): AgentCommand {
    const command: AgentCommand = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.data.commands.push(command);
    this.persist();
    return command;
  }

  pendingCommands(machineId: string): AgentCommand[] {
    return this.data.commands.filter(
      (item) => item.machineId === machineId && !item.acknowledgedAt,
    );
  }

  acknowledgeCommand(id: string, machineId: string): AgentCommand | undefined {
    const command = this.data.commands.find(
      (item) => item.id === id && item.machineId === machineId,
    );
    if (!command) return undefined;
    command.acknowledgedAt = new Date().toISOString();
    this.persist();
    return command;
  }
}
