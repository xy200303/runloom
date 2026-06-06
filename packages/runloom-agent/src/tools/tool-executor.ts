import { randomUUID } from "node:crypto";
import { getApprovalMode } from "../approvals/policy.js";
import type {
  ApprovalPolicyConfig,
  ApprovalRequest,
  RunloomEvent,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult
} from "../types.js";

export interface ToolExecutorOptions {
  workspace: string;
  getApprovalPolicy(): ApprovalPolicyConfig;
  saveApproval(request: ApprovalRequest): void;
  emit(type: string, source: RunloomEvent["source"], runId: string, sessionId: string, payload: unknown): void;
}

export class ToolExecutor {
  constructor(private readonly options: ToolExecutorOptions) {}

  async execute<TOutput>(
    tool: ToolDefinition,
    input: unknown,
    context: Omit<ToolContext, "workspace"> & { workspace?: string }
  ): Promise<ToolExecutionResult<TOutput>> {
    const started = Date.now();
    const runId = context.runId;
    const sessionId = context.sessionId;
    const fullContext: ToolContext = {
      workspace: context.workspace ?? this.options.workspace,
      runId,
      sessionId,
      signal: context.signal
    };

    this.options.emit("tool.call.requested", "tool", runId, sessionId, {
      toolName: tool.name,
      inputSummary: summarize(input),
      permissions: tool.permissions
    });

    const approval = this.checkApproval(tool, input, runId);
    if (approval) {
      this.options.saveApproval(approval);
      this.options.emit("approval.requested", "approval", runId, sessionId, approval);
      return {
        toolName: tool.name,
        runId,
        sessionId,
        status: "waiting_approval",
        approvalId: approval.id,
        durationMs: Date.now() - started
      };
    }

    this.options.emit("tool.call.started", "tool", runId, sessionId, {
      toolName: tool.name
    });

    try {
      const output = (await tool.execute(input, fullContext)) as TOutput;
      const durationMs = Date.now() - started;
      this.options.emit("tool.call.completed", "tool", runId, sessionId, {
        toolName: tool.name,
        outputSummary: summarize(output),
        durationMs
      });
      return {
        toolName: tool.name,
        runId,
        sessionId,
        status: "completed",
        output,
        durationMs
      };
    } catch (error) {
      const durationMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      this.options.emit("tool.call.failed", "tool", runId, sessionId, {
        toolName: tool.name,
        error: message,
        durationMs
      });
      return {
        toolName: tool.name,
        runId,
        sessionId,
        status: "failed",
        error: message,
        durationMs
      };
    }
  }

  private checkApproval(tool: ToolDefinition, input: unknown, runId: string): ApprovalRequest | undefined {
    for (const scope of tool.permissions) {
      const mode = getApprovalMode(this.options.getApprovalPolicy(), scope);
      if (mode === "ask") {
        return {
          id: `approval_${randomUUID()}`,
          runId,
          scope,
          action: `tool:${tool.name}`,
          risk: scope === "shell" || scope.includes("write") || scope.includes("delete") ? "high" : "medium",
          mode,
          summary: `Runloom wants to execute ${tool.name}.`,
          details: {
            toolName: tool.name,
            input
          }
        };
      }
    }
    return undefined;
  }
}

function summarize(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 800 ? `${json.slice(0, 800)}...[truncated]` : value;
  } catch {
    return "[unserializable]";
  }
}
