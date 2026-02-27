/** Instruction from Agent (POST body). */
export interface InstructionRequest {
  id?: string;
  target: "phone" | "browser" | "any";
  instruction: {
    type: string;
    payload: Record<string, unknown>;
  };
  meta?: { from?: string; created_at?: string };
}

/** Stored instruction for clients. */
export interface StoredInstruction {
  id: string;
  target: "phone" | "browser" | "any";
  instruction: { type: string; payload: Record<string, unknown> };
  meta?: Record<string, unknown>;
  createdAt: string;
  status: "pending" | "ok" | "failed" | "cancelled";
  result?: string | Record<string, unknown>;
}

/** Client result report (POST body). */
export interface ResultRequest {
  instruction_id: string;
  status: "ok" | "failed" | "cancelled";
  result?: string | Record<string, unknown>;
}

/** User message from PWA/client to Agent (POST body). */
export interface UserMessage {
  text: string;
  type?: "chat" | "quick_action";
  action?: string;
}

/** Stored user message. */
export interface StoredMessage {
  id: string;
  token: string;
  text: string;
  type: string;
  action?: string;
  createdAt: string;
  relayed: boolean;
}
