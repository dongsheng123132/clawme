import { executeInstruction } from "./executor.js";

/**
 * Group instructions by meta.workflow_id.
 * Returns Map<workflowId, instruction[]> sorted by meta.step.
 * Instructions without workflow_id are returned under key null.
 */
export function groupByWorkflow(instructions) {
  const groups = new Map();

  for (const inst of instructions) {
    const wfId = inst.meta?.workflow_id || null;
    if (!groups.has(wfId)) groups.set(wfId, []);
    groups.get(wfId).push(inst);
  }

  // Sort workflow steps by meta.step
  for (const [wfId, items] of groups) {
    if (wfId !== null) {
      items.sort((a, b) => (a.meta?.step ?? 0) - (b.meta?.step ?? 0));
    }
  }

  return groups;
}

/**
 * WorkflowRunner: executes a list of instructions sequentially.
 * Stops on first failure unless `continueOnError` is true.
 * Emits progress via onStep callback.
 */
export class WorkflowRunner {
  constructor(instructions, { onStep, skipSteps } = {}) {
    this.instructions = instructions;
    this.onStep = onStep || (() => {});
    this.skipSteps = skipSteps || new Set(); // step indices to skip
    this.aborted = false;
    this.results = [];
  }

  abort() {
    this.aborted = true;
  }

  async run() {
    for (let i = 0; i < this.instructions.length; i++) {
      if (this.aborted) {
        this.onStep(i, "aborted", "用户中止");
        this.results.push({ status: "cancelled", result: "用户中止" });
        break;
      }

      // Skip unchecked steps
      if (this.skipSteps.has(i)) {
        this.onStep(i, "skipped", "用户跳过");
        this.results.push({ status: "cancelled", result: "用户跳过" });
        continue;
      }

      const inst = this.instructions[i];
      this.onStep(i, "running", null);

      try {
        const outcome = await executeInstruction(inst);
        this.results.push(outcome);
        this.onStep(i, outcome.status, outcome.result);

        if (outcome.status === "failed") {
          // Abort remaining steps on failure
          for (let j = i + 1; j < this.instructions.length; j++) {
            this.results.push({ status: "cancelled", result: "前序步骤失败，已跳过" });
            this.onStep(j, "cancelled", "前序步骤失败，已跳过");
          }
          break;
        }
      } catch (e) {
        const errResult = { status: "failed", result: String(e.message || e) };
        this.results.push(errResult);
        this.onStep(i, "failed", errResult.result);
        break;
      }
    }
    return this.results;
  }
}
