import { randomUUID } from "node:crypto";
import { getApprovalMode } from "../approvals/policy.js";
import { RuntimeError } from "../errors.js";
import { errorToLogDetails } from "../observability/logger.js";
import { resolveWorkspacePath } from "../security/path-guard.js";
import { redactValue } from "../security/redaction.js";
import type {
  ApprovalDecision,
  ApprovalPolicyConfig,
  ApprovalRequest,
  ExternalAgentAdapter,
  ExternalAgentDelegationRequest,
  ExternalAgentDelegationResult,
  ExternalAgentOutputContract,
  ExternalAgentSummary,
  RunloomAuditRecord,
  RunloomEvent
} from "../types.js";

export interface ExternalAgentRuntimeOptions {
  workspace: string;
  getApprovalPolicy: () => ApprovalPolicyConfig;
  saveApproval: (request: ApprovalRequest) => void;
  getApprovalDecision: (approvalId: string) => ApprovalDecision | undefined;
  emit: (type: string, source: RunloomEvent["source"], runId: string, sessionId: string, payload: unknown) => void;
  recordAudit: (input: Omit<RunloomAuditRecord, "id" | "timestamp">) => void;
}

export class ExternalAgentRuntime {
  private readonly adapters = new Map<string, ExternalAgentAdapter>();

  constructor(private readonly options: ExternalAgentRuntimeOptions) {}

