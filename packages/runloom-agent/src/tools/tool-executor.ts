import { randomUUID } from "node:crypto";
import { getApprovalMode } from "../approvals/policy.js";
import { errorToLogDetails, emitLog } from "../observability/logger.js";
import { redactValue } from "../security/redaction.js";
import type {
  ApprovalPolicyConfig,
  ApprovalRequest,
  RunloomEvent,
  RunloomLogger,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult
} from "../types.js";

export interface ToolExecutorOptions {
  workspace: string;
  getApprovalPolicy(): ApprovalPolicyConfig;
  saveApproval(request: ApprovalRequest): void;
  emit(type: string, source: RunloomEvent["source"], runId: string, sessionId: string, payload: unknown): void;
  logger?: RunloomLogger;
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
    const safeInput = redactValue(input, { workspace: fullContext.workspace });

    this.options.emit("tool.call.requested", "tool", runId, sessionId, {
      toolName: tool.name,
      inputSummary: summarize(safeInput),
      permissions: tool.permissions
    });
    this.log(
      {
        level: "debug",
        code: "tool.call.requested",
        message: `Tool call requested: ${tool.name}`,
        runId,
        sessionId,
        details: {
          toolName: tool.name,
          inputSummary: summarize(safeInput),
          permissions: tool.permissions
        }
      },
      fullContext.workspace
    );

    const approval = this.checkApproval(tool, safeInput, runId, sessionId);
    if (approval) {
      this.options.saveApproval(approval);
      this.options.emit("approval.requested", "approval", runId, sessionId, approval);
      this.log(
        {
          level: "warn",
          code: "approval.requested",
          message: `Approval requested for ${tool.name}.`,
          runId,
          sessionId,
          details: approval
        },
        fullContext.workspace
      );
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
      const safeOutput = redactValue(output, { workspace: fullContext.workspace });
      const durationMs = Date.now() - started;
      this.options.emit("tool.call.completed", "tool", runId, sessionId, {
        toolName: tool.name,
        outputSummary: summarize(safeOutput),
        durationMs
      });
      this.log(
        {
          level: "info",
          code: "tool.call.completed",
          message: `Tool call completed: ${tool.name}`,
          runId,
          sessionId,
          details: {
            toolName: tool.name,
            outputSummary: summarize(safeOutput),
            durationMs
          }
        },
        fullContext.workspace
      );
      return {
        toolName: tool.name,
        runId,
        sessionId,
        status: "completed",
        output: safeOutput,
        durationMs
      };
    } catch (error) {
      const durationMs = Date.now() - started;
      const message = redactValue(error instanceof Error ? error.message : String(error), {
        workspace: fullContext.workspace
      });
      this.options.emit("tool.call.failed", "tool", runId, sessionId, {
        toolName: tool.name,
        error: message,
        durationMs
      });
      this.log(
        {
          level: "error",
          code: "tool.call.failed",
          message: `Tool call failed: ${tool.name}`,
          runId,
          sessionId,
          details: {
            toolName: tool.name,
            error: message,
            errorDetails: errorToLogDetails(error),
            durationMs
          }
        },
        fullContext.workspace
      );
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

  private checkApproval(tool: ToolDefinition, input: unknown, runId: string, sessionId: string): ApprovalRequest | undefined {
    for (const scope of tool.permissions) {
      const mode = getApprovalMode(this.options.getApprovalPolicy(), scope);
      const risk = riskForScope(scope);
      if (requiresApproval(mode, risk)) {
        return {
          id: `approval_${randomUUID()}`,
          runId,
          sessionId,
          scope,
          action: `tool:${tool.name}`,
          risk,
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

  private log(input: Parameters<typeof emitLog>[1], workspace: string): void {
    emitLog(this.options.logger, { source: "tool", ...input }, workspace);
  }
}

function requiresApproval(mode: ApprovalRequest["mode"], risk: ApprovalRequest["risk"]): boolean {
  if (mode === "full_access") {
    return false;
  }
  if (mode === "ask") {
    return true;
  }
  return risk === "high" || risk === "critical";
}

function riskForScope(scope: ApprovalRequest["scope"]): ApprovalRequest["risk"] {
  if (scope === "filesystem.read") {
    return "low";
  }
  if (scope === "filesystem.delete" || scope === "identity.write" || scope === "evolution.apply" || scope === "npm.publish") {
    return "critical";
  }
  if (
    scope === "filesystem.write" ||
    scope === "shell" ||
    scope === "browser" ||
    scope === "gui" ||
    scope === "external_agents" ||
    scope === "a2a.delegation" ||
    scope === "tools.register" ||
    scope === "skills.register"
  ) {
    return "high";
  }
  return "medium";
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
