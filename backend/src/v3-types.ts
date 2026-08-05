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

/**
 * 一个可以在 owner 电脑上启动的程序。
 *
 * 注意这里**没有命令行**。手机只知道 ID 和怎么把它画出来；要执行什么，由 owner
 * 从它自己配置的白名单里查。手机能发送命令行的那一刻，"远程开程序"就变成了
 * "远程任意代码执行"。
 *
 * 图标也不是图片，是一个短标签加一个颜色 —— 连启动器都不传像素。
 */
export interface MachineApp {
  id: string;
  name: string;
  /** 磁贴上的短标签，一到两个字符，例如 "VS"。 */
  label?: string;
  /** 磁贴颜色，#RRGGBB。 */
  color?: string;
}

export interface Machine {
  id: string;
  name: string;
  platform: string;
  agentVersion: string;
  capabilities: string[];
  /** owner 声明的可启动程序。relay 只转发，不决定有没有这个程序。 */
  apps?: MachineApp[];
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
    | "shadow_execute"
    | "app_launch";
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