  async listAgents(): Promise<ExternalAgentSummary[]> {
    return [...this.adapters.values()]
      .map(summarizeExternalAgent)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async registerAgent(adapter: ExternalAgentAdapter): Promise<void> {
    this.adapters.set(adapter.name, cloneExternalAgentAdapter(adapter));
  }

  async delegateAgent(
    name: string,
    request: ExternalAgentDelegationRequest
  ): Promise<ExternalAgentDelegationResult> {
    const started = Date.now();
    const runId = request.runId ?? `external_${randomUUID()}`;
    const sessionId = request.sessionId ?? "global";
    const adapter = this.adapters.get(name);

    if (!adapter) {
      return this.failDelegation(name, runId, sessionId, started, `External agent not registered: ${name}`, {
        reason: "not_registered"
      });
    }

    let normalizedRequest: ExternalAgentDelegationRequest;
    try {
      normalizedRequest = this.normalizeDelegationRequest(adapter, request);
    } catch (error) {
      return this.failDelegation(name, runId, sessionId, started, errorMessage(error), {
        reason: "invalid_request",
        error: errorToLogDetails(error)
      });
    }

    this.options.emit("external_agent.delegated", "external_agent", runId, sessionId, {
      name,
      kind: adapter.kind,
      workspace: normalizedRequest.workspace,
      maxTurns: normalizedRequest.maxTurns,
      constraints: normalizedRequest.constraints,
      expectedOutput: normalizedRequest.expectedOutput,
      contextItems: normalizedRequest.context?.length ?? 0
    });

    if (adapter.enabled === false) {
      return this.failDelegation(name, runId, sessionId, started, `External agent is disabled: ${name}`, {
        reason: "disabled",
        workspace: normalizedRequest.workspace
      });
    }

    if (!adapter.delegate) {
      return this.failDelegation(
        name,
        runId,
        sessionId,
        started,
        `External agent delegate is not implemented: ${name}`,
        {
          reason: "delegate_missing",
          workspace: normalizedRequest.workspace
        }
      );
    }

    const approvalResult = this.checkDelegationApproval(name, adapter, normalizedRequest, runId, sessionId);
    if (approvalResult) {
      return approvalResult;
    }

    try {
      const result = await adapter.delegate(cloneExternalAgentDelegationRequest(normalizedRequest));
      const contractedResult = applyExternalAgentOutputContract(result, normalizedRequest.expectedOutput);
      const safeResult = redactValue(cloneExternalAgentDelegationResult(contractedResult), { workspace: this.options.workspace });
      const durationMs = Date.now() - started;
      for (const event of safeResult.events ?? []) {
        this.options.emit("external_agent.event", "external_agent", runId, sessionId, {
          name,
          event
        });
      }
      this.options.emit(
        safeResult.status === "completed" ? "external_agent.completed" : "external_agent.failed",
        "external_agent",
        runId,
        sessionId,
        {
          name,
          durationMs,
          result: safeResult
        }
      );
      this.options.recordAudit({
        action: "external_agent.delegated",
        actor: "runtime",
        summary: `External agent delegated: ${name}`,
        runId,
        sessionId,
        details: {
          name,
          status: safeResult.status,
          workspace: normalizedRequest.workspace,
          maxTurns: normalizedRequest.maxTurns,
          eventCount: safeResult.events?.length ?? 0,
          durationMs
        }
      });
      return safeResult;
    } catch (error) {
      return this.failDelegation(name, runId, sessionId, started, errorMessage(error), {
        reason: "delegate_failed",
        workspace: normalizedRequest.workspace,
        error: errorToLogDetails(error)
      });
    }
  }

  private normalizeDelegationRequest(
    adapter: ExternalAgentAdapter,
    request: ExternalAgentDelegationRequest
  ): ExternalAgentDelegationRequest {
    const task = request.task.trim();
    if (!task) {
      throw new RuntimeError("External agent delegation task is required.", {
        code: "external_agent.task_required"
      });
    }

    const adapterMaxTurns = normalizeExternalAgentMaxTurns(adapter.maxTurns);
    const requestedMaxTurns = normalizeExternalAgentMaxTurns(request.maxTurns ?? adapterMaxTurns);
    return {
      task,
      workspace: resolveWorkspacePath(this.options.workspace, request.workspace || "."),
      runId: request.runId,
      sessionId: request.sessionId,
      approvalId: request.approvalId,
      maxTurns: Math.min(requestedMaxTurns, adapterMaxTurns),
      constraints: request.constraints ? [...request.constraints] : undefined,
      expectedOutput: request.expectedOutput ? cloneExternalAgentOutputContract(request.expectedOutput) : undefined,
      context: request.context ? request.context.map((item) => ({ ...item })) : undefined
    };
  }

  private checkDelegationApproval(
    name: string,
    adapter: ExternalAgentAdapter,
    request: ExternalAgentDelegationRequest,
    runId: string,
    sessionId: string
  ): ExternalAgentDelegationResult | undefined {
    const mode = getApprovalMode(this.options.getApprovalPolicy(), "external_agents");
    const risk: ApprovalRequest["risk"] = "high";

    if (request.approvalId) {
      const decision = this.options.getApprovalDecision(request.approvalId);
      if (!decision) {
        return {
          status: "waiting_approval",
          summary: `External agent delegation is waiting for approval: ${name}`,
          approvalId: request.approvalId
        };
      }
      if (decision.decision === "denied") {
        return this.cancelAfterDeniedApproval(name, request, runId, sessionId);
      }
      this.options.emit("external_agent.approved", "external_agent", runId, sessionId, {
        name,
        approvalId: request.approvalId
      });
      return undefined;
    }

    if (!requiresExternalAgentApproval(mode, risk)) {
      return undefined;
    }

    const approval: ApprovalRequest = {
      id: `approval_${randomUUID()}`,
      runId,
      sessionId,
      scope: "external_agents",
      action: `external_agent:${name}`,
      risk,
      mode,
      summary: `Runloom wants to delegate to external agent ${name}.`,
      details: {
        name,
        kind: adapter.kind,
        task: request.task,
        workspace: request.workspace,
        maxTurns: request.maxTurns,
        constraints: request.constraints,
        expectedOutput: request.expectedOutput,
        contextItems: request.context?.length ?? 0
      }
    };

    this.options.saveApproval(approval);
    this.options.emit("approval.requested", "approval", runId, sessionId, approval);
    this.options.emit("external_agent.approval_requested", "external_agent", runId, sessionId, {
      name,
      approvalId: approval.id,
      mode,
      risk
    });
    this.options.recordAudit({
      action: "external_agent.approval_requested",
      actor: "runtime",
      summary: `External agent delegation approval requested: ${name}`,
      runId,
      sessionId,
      details: {
        name,
        approvalId: approval.id,
        mode,
        risk,
        maxTurns: request.maxTurns,
        expectedOutput: request.expectedOutput
      }
    });
    return {
      status: "waiting_approval",
      summary: `External agent delegation is waiting for approval: ${name}`,
      approvalId: approval.id
    };
  }

  private cancelAfterDeniedApproval(
    name: string,
    request: ExternalAgentDelegationRequest,
    runId: string,
    sessionId: string
  ): ExternalAgentDelegationResult {
    const result: ExternalAgentDelegationResult = {
      status: "cancelled",
      summary: `External agent delegation denied: ${name}`,
      approvalId: request.approvalId,
      diagnostics: [`External agent delegation denied: ${name}`]
    };
    this.options.emit("external_agent.failed", "external_agent", runId, sessionId, {
      name,
      approvalId: request.approvalId,
      result
    });
    this.options.recordAudit({
      action: "external_agent.delegated",
      actor: "runtime",
      summary: `External agent delegation denied: ${name}`,
      runId,
      sessionId,
      details: {
        name,
        status: "cancelled",
        approvalId: request.approvalId,
        maxTurns: request.maxTurns
      }
    });
    return result;
  }

  private failDelegation(
    name: string,
    runId: string,
    sessionId: string,
    started: number,
    message: string,
    details: Record<string, unknown>
  ): ExternalAgentDelegationResult {
    const durationMs = Date.now() - started;
    const result: ExternalAgentDelegationResult = {
      status: "failed",
      summary: message,
      diagnostics: [message]
    };
    const safeResult = redactValue(result, { workspace: this.options.workspace });
    this.options.emit("external_agent.failed", "external_agent", runId, sessionId, {
      name,
      durationMs,
      result: safeResult
    });
    this.options.recordAudit({
      action: "external_agent.delegated",
      actor: "runtime",
      summary: `External agent delegation failed: ${name}`,
      runId,
      sessionId,
      details: {
        name,
        status: "failed",
        durationMs,
        ...details
      }
    });
    return safeResult;
  }
}

function cloneExternalAgentAdapter(adapter: ExternalAgentAdapter): ExternalAgentAdapter {
  return {
    ...adapter,
    capabilities: adapter.capabilities ? [...adapter.capabilities] : undefined
  };
}

function summarizeExternalAgent(adapter: ExternalAgentAdapter): ExternalAgentSummary {
  const enabled = adapter.enabled ?? true;
  return {
    name: adapter.name,
    description: adapter.description,
    kind: adapter.kind,
    enabled,
    status: adapter.status ?? (enabled ? "available" : "disabled"),
    capabilities: adapter.capabilities ? [...adapter.capabilities] : undefined,
    command: adapter.command,
    maxTurns: adapter.maxTurns,
    error: adapter.error
  };
}

function normalizeExternalAgentMaxTurns(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 3;
  }
  return Math.max(1, Math.floor(value));
}

