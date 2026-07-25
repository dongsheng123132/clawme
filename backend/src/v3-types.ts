export type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "paused";

export type AttentionKind =
  | "approval"
  | "input"
  | "rate_limit"
  | "quota"
  | "error";

export interface Machine {
  id: string;
  name: string;
  platform: string;
  agentVersion: string;
  capabilities: string[];
  lastSeenAt: string;
}

export interface DutyTask {
  id: string;
  machineId: string;
  provider: string;
  title: string;
  status: TaskStatus;
  summary?: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  sequence: number;
  type: string;
  message?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface AttentionRequest {
  id: string;
  taskId: string;
  machineId: string;
  kind: AttentionKind;
  title: string;
  detail?: string;
  risk?: string;
  options: AttentionOption[];
  nativeRequestId?: string | number;
  nativeMethod?: string;
  nativeParams?: Record<string, unknown>;
  status: "pending" | "decided" | "expired";
  decision?: string;
  note?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface AttentionOption {
  id: string;
  label: string;
  tone?: "primary" | "danger" | "neutral";
}

export interface AgentCommand {
  id: string;
  machineId: string;
  taskId?: string;
  type:
    | "attention_decision"
    | "user_message"
    | "switch_model"
    | "pause"
    | "shadow_challenge"
    | "shadow_execute";
  payload: Record<string, unknown>;
  createdAt: string;
  acknowledgedAt?: string;
  completedAt?: string;
  result?: Record<string, unknown>;
}

export interface V3Snapshot {
  machines: Machine[];
  tasks: DutyTask[];
  events: TaskEvent[];
  eventHeads: Record<string, number>;
  attention: AttentionRequest[];
  commands: AgentCommand[];
  shadowCursors: Record<string, string>;
}
