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
  A2ADelegationRequest,
  A2ADelegationResult,
  A2AOutputContract,
  A2APeerRegistration,
  A2APeerSummary,
  RunloomAuditRecord,
  RunloomEvent
} from "../types.js";

export interface A2APeerRuntimeOptions {
  workspace: string;
  getApprovalPolicy: () => ApprovalPolicyConfig;
  saveApproval: (request: ApprovalRequest) => void;
  getApprovalDecision: (approvalId: string) => ApprovalDecision | undefined;
  emit: (type: string, source: RunloomEvent["source"], runId: string, sessionId: string, payload: unknown) => void;
  recordAudit: (input: Omit<RunloomAuditRecord, "id" | "timestamp">) => void;
}

export class A2APeerRuntime {
  private readonly peers = new Map<string, A2APeerRegistration>();

  constructor(private readonly options: A2APeerRuntimeOptions) {}

  async listPeers(): Promise<A2APeerSummary[]> {
    return [...this.peers.values()]
      .map(summarizeA2APeer)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async registerPeer(peer: A2APeerRegistration): Promise<void> {
    const cloned = cloneA2APeerRegistration(peer);
    this.peers.set(cloned.id, cloned);
    this.options.emit("a2a.peer.discovered", "a2a", "a2a", "global", summarizeA2APeer(cloned));
  }

  async delegatePeer(peerId: string, request: A2ADelegationRequest): Promise<A2ADelegationResult> {
    const started = Date.now();
    const runId = request.runId ?? `a2a_${randomUUID()}`;
    const sessionId = request.sessionId ?? "global";
    const peer = this.peers.get(peerId);

    if (!peer) {
      return this.failDelegation(peerId, runId, sessionId, started, `A2A peer not registered: ${peerId}`, {
        reason: "not_registered"
      });
    }

    let normalizedRequest: A2ADelegationRequest;
    try {
      normalizedRequest = this.normalizeDelegationRequest(peer, request);
    } catch (error) {
      return this.failDelegation(peerId, runId, sessionId, started, errorMessage(error), {
        reason: "invalid_request",
        error: errorToLogDetails(error)
      });
    }

    this.options.emit("a2a.delegated", "a2a", runId, sessionId, {
      peerId,
      name: peer.name,
      capability: normalizedRequest.capability,
      workspace: normalizedRequest.workspace,
      constraints: normalizedRequest.constraints,
      expectedOutput: normalizedRequest.expectedOutput,
      contextItems: normalizedRequest.context?.length ?? 0
    });

    if (peer.enabled === false || peer.status === "disabled") {
      return this.failDelegation(peerId, runId, sessionId, started, `A2A peer is disabled: ${peerId}`, {
        reason: "disabled",
        workspace: normalizedRequest.workspace
      });
    }

    if (peer.status !== "available") {
      return this.failDelegation(peerId, runId, sessionId, started, `A2A peer is not available: ${peerId}`, {
        reason: "unavailable",
        status: peer.status,
        workspace: normalizedRequest.workspace
      });
    }

    if (!peer.delegate) {
      return this.failDelegation(peerId, runId, sessionId, started, `A2A peer delegate is not implemented: ${peerId}`, {
        reason: "delegate_missing",
        workspace: normalizedRequest.workspace
      });
    }

    const approvalResult = this.checkDelegationApproval(peer, normalizedRequest, runId, sessionId);
    if (approvalResult) {
      return approvalResult;
    }

    try {
      const result = await peer.delegate(cloneA2ADelegationRequest(normalizedRequest));
      const contractedResult = applyA2AOutputContract(result, normalizedRequest.expectedOutput);
      const safeResult = redactValue(cloneA2ADelegationResult(contractedResult), { workspace: this.options.workspace });
      const durationMs = Date.now() - started;
      for (const event of safeResult.events ?? []) {
        this.options.emit("a2a.event", "a2a", runId, sessionId, {
          peerId,
          event
        });
      }
      this.options.emit(safeResult.status === "completed" ? "a2a.completed" : "a2a.failed", "a2a", runId, sessionId, {
        peerId,
        durationMs,
        result: safeResult
      });
      this.options.recordAudit({
        action: "a2a.delegated",
        actor: "runtime",
        summary: `A2A peer delegated: ${peerId}`,
        runId,
        sessionId,
        details: {
          peerId,
          status: safeResult.status,
          capability: normalizedRequest.capability,
          workspace: normalizedRequest.workspace,
          expectedOutput: normalizedRequest.expectedOutput,
          eventCount: safeResult.events?.length ?? 0,
          durationMs
        }
      });
      return safeResult;
    } catch (error) {
      return this.failDelegation(peerId, runId, sessionId, started, errorMessage(error), {
        reason: "delegate_failed",
        workspace: normalizedRequest.workspace,
        error: errorToLogDetails(error)
      });
    }
  }

  private normalizeDelegationRequest(
    peer: A2APeerRegistration,
    request: A2ADelegationRequest
  ): A2ADelegationRequest {
    const task = request.task.trim();
    if (!task) {
      throw new RuntimeError("A2A delegation task is required.", {
        code: "a2a.task_required"
      });
    }

    const capability = request.capability?.trim();
    if (capability && peer.capabilities?.length && !peer.capabilities.some((item) => item.name === capability)) {
      throw new RuntimeError(`A2A peer capability is not registered: ${capability}`, {
        code: "a2a.capability_not_registered",
        details: {
          peerId: peer.id,
          capability
        }
      });
    }

    return {
      task,
      workspace: resolveWorkspacePath(this.options.workspace, request.workspace || "."),
      runId: request.runId,
      sessionId: request.sessionId,
      approvalId: request.approvalId,
      capability: capability || undefined,
      constraints: request.constraints ? [...request.constraints] : undefined,
      expectedOutput: request.expectedOutput ? cloneA2AOutputContract(request.expectedOutput) : undefined,
      context: request.context ? request.context.map((item) => ({ ...item })) : undefined
    };
  }

  private checkDelegationApproval(
    peer: A2APeerRegistration,
    request: A2ADelegationRequest,
    runId: string,
    sessionId: string
  ): A2ADelegationResult | undefined {
    const mode = getApprovalMode(this.options.getApprovalPolicy(), "a2a.delegation");
    const risk: ApprovalRequest["risk"] = "high";

    if (request.approvalId) {
      const decision = this.options.getApprovalDecision(request.approvalId);
      if (!decision) {
        return {
          status: "waiting_approval",
          summary: `A2A delegation is waiting for approval: ${peer.id}`,
          approvalId: request.approvalId
        };
      }
      if (decision.decision === "denied") {
        return this.cancelAfterDeniedApproval(peer, request, runId, sessionId);
      }
      this.options.emit("a2a.approved", "a2a", runId, sessionId, {
        peerId: peer.id,
        approvalId: request.approvalId
      });
      return undefined;
    }

    if (!requiresA2ADelegationApproval(mode, risk)) {
      return undefined;
    }

    const approval: ApprovalRequest = {
      id: `approval_${randomUUID()}`,
      runId,
      sessionId,
      scope: "a2a.delegation",
      action: `a2a:${peer.id}`,
      risk,
      mode,
      summary: `Runloom wants to delegate to A2A peer ${peer.name}.`,
      details: {
        peerId: peer.id,
        name: peer.name,
        endpoint: peer.endpoint,
        transport: peer.transport,
        capability: request.capability,
        task: request.task,
        workspace: request.workspace,
        constraints: request.constraints,
        expectedOutput: request.expectedOutput,
        contextItems: request.context?.length ?? 0
      }
    };

    this.options.saveApproval(approval);
    this.options.emit("approval.requested", "approval", runId, sessionId, approval);
    this.options.emit("a2a.approval_requested", "a2a", runId, sessionId, {
      peerId: peer.id,
      approvalId: approval.id,
      mode,
      risk
    });
    this.options.recordAudit({
      action: "a2a.approval_requested",
      actor: "runtime",
      summary: `A2A delegation approval requested: ${peer.id}`,
      runId,
      sessionId,
      details: {
        peerId: peer.id,
        approvalId: approval.id,
        mode,
        risk,
        capability: request.capability,
        expectedOutput: request.expectedOutput
      }
    });
    return {
      status: "waiting_approval",
      summary: `A2A delegation is waiting for approval: ${peer.id}`,
      approvalId: approval.id
    };
  }

  private cancelAfterDeniedApproval(
    peer: A2APeerRegistration,
    request: A2ADelegationRequest,
    runId: string,
    sessionId: string
  ): A2ADelegationResult {
    const result: A2ADelegationResult = {
      status: "cancelled",
      summary: `A2A delegation denied: ${peer.id}`,
      approvalId: request.approvalId,
      diagnostics: [`A2A delegation denied: ${peer.id}`]
    };
    this.options.emit("a2a.failed", "a2a", runId, sessionId, {
      peerId: peer.id,
      approvalId: request.approvalId,
      result
    });
    this.options.recordAudit({
      action: "a2a.delegated",
      actor: "runtime",
      summary: `A2A delegation denied: ${peer.id}`,
      runId,
      sessionId,
      details: {
        peerId: peer.id,
        status: "cancelled",
        approvalId: request.approvalId,
        capability: request.capability
      }
    });
    return result;
  }

  private failDelegation(
    peerId: string,
    runId: string,
    sessionId: string,
    started: number,
    message: string,
    details: Record<string, unknown>
  ): A2ADelegationResult {
    const durationMs = Date.now() - started;
    const result: A2ADelegationResult = {
      status: "failed",
      summary: message,
      diagnostics: [message]
    };
    const safeResult = redactValue(result, { workspace: this.options.workspace });
    this.options.emit("a2a.failed", "a2a", runId, sessionId, {
      peerId,
      durationMs,
      result: safeResult
    });
    this.options.recordAudit({
      action: "a2a.delegated",
      actor: "runtime",
      summary: `A2A delegation failed: ${peerId}`,
      runId,
      sessionId,
      details: {
        peerId,
        status: "failed",
        durationMs,
        ...details
      }
    });
    return safeResult;
  }
}

function cloneA2APeer(peer: A2APeerSummary): A2APeerSummary {
  return {
    id: peer.id,
    name: peer.name,
    version: peer.version,
    endpoint: peer.endpoint,
    transport: peer.transport,
    enabled: peer.enabled,
    status: peer.status,
    error: peer.error,
    capabilities: peer.capabilities
      ? peer.capabilities.map((capability) => ({
          ...capability,
          inputSchema: capability.inputSchema ? { ...capability.inputSchema } : undefined,
          outputSchema: capability.outputSchema ? { ...capability.outputSchema } : undefined
        }))
      : undefined
  };
}

function cloneA2APeerRegistration(peer: A2APeerRegistration): A2APeerRegistration {
  return {
    ...cloneA2APeer(peer),
    delegate: peer.delegate
  };
}

function summarizeA2APeer(peer: A2APeerRegistration): A2APeerSummary {
  return cloneA2APeer(peer);
}

function requiresA2ADelegationApproval(mode: ApprovalRequest["mode"], risk: ApprovalRequest["risk"]): boolean {
  if (mode === "full_access") {
    return false;
  }
  if (mode === "ask") {
    return true;
  }
  return risk === "high" || risk === "critical";
}

function cloneA2ADelegationRequest(request: A2ADelegationRequest): A2ADelegationRequest {
  return {
    ...request,
    constraints: request.constraints ? [...request.constraints] : undefined,
    expectedOutput: request.expectedOutput ? cloneA2AOutputContract(request.expectedOutput) : undefined,
    context: request.context ? request.context.map((item) => ({ ...item })) : undefined
  };
}

function cloneA2ADelegationResult(result: A2ADelegationResult): A2ADelegationResult {
  return {
    ...result,
    evidence: result.evidence ? [...result.evidence] : undefined,
    changedFiles: result.changedFiles ? [...result.changedFiles] : undefined,
    verificationNotes: result.verificationNotes ? [...result.verificationNotes] : undefined,
    limitations: result.limitations ? [...result.limitations] : undefined,
    events: result.events ? result.events.map((event) => ({ ...event })) : undefined,
    diagnostics: result.diagnostics ? [...result.diagnostics] : undefined
  };
}

function cloneA2AOutputContract(contract: A2AOutputContract): A2AOutputContract {
  return {
    ...contract,
    schema: contract.schema ? { ...contract.schema } : undefined
  };
}

function applyA2AOutputContract(
  result: A2ADelegationResult,
  contract?: A2AOutputContract
): A2ADelegationResult {
  const cloned = cloneA2ADelegationResult(result);
  if (!contract || cloned.status !== "completed") {
    return cloned;
  }

  const diagnostics = validateA2AOutputContract(cloned, contract);
  if (diagnostics.length === 0) {
    return cloned;
  }

  return {
    ...cloned,
    status: "failed",
    summary: `A2A output contract failed: ${diagnostics.join("; ")}`,
    diagnostics: [...(cloned.diagnostics ?? []), ...diagnostics]
  };
}

function validateA2AOutputContract(result: A2ADelegationResult, contract: A2AOutputContract): string[] {
  const diagnostics: string[] = [];
  const outputText = result.outputText?.trim() ?? "";

  if (contract.format === "summary" && !result.summary.trim()) {
    diagnostics.push("summary output is required");
  }
  if (contract.format === "json" && result.structuredOutput === undefined && !isJsonText(outputText)) {
    diagnostics.push("json output is required");
  }
  if (contract.format === "report" && (!result.summary.trim() || outputText.length === 0)) {
    diagnostics.push("report summary and output text are required");
  }
  if (contract.requireEvidence && (!result.evidence || result.evidence.length === 0)) {
    diagnostics.push("evidence is required");
  }
  if (contract.requireChangedFilesSummary && (!result.changedFiles || result.changedFiles.length === 0)) {
    diagnostics.push("changed files summary is required");
  }
  if (contract.requireVerificationNotes && (!result.verificationNotes || result.verificationNotes.length === 0)) {
    diagnostics.push("verification notes are required");
  }
  if (contract.requireLimitations && (!result.limitations || result.limitations.length === 0)) {
    diagnostics.push("limitations are required");
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