function requiresExternalAgentApproval(mode: ApprovalRequest["mode"], risk: ApprovalRequest["risk"]): boolean {
  if (mode === "full_access") {
    return false;
  }
  if (mode === "ask") {
    return true;
  }
  return risk === "high" || risk === "critical";
}

function cloneExternalAgentDelegationRequest(
  request: ExternalAgentDelegationRequest
): ExternalAgentDelegationRequest {
  return {
    ...request,
    constraints: request.constraints ? [...request.constraints] : undefined,
    expectedOutput: request.expectedOutput ? cloneExternalAgentOutputContract(request.expectedOutput) : undefined,
    context: request.context ? request.context.map((item) => ({ ...item })) : undefined
  };
}

function cloneExternalAgentDelegationResult(result: ExternalAgentDelegationResult): ExternalAgentDelegationResult {
  return {
    ...result,
    changedFiles: result.changedFiles ? [...result.changedFiles] : undefined,
    verificationNotes: result.verificationNotes ? [...result.verificationNotes] : undefined,
    events: result.events ? result.events.map((event) => ({ ...event })) : undefined,
    diagnostics: result.diagnostics ? [...result.diagnostics] : undefined
  };
}

function cloneExternalAgentOutputContract(contract: ExternalAgentOutputContract): ExternalAgentOutputContract {
  return {
    ...contract,
    schema: contract.schema ? { ...contract.schema } : undefined
  };
}

function applyExternalAgentOutputContract(
  result: ExternalAgentDelegationResult,
  contract?: ExternalAgentOutputContract
): ExternalAgentDelegationResult {
  const cloned = cloneExternalAgentDelegationResult(result);
  if (!contract || cloned.status !== "completed") {
    return cloned;
  }

  const diagnostics = validateExternalAgentOutputContract(cloned, contract);
  if (diagnostics.length === 0) {
    return cloned;
  }

  return {
    ...cloned,
    status: "failed",
    summary: `External agent output contract failed: ${diagnostics.join("; ")}`,
    diagnostics: [...(cloned.diagnostics ?? []), ...diagnostics]
  };
}

function validateExternalAgentOutputContract(
  result: ExternalAgentDelegationResult,
  contract: ExternalAgentOutputContract
): string[] {
  const diagnostics: string[] = [];
  const outputText = result.outputText?.trim() ?? "";

  if (contract.format === "summary" && !result.summary.trim()) {
    diagnostics.push("summary output is required");
  }
  if (contract.format === "json" && result.structuredOutput === undefined && !isJsonText(outputText)) {
    diagnostics.push("json output is required");
  }
  if (contract.format === "patch" && outputText.length === 0) {
    diagnostics.push("patch output text is required");
  }
  if (contract.format === "report" && (!result.summary.trim() || outputText.length === 0)) {
    diagnostics.push("report summary and output text are required");
  }
  if (contract.requireChangedFilesSummary && (!result.changedFiles || result.changedFiles.length === 0)) {
    diagnostics.push("changed files summary is required");
  }
  if (contract.requireVerificationNotes && (!result.verificationNotes || result.verificationNotes.length === 0)) {
    diagnostics.push("verification notes are required");
  }

  return diagnostics;
}

function isJsonText(text: string): boolean {
  if (!text) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
