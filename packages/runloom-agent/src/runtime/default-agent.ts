import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FileApprovalPolicyStore } from "../approvals/file-policy-store.js";
import { applyApprovalPolicyPatch, createDefaultApprovalPolicy } from "../approvals/policy.js";
import { A2APeerRuntime } from "../a2a/peer-runtime.js";
import { buildWorkspaceContext, inspectWorkspace } from "../coding/workspace-summary.js";
import { loadRunloomConfig } from "../config/runloom-config.js";
import { ApprovalError, ProviderError, RuntimeError, ToolError } from "../errors.js";
import { RunloomEventBus } from "../events/event-bus.js";
import { ExternalAgentRuntime } from "../external-agents/runtime.js";
import { ConfiguredMcpRuntime } from "../mcp/runtime.js";
import { RunloomMcpServerRuntime } from "../mcp/server-runtime.js";
import { errorToLogDetails, emitLog } from "../observability/logger.js";
import { ModelProviderRegistry } from "../providers/registry.js";
import { redactText, redactValue } from "../security/redaction.js";
import { FileRuntimeStateStore } from "../sessions/file-runtime-state-store.js";
import { InMemorySessionStore } from "../sessions/in-memory-store.js";
import { SkillRuntime } from "../skills/runtime.js";
import { createBuiltInCodingTools } from "../tools/coding-tools.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import {
  buildDiagnosticsContext,
  buildSystemPrompt,
  normalizeSubmitInput,
  outputDelta,
  stringifyToolResult
} from "./model-loop-support.js";
import {
  RunArtifactRecorder
} from "./run-artifacts.js";
import { RunQueryRuntime } from "./run-queries.js";
import { RuntimeStateManager } from "./runtime-state.js";
import type {
  PendingModelContinuation,
  RuntimeRunRecord
} from "./runtime-state.js";
import type {
  ApprovalDecision,
  ApprovalPolicyConfig,
  ApprovalPolicyPatch,
  ApprovalRequest,
  A2ADelegationRequest,
  A2ADelegationResult,
  A2APeerRegistration,
  A2APeerSummary,
  CreateRunloomMcpServerOptions,
  CreateRunloomSkillProposalInput,
  CreateRunloomSkillProposalOptions,
  CreateRunloomAgentOptions,
  ExecuteToolOptions,
  ExternalAgentAdapter,
  ExternalAgentDelegationRequest,
  ExternalAgentDelegationResult,
  ExternalAgentSummary,
  ListAuditRecordsOptions,
  ListDeliverySummariesOptions,
  ListDiffRecordsOptions,
  ListEditPlansOptions,
  ListEventsOptions,
  ListMessagesOptions,
  ListReviewFindingsOptions,
  ListRunsOptions,
  ListSkillProposalsOptions,
  McpServerSummary,
  ModelSelectionResult,
  ModelProvider,
  ModelProviderEvent,
  RunloomConfig,
  RunloomModelInputItem,
  RunloomModelTool,
  RunResult,
  RunloomAgent,
  RunloomEvent,
  RunloomEventListener,
  RunloomAuditRecord,
  RunloomDeliverySummary,
  RunloomDiffRecord,
  RunloomDiagnostic,
  RunloomEditPlan,
  RunloomInput,
  RunloomMessage,
  RunloomMcpServerAdapter,
  RunloomReviewFindings,
  RunloomRun,
  RunloomSkillProposal,
  RunloomSession,
  RunloomSkillSummary,
  RunloomTodoItem,
  SubscribeOptions,
  SubmitOptions,
  ToolDefinition,
  ToolExecutionResult,
  ToolSummary,
  Unsubscribe
} from "../types.js";

const MAX_MODEL_TOOL_STEPS = 8;
interface ModelToolCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
  raw?: unknown;
}

interface ModelLoopResult {
  status: "completed" | "waiting_approval";
  outputText: string;
  approvalId?: string;
}

export class DefaultRunloomAgent implements RunloomAgent {
  private readonly workspace: string;
  private readonly bus: RunloomEventBus;
  private readonly store: InMemorySessionStore;
  private readonly providerRegistry: ModelProviderRegistry;
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly skillRuntime: SkillRuntime;
  private readonly mcpRuntime: ConfiguredMcpRuntime;
  private readonly mcpServerRuntime: RunloomMcpServerRuntime;
  private readonly a2aRuntime: A2APeerRuntime;
  private readonly externalAgentRuntime: ExternalAgentRuntime;
  private readonly runs = new Map<string, RuntimeRunRecord>();
  private readonly pendingModelContinuations = new Map<string, PendingModelContinuation>();
  private readonly runtimeStateStore?: FileRuntimeStateStore;
  private readonly approvalPolicyStore?: FileApprovalPolicyStore;
  private readonly config: RunloomConfig;
  private readonly toolExecutor: ToolExecutor;
  private readonly artifactRecorder: RunArtifactRecorder;
  private readonly queryRuntime: RunQueryRuntime;
  private readonly stateManager: RuntimeStateManager;
  private readonly activeRuns = new Map<string, { sessionId: string; controller: AbortController }>();
  private approvalPolicy: ApprovalPolicyConfig;
  private sequence = 0;

  constructor(private readonly options: CreateRunloomAgentOptions) {
    this.workspace = resolve(options.host?.workspace?.root ?? options.workspace);
    this.runtimeStateStore = options.stateDir ? new FileRuntimeStateStore(options.stateDir, this.workspace) : undefined;
    const runtimeSnapshot = this.runtimeStateStore?.load();
    this.sequence = runtimeSnapshot?.sequence ?? 0;
    this.store = new InMemorySessionStore(runtimeSnapshot?.store, () => this.saveRuntimeState());
    this.bus = new RunloomEventBus(runtimeSnapshot?.events, () => this.saveRuntimeState());
    this.stateManager = new RuntimeStateManager({
      store: this.store,
      bus: this.bus,
      runs: this.runs,
      pendingModelContinuations: this.pendingModelContinuations,
      runtimeStateStore: this.runtimeStateStore
    });
    this.stateManager.loadSnapshot(runtimeSnapshot);
    this.approvalPolicyStore = options.stateDir ? new FileApprovalPolicyStore(options.stateDir, this.workspace) : undefined;
    this.approvalPolicy = this.loadInitialApprovalPolicy(options.approvalPolicy);
    this.config = loadRunloomConfig({
      stateDir: options.stateDir,
      workspace: this.workspace
    });
    this.providerRegistry = new ModelProviderRegistry({
      provider: options.provider,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      config: this.config,
      workspace: this.workspace
    });
    this.toolExecutor = new ToolExecutor({
      workspace: this.workspace,
      getApprovalPolicy: () => this.approvalPolicy,
      saveApproval: (request) => this.store.saveApproval(request),
      emit: (type, source, runId, sessionId, payload) => this.emit(type, source, runId, sessionId, payload),
      logger: options.logger
    });
    this.artifactRecorder = new RunArtifactRecorder({
      workspace: this.workspace,
      showDiff: options.host?.diff ? (diff) => options.host?.diff?.showDiff(diff) : undefined,
      appendDiffRecord: (record) => this.store.appendDiffRecord(record),
      appendEditPlan: (plan) => this.store.appendEditPlan(plan),
      appendDeliverySummary: (summary) => this.store.appendDeliverySummary(summary),
      appendReviewFindings: (findings) => this.store.appendReviewFindings(findings),
      emit: (type, source, runId, sessionId, payload) => this.emit(type, source, runId, sessionId, payload),
      log: (input) => this.log(input)
    });
    this.queryRuntime = new RunQueryRuntime({
      workspace: this.workspace,
      store: this.store,
      bus: this.bus,
      runs: this.runs
    });
    this.skillRuntime = new SkillRuntime({
      stateDir: options.stateDir,
      getApprovalPolicy: () => this.approvalPolicy,
      createSession: (sessionId) => sessionId ? this.getSession(sessionId) : Promise.resolve(this.store.createSession(this.workspace)),
      saveApproval: (request) => this.store.saveApproval(request),
      getApproval: (approvalId) => this.store.getApproval(approvalId),
      getApprovalDecision: (approvalId) => this.store.getApprovalDecision(approvalId),
      resolveApproval: (approvalId, decision) => this.resolveApproval(approvalId, decision),
      getAvailableTools: () => [...this.tools.keys()],
      emit: (type, source, runId, sessionId, payload) => this.emit(type, source, runId, sessionId, payload),
      recordAudit: (input) => this.recordAudit(input)
    });
    this.mcpRuntime = new ConfiguredMcpRuntime({
      stateDir: options.stateDir,
      mcpClient: options.mcpClient,
      tools: this.tools,
      emit: (type, source, runId, sessionId, payload) => this.emit(type, source, runId, sessionId, payload),
      recordAudit: (input) => this.recordAudit(input)
    });
    this.mcpServerRuntime = new RunloomMcpServerRuntime({
      tools: this.tools,
      createSession: (sessionId) => sessionId ? this.getSession(sessionId) : Promise.resolve(this.store.createSession(this.workspace)),
      listSkills: () => this.listSkills(),
      listSkillProposals: () => this.listSkillProposals(),
      listSessions: () => this.listSessions(),
      listRuns: (listOptions) => this.listRuns(listOptions),
      listMessages: (listOptions) => this.listMessages(listOptions),
      executeTool: (name, input, executeOptions) => this.executeTool(name, input, executeOptions),
      submit: (input, submitOptions) => this.submit(input, submitOptions),
      emit: (type, source, runId, sessionId, payload) => this.emit(type, source, runId, sessionId, payload),
      recordAudit: (input) => this.recordAudit(input)
    });
    this.a2aRuntime = new A2APeerRuntime({
      workspace: this.workspace,
      getApprovalPolicy: () => this.approvalPolicy,
      saveApproval: (request) => this.store.saveApproval(request),
      getApprovalDecision: (approvalId) => this.store.getApprovalDecision(approvalId),
      emit: (type, source, runId, sessionId, payload) => this.emit(type, source, runId, sessionId, payload),
      recordAudit: (input) => this.recordAudit(input)
    });
    this.externalAgentRuntime = new ExternalAgentRuntime({
      workspace: this.workspace,
      getApprovalPolicy: () => this.approvalPolicy,
      saveApproval: (request) => this.store.saveApproval(request),
      getApprovalDecision: (approvalId) => this.store.getApprovalDecision(approvalId),
      emit: (type, source, runId, sessionId, payload) => this.emit(type, source, runId, sessionId, payload),
      recordAudit: (input) => this.recordAudit(input)
    });
    for (const tool of createBuiltInCodingTools({ terminal: options.host?.terminal })) {
      this.tools.set(tool.name, tool);
    }
    this.skillRuntime.loadConfigured();
    this.mcpRuntime.loadConfigured();
  }

  async submit(input: string | RunloomInput, options: SubmitOptions = {}): Promise<RunResult> {
    const request = normalizeSubmitInput(input, options, this.options.model);
    const text = request.text;
    const session = options.sessionId ? await this.getSession(options.sessionId) : this.store.createSession(this.workspace);
    const runId = `run_${randomUUID()}`;
    const now = new Date().toISOString();
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", abortFromParent, { once: true });
    }
    this.activeRuns.set(runId, { sessionId: session.id, controller });
    this.runs.set(runId, {
      run: {
        id: runId,
        sessionId: session.id,
        status: "running",
        inputText: request.text,
        createdAt: now,
        updatedAt: now,
        model: request.model,
        profile: request.profile,
        taskType: request.taskType,
        language: request.language
      },
      input: { ...request }
    });
    this.saveRuntimeState();

    this.emit("run.started", "runtime", runId, session.id, {
      input: text,
      workspace: this.workspace
    });
    this.appendMessage({
      runId,
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text }]
    });
    this.log({
      level: "info",
      code: "run.started",
      message: "Run started.",
      runId,
      sessionId: session.id,
      details: {
        workspace: this.workspace,
        taskType: request.taskType,
        profile: request.profile
      }
    });

    const todo: RunloomTodoItem = {
      id: `todo_${randomUUID()}`,
      title: "Understand the coding task and produce a verified response",
      status: "in_progress",
      priority: "normal",
      updatedAt: new Date().toISOString()
    };
    this.emit("todo.updated", "runtime", runId, session.id, { items: [todo] });

    try {
      const inspection = await inspectWorkspace(this.workspace, this.options.host?.workspace);
      this.emit("coding.workspace.inspected", "coding", runId, session.id, inspection.summary);
      if (inspection.summary.git) {
        this.emit("coding.git.status", "coding", runId, session.id, inspection.summary.git);
      }
      const diagnostics = await this.collectHostDiagnostics(runId, session.id);

      const modelSelection = this.providerRegistry.select(request);
      this.emit("model.selection.resolved", "runtime", runId, session.id, modelSelection);
      const skillSelection = this.skillRuntime.selectForRun(text, modelSelection);
      for (const activation of skillSelection.activations) {
        this.emit("skill.activated", "runtime", runId, session.id, activation);
      }
      for (const diagnostic of skillSelection.diagnostics) {
        this.emit("skill.selection.diagnostic", "runtime", runId, session.id, diagnostic);
      }
      await this.mcpRuntime.discoverConfiguredServers();

      const provider = this.providerRegistry.get(modelSelection.providerId);
      const modelResult = await this.runModel(
        provider,
        modelSelection,
        runId,
        session.id,
        text,
        `${buildWorkspaceContext(inspection)}${buildDiagnosticsContext(diagnostics)}`,
        this.skillRuntime.buildContext(skillSelection.activations),
        controller.signal
      );

      if (modelResult.status === "waiting_approval") {
        const blockedTodo: RunloomTodoItem = {
          ...todo,
          status: "blocked",
          evidence: modelResult.approvalId ? [`approval:${modelResult.approvalId}`] : undefined,
          updatedAt: new Date().toISOString()
        };
        this.emit("todo.updated", "runtime", runId, session.id, { items: [blockedTodo] });
        if (modelResult.outputText) {
          this.appendMessage({
            runId,
            sessionId: session.id,
            role: "assistant",
            content: [{ type: "text", text: modelResult.outputText }]
          });
        }
        this.emit("run.waiting_approval", "runtime", runId, session.id, {
          outputText: modelResult.outputText,
          approvalId: modelResult.approvalId
        });
        this.log({
          level: "warn",
          code: "run.waiting_approval",
          message: "Run is waiting for approval.",
          runId,
          sessionId: session.id,
          details: {
            approvalId: modelResult.approvalId
          }
        });
        this.updateStoredRun(runId, {
          status: "waiting_approval",
          outputText: modelResult.outputText,
          approvalId: modelResult.approvalId
        });
        this.store.touchSession(session.id);
        return {
          runId,
          sessionId: session.id,
          status: "waiting_approval",
          outputText: modelResult.outputText,
          approvalId: modelResult.approvalId
        };
      }

      const completedTodo: RunloomTodoItem = {
        ...todo,
        status: "completed",
        updatedAt: new Date().toISOString()
      };
      if (modelResult.outputText) {
        this.appendMessage({
          runId,
          sessionId: session.id,
          role: "assistant",
          content: [{ type: "text", text: modelResult.outputText }]
        });
      }
      this.emit("todo.updated", "runtime", runId, session.id, { items: [completedTodo] });
      this.emit("run.completed", "runtime", runId, session.id, {
        outputText: modelResult.outputText
      });
      this.log({
        level: "info",
        code: "run.completed",
        message: "Run completed.",
        runId,
        sessionId: session.id
      });
      this.updateStoredRun(runId, {
        status: "completed",
        outputText: modelResult.outputText
      });
      this.store.touchSession(session.id);

      return {
        runId,
        sessionId: session.id,
        status: "completed",
        outputText: modelResult.outputText
      };
    } catch (error) {
      if (controller.signal.aborted) {
        this.emit("run.cancelled", "runtime", runId, session.id, {
          reason: "cancelled"
        });
        this.log({
          level: "info",
          code: "run.cancelled",
          message: "Run cancelled.",
          runId,
          sessionId: session.id
        });
        this.updateStoredRun(runId, {
          status: "cancelled",
          outputText: "Run cancelled."
        });
        this.store.touchSession(session.id);
        return {
          runId,
          sessionId: session.id,
          status: "cancelled",
          outputText: "Run cancelled."
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      this.emit("run.failed", "runtime", runId, session.id, {
        error: message
      });
      this.log({
        level: "error",
        code: "run.failed",
        message,
        runId,
        sessionId: session.id,
        details: {
          error: errorToLogDetails(error)
        }
      });
      this.updateStoredRun(runId, {
        status: "failed",
        outputText: message
      });

      return {
        runId,
        sessionId: session.id,
        status: "failed",
        outputText: message
      };
    } finally {
      options.signal?.removeEventListener("abort", abortFromParent);
      this.activeRuns.delete(runId);
    }
  }

  subscribe(listener: RunloomEventListener, options?: SubscribeOptions): Unsubscribe {
    return this.bus.subscribe(listener, options);
  }

  async executeTool<TOutput = unknown>(
    name: string,
    input: unknown,
    options: ExecuteToolOptions = {}
  ): Promise<ToolExecutionResult<TOutput>> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolError(`Tool not found: ${name}`, {
        code: "tool.not_found",
        details: { toolName: name }
      });
    }

    const session = options.sessionId ? await this.getSession(options.sessionId) : this.store.createSession(this.workspace);
    const runId = options.runId ?? `run_${randomUUID()}`;

    const result = await this.toolExecutor.execute<TOutput>(tool, input, {
      workspace: this.workspace,
      runId,
      sessionId: session.id,
      signal: options.signal
    });
    await this.artifactRecorder.recordToolResult(name, result);
    this.appendMessage({
      runId,
      sessionId: session.id,
      role: "tool",
      name,
      content: [{ type: "text", text: stringifyToolResult(result) }]
    });
    return result;
  }

  async listSessions(): Promise<RunloomSession[]> {
    return this.queryRuntime.listSessions();
  }

  async listTools(): Promise<ToolSummary[]> {
    return [...this.tools.values()]
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        permissions: [...tool.permissions]
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listSkills(): Promise<RunloomSkillSummary[]> {
    return this.skillRuntime.listSkills();
  }

  async registerSkill(skill: RunloomSkillSummary): Promise<void> {
    this.skillRuntime.registerSkill(skill);
  }

  async proposeSkill(
    input: CreateRunloomSkillProposalInput,
    options: CreateRunloomSkillProposalOptions = {}
  ): Promise<RunloomSkillProposal> {
    return this.skillRuntime.proposeSkill(input, options);
  }

  async listSkillProposals(options: ListSkillProposalsOptions = {}): Promise<RunloomSkillProposal[]> {
    return this.skillRuntime.listSkillProposals(options);
  }

  async approveSkillProposal(proposalId: string, decision: ApprovalDecision = { decision: "approved" }): Promise<RunloomSkillProposal> {
    return this.skillRuntime.approveSkillProposal(proposalId, decision);
  }

  async listMcpServers(): Promise<McpServerSummary[]> {
    return this.mcpRuntime.listServers();
  }

  async registerMcpServer(server: McpServerSummary): Promise<void> {
    this.mcpRuntime.registerServer(server);
  }

  async listA2APeers(): Promise<A2APeerSummary[]> {
    return this.a2aRuntime.listPeers();
  }

  async registerA2APeer(peer: A2APeerRegistration): Promise<void> {
    await this.a2aRuntime.registerPeer(peer);
  }

  async delegateA2APeer(peerId: string, request: A2ADelegationRequest): Promise<A2ADelegationResult> {
    return this.a2aRuntime.delegatePeer(peerId, request);
  }

  async listExternalAgents(): Promise<ExternalAgentSummary[]> {
    return this.externalAgentRuntime.listAgents();
  }

  async registerExternalAgent(adapter: ExternalAgentAdapter): Promise<void> {
    await this.externalAgentRuntime.registerAgent(adapter);
  }

  async delegateExternalAgent(
    name: string,
    request: ExternalAgentDelegationRequest
  ): Promise<ExternalAgentDelegationResult> {
    return this.externalAgentRuntime.delegateAgent(name, request);
  }

  createMcpServer(options: CreateRunloomMcpServerOptions = {}): RunloomMcpServerAdapter {
    return this.mcpServerRuntime.createServer(options);
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    return this.store.listApprovals().map((approval) => ({
      ...approval
    }));
  }

  async listAuditRecords(options: ListAuditRecordsOptions = {}): Promise<RunloomAuditRecord[]> {
    return this.queryRuntime.listAuditRecords(options);
  }

  async getSession(sessionId: string): Promise<RunloomSession> {
    return this.queryRuntime.getSession(sessionId);
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunloomRun[]> {
    return this.queryRuntime.listRuns(options);
  }

  async getRun(runId: string): Promise<RunloomRun> {
    return this.queryRuntime.getRun(runId);
  }

  async listEvents(options: ListEventsOptions = {}): Promise<RunloomEvent[]> {
    return this.queryRuntime.listEvents(options);
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<RunloomMessage[]> {
    return this.queryRuntime.listMessages(options);
  }

  async listEditPlans(options: ListEditPlansOptions = {}): Promise<RunloomEditPlan[]> {
    return this.queryRuntime.listEditPlans(options);
  }

  async listDeliverySummaries(options: ListDeliverySummariesOptions = {}): Promise<RunloomDeliverySummary[]> {
    return this.queryRuntime.listDeliverySummaries(options);
  }

  async listReviewFindings(options: ListReviewFindingsOptions = {}): Promise<RunloomReviewFindings[]> {
    return this.queryRuntime.listReviewFindings(options);
  }

  async listDiffRecords(options: ListDiffRecordsOptions = {}): Promise<RunloomDiffRecord[]> {
    return this.queryRuntime.listDiffRecords(options);
  }

  async resume(runId: string): Promise<RunResult> {
    const storedRun = this.runs.get(runId);
    if (!storedRun) {
      throw new RuntimeError(`Run not found: ${runId}`, {
        code: "runtime.run_not_found",
        details: { runId }
      });
    }
    if (storedRun.run.status === "running") {
      throw new RuntimeError(`Run is still running: ${runId}`, {
        code: "runtime.run_still_running",
        details: { runId }
      });
    }
    if (storedRun.run.status === "waiting_approval" && storedRun.run.approvalId) {
      return this.resumeWaitingApprovalRun(storedRun, storedRun.run.approvalId);
    }
    this.emit("run.resumed", "runtime", runId, storedRun.run.sessionId, {
      originalRunId: runId,
      status: storedRun.run.status
    });
    return this.submit(
      {
        text: storedRun.input.text,
        model: storedRun.input.model,
        profile: storedRun.input.profile,
        taskType: storedRun.input.taskType,
        language: storedRun.input.language
      },
      {
        sessionId: storedRun.run.sessionId
      }
    );
  }

  private async resumeWaitingApprovalRun(storedRun: RuntimeRunRecord, approvalId: string): Promise<RunResult> {
    const pending = this.pendingModelContinuations.get(approvalId);
    const decision = this.store.getApprovalDecision(approvalId);
    if (!decision) {
      this.emit("run.waiting_approval", "runtime", storedRun.run.id, storedRun.run.sessionId, {
        outputText: storedRun.run.outputText ?? "",
        approvalId
      });
      return {
        runId: storedRun.run.id,
        sessionId: storedRun.run.sessionId,
        status: "waiting_approval",
        outputText: storedRun.run.outputText ?? "",
        approvalId
      };
    }

    if (decision.decision === "denied") {
      this.pendingModelContinuations.delete(approvalId);
      this.saveRuntimeState();
      const outputText = [storedRun.run.outputText, "Approval denied."].filter(Boolean).join("\n");
      this.emit("run.cancelled", "runtime", storedRun.run.id, storedRun.run.sessionId, {
        reason: "approval_denied",
        approvalId
      });
      this.updateStoredRun(storedRun.run.id, {
        status: "cancelled",
        outputText
      });
      this.store.touchSession(storedRun.run.sessionId);
      return {
        runId: storedRun.run.id,
        sessionId: storedRun.run.sessionId,
        status: "cancelled",
        outputText
      };
    }

    if (!pending) {
      throw new RuntimeError(`No pending continuation found for approval: ${approvalId}`, {
        code: "runtime.pending_continuation_not_found",
        details: {
          approvalId,
          runId: storedRun.run.id
        }
      });
    }

    const controller = new AbortController();
    this.activeRuns.set(storedRun.run.id, {
      sessionId: storedRun.run.sessionId,
      controller
    });
    this.updateStoredRun(storedRun.run.id, {
      status: "running"
    });
    this.emit("run.resumed", "runtime", storedRun.run.id, storedRun.run.sessionId, {
      originalRunId: storedRun.run.id,
      status: storedRun.run.status,
      approvalId,
      continuation: "approval"
    });
    this.log({
      level: "info",
      code: "run.resumed",
      message: "Run resumed after approval.",
      runId: storedRun.run.id,
      sessionId: storedRun.run.sessionId,
      details: {
        approvalId
      }
    });

    try {
      const modelResult = await this.resumeModelAfterApproval(pending, controller.signal);
      const previousOutputText = storedRun.run.outputText ?? "";
      const assistantDelta = outputDelta(previousOutputText, modelResult.outputText);
      if (assistantDelta) {
        this.appendMessage({
          runId: storedRun.run.id,
          sessionId: storedRun.run.sessionId,
          role: "assistant",
          content: [{ type: "text", text: assistantDelta }]
        });
      }

      if (modelResult.status === "waiting_approval") {
        this.emit("run.waiting_approval", "runtime", storedRun.run.id, storedRun.run.sessionId, {
          outputText: modelResult.outputText,
          approvalId: modelResult.approvalId
        });
        this.updateStoredRun(storedRun.run.id, {
          status: "waiting_approval",
          outputText: modelResult.outputText,
          approvalId: modelResult.approvalId
        });
        this.store.touchSession(storedRun.run.sessionId);
        return {
          runId: storedRun.run.id,
          sessionId: storedRun.run.sessionId,
          status: "waiting_approval",
          outputText: modelResult.outputText,
          approvalId: modelResult.approvalId
        };
      }

      this.emit("run.completed", "runtime", storedRun.run.id, storedRun.run.sessionId, {
        outputText: modelResult.outputText
      });
      this.updateStoredRun(storedRun.run.id, {
        status: "completed",
        outputText: modelResult.outputText,
        approvalId: undefined
      });
      this.store.touchSession(storedRun.run.sessionId);
      return {
        runId: storedRun.run.id,
        sessionId: storedRun.run.sessionId,
        status: "completed",
        outputText: modelResult.outputText
      };
    } catch (error) {
      if (controller.signal.aborted) {
        this.emit("run.cancelled", "runtime", storedRun.run.id, storedRun.run.sessionId, {
          reason: "cancelled"
        });
        this.updateStoredRun(storedRun.run.id, {
          status: "cancelled",
          outputText: "Run cancelled."
        });
        this.store.touchSession(storedRun.run.sessionId);
        return {
          runId: storedRun.run.id,
          sessionId: storedRun.run.sessionId,
          status: "cancelled",
          outputText: "Run cancelled."
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      this.emit("run.failed", "runtime", storedRun.run.id, storedRun.run.sessionId, {
        error: message
      });
      this.updateStoredRun(storedRun.run.id, {
        status: "failed",
        outputText: message
      });
      return {
        runId: storedRun.run.id,
        sessionId: storedRun.run.sessionId,
        status: "failed",
        outputText: message
      };
    } finally {
      this.activeRuns.delete(storedRun.run.id);
    }
  }

  async cancel(runId: string): Promise<void> {
    const activeRun = this.activeRuns.get(runId);
    if (activeRun) {
      activeRun.controller.abort();
      this.emit("run.cancel_requested", "runtime", runId, activeRun.sessionId, {});
      this.log({
        level: "info",
        code: "run.cancel_requested",
        message: "Run cancellation requested.",
        runId,
        sessionId: activeRun.sessionId
      });
      return;
    }
    this.emit("run.cancelled", "runtime", runId, "unknown", {
      reason: "not_active"
    });
    this.log({
      level: "warn",
      code: "run.cancelled",
      message: "Run was not active when cancellation was requested.",
      runId,
      sessionId: "unknown",
      details: {
        reason: "not_active"
      }
    });
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) {
      throw new ApprovalError(`Approval not found: ${approvalId}`, {
        code: "approval.not_found",
        details: { approvalId }
      });
    }
    this.store.resolveApproval(approvalId, decision);
    this.emit("approval.resolved", "approval", approval.runId, approval.sessionId, {
      approvalId,
      decision
    });
    this.log({
      level: "info",
      code: "approval.resolved",
      message: "Approval resolved.",
      runId: approval.runId,
      sessionId: approval.sessionId,
      details: {
        approvalId,
        decision
      }
    });
    await this.skillRuntime.applyApproval(approvalId, decision);
  }

  async getApprovalPolicy(): Promise<ApprovalPolicyConfig> {
    return this.approvalPolicy;
  }

  async updateApprovalPolicy(patch: ApprovalPolicyPatch): Promise<ApprovalPolicyConfig> {
    const previousPolicy = this.approvalPolicy;
    this.approvalPolicy = applyApprovalPolicyPatch(this.approvalPolicy, patch);
    this.approvalPolicyStore?.save(this.approvalPolicy);
    this.recordAudit({
      action: "approval.policy.updated",
      actor: "user",
      summary: "Approval policy updated.",
      details: {
        previousDefaultMode: previousPolicy.defaultMode,
        nextDefaultMode: this.approvalPolicy.defaultMode,
        changedScopes: patch.scopes ?? {},
        updatedBy: this.approvalPolicy.updatedBy
      }
    });
    this.emit("approval.policy.updated", "approval", "policy", "global", this.approvalPolicy);
    try {
      this.options.host?.approvals?.onPolicyUpdated?.(this.approvalPolicy);
    } catch (error) {
      this.log({
        level: "warn",
        source: "approval",
        code: "approval.policy_update_bridge_failed",
        message: "Approval bridge failed while handling a policy update.",
        details: errorToLogDetails(error)
      });
    }
    this.log({
      level: "info",
      code: "approval.policy.updated",
      message: "Approval policy updated.",
      details: this.approvalPolicy
    });
    return this.approvalPolicy;
  }

  async registerTool(tool: ToolDefinition): Promise<void> {
    this.tools.set(tool.name, tool);
  }

  async registerProvider(provider: ModelProvider): Promise<void> {
    this.providerRegistry.register(provider);
  }

  async close(): Promise<void> {
    // Reserved for future persistent stores, providers, MCP connections, and daemon transports.
  }

  private async collectHostDiagnostics(runId: string, sessionId: string): Promise<RunloomDiagnostic[]> {
    if (!this.options.host?.diagnostics?.getDiagnostics) {
      return [];
    }
    try {
      const diagnostics = await this.options.host.diagnostics.getDiagnostics({
        workspace: this.workspace,
        runId,
        sessionId
      });
      const safeDiagnostics = diagnostics.map(cloneDiagnostic);
      this.emit("coding.diagnostics.loaded", "coding", runId, sessionId, {
        count: safeDiagnostics.length,
        diagnostics: safeDiagnostics
      });
      return safeDiagnostics;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("coding.diagnostics.failed", "coding", runId, sessionId, {
        error: message
      });
      this.log({
        level: "warn",
        source: "coding",
        code: "coding.diagnostics.failed",
        message: "Host diagnostics adapter failed.",
        runId,
        sessionId,
        details: errorToLogDetails(error)
      });
      return [];
    }
  }

  private saveRuntimeState(): void {
    this.stateManager.saveSnapshot(this.sequence);
  }

  private async runModel(
    provider: ModelProvider,
    modelSelection: ModelSelectionResult,
    runId: string,
    sessionId: string,
    userText: string,
    workspaceContext: string,
    skillContext: string,
    signal?: AbortSignal
  ): Promise<ModelLoopResult> {
    const output: string[] = [];
    const contextSections = [workspaceContext, skillContext].filter((section) => section.trim().length > 0).join("\n\n");
    const redactedUserMessage = `${redactText(contextSections, {
      workspace: this.workspace
    })}\n\nUser task:\n${redactText(userText, { workspace: this.workspace })}`;
    const input: RunloomModelInputItem[] = [
      {
        type: "message",
        role: "system",
        content: [
          {
            type: "text",
            text: buildSystemPrompt(modelSelection.taskType)
          }
        ]
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "text",
            text: redactedUserMessage
          }
        ]
      }
    ];
    const tools = this.modelTools();

    return this.continueModelLoop(provider, modelSelection, runId, sessionId, input, tools, output, 0, signal);
  }

  private async resumeModelAfterApproval(pending: PendingModelContinuation, signal?: AbortSignal): Promise<ModelLoopResult> {
    const result = await this.executeModelToolCall(pending.pendingToolCall, pending.runId, pending.sessionId, signal, {
      skipApproval: true,
      approvalId: pending.approvalId
    });
    this.pendingModelContinuations.delete(pending.approvalId);
    this.saveRuntimeState();
    this.appendModelToolResult(pending.input, pending.pendingToolCall, result, pending.runId, pending.sessionId);

    const remainingResult = await this.processModelToolCalls({
      modelSelection: pending.modelSelection,
      input: pending.input,
      tools: pending.tools,
      output: pending.output,
      toolCalls: pending.remainingToolCalls,
      nextStep: pending.nextStep,
      runId: pending.runId,
      sessionId: pending.sessionId,
      signal
    });
    if (remainingResult) {
      return remainingResult;
    }

    const provider = this.providerRegistry.get(pending.modelSelection.providerId);
    return this.continueModelLoop(
      provider,
      pending.modelSelection,
      pending.runId,
      pending.sessionId,
      pending.input,
      pending.tools,
      pending.output,
      pending.nextStep,
      signal
    );
  }

  private async continueModelLoop(
    provider: ModelProvider,
    modelSelection: ModelSelectionResult,
    runId: string,
    sessionId: string,
    input: RunloomModelInputItem[],
    tools: RunloomModelTool[],
    output: string[],
    startStep: number,
    signal?: AbortSignal
  ): Promise<ModelLoopResult> {
    for (let step = startStep; step < MAX_MODEL_TOOL_STEPS; step += 1) {
      const toolCalls: ModelToolCall[] = [];
      const events = provider.createResponse(
        {
          model: modelSelection.model,
          input,
          tools,
          toolChoice: tools.length > 0 ? "auto" : "none",
          metadata: {
            runtime: "runloom",
            model_provider: modelSelection.providerId,
            model_source: modelSelection.source,
            model_reason: modelSelection.reason
          }
        },
        {
          runId,
          sessionId,
          signal
        }
      );

      for await (const event of events) {
        this.forwardProviderEvent(event, runId, sessionId);
        if (event.type === "response.output_text.delta") {
          output.push(redactText(event.delta, { workspace: this.workspace }));
        }
        if (event.type === "response.tool_call.completed") {
          toolCalls.push({
            toolCallId: event.toolCallId,
            name: event.name,
            arguments: event.arguments,
            raw: event.raw
          });
        }
        if (event.type === "response.failed") {
          throw new ProviderError(event.error.message, {
            code: `provider.${event.error.code}`,
            retryable: event.error.retryable,
            statusCode: event.error.statusCode,
            details: event.error
          });
        }
      }

      if (toolCalls.length === 0) {
        return {
          status: "completed",
          outputText: output.join("")
        };
      }

      const toolResult = await this.processModelToolCalls({
        modelSelection,
        input,
        tools,
        output,
        toolCalls,
        nextStep: step + 1,
        runId,
        sessionId,
        signal
      });
      if (toolResult) {
        return toolResult;
      }
    }

    throw new RuntimeError(`Model requested tools for more than ${MAX_MODEL_TOOL_STEPS} steps.`, {
      code: "runtime.model_tool_step_limit",
      details: {
        maxSteps: MAX_MODEL_TOOL_STEPS
      }
    });
  }

  private async processModelToolCalls(input: {
    modelSelection: ModelSelectionResult;
    input: RunloomModelInputItem[];
    tools: RunloomModelTool[];
    output: string[];
    toolCalls: ModelToolCall[];
    nextStep: number;
    runId: string;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<ModelLoopResult | undefined> {
    for (const [index, toolCall] of input.toolCalls.entries()) {
      input.input.push({
        type: "function_call",
        toolCallId: toolCall.toolCallId,
        name: toolCall.name,
        arguments: toolCall.arguments,
        raw: toolCall.raw
      });

      const result = await this.executeModelToolCall(toolCall, input.runId, input.sessionId, input.signal);
      if (result.status === "waiting_approval") {
        if (result.approvalId) {
          this.pendingModelContinuations.set(result.approvalId, {
            approvalId: result.approvalId,
            runId: input.runId,
            sessionId: input.sessionId,
            modelSelection: input.modelSelection,
            input: input.input,
            tools: input.tools,
            output: input.output,
            pendingToolCall: toolCall,
            remainingToolCalls: input.toolCalls.slice(index + 1),
            nextStep: input.nextStep
          });
          this.saveRuntimeState();
        }
        return {
          status: "waiting_approval",
          outputText: input.output.join(""),
          approvalId: result.approvalId
        };
      }

      this.appendModelToolResult(input.input, toolCall, result, input.runId, input.sessionId);
    }

    return undefined;
  }

  private appendModelToolResult(
    input: RunloomModelInputItem[],
    toolCall: ModelToolCall,
    result: ToolExecutionResult,
    runId: string,
    sessionId: string
  ): void {
    const toolOutput = stringifyToolResult(result);
    input.push({
      type: "function_call_output",
      toolCallId: toolCall.toolCallId,
      output: toolOutput
    });
    this.appendMessage({
      runId,
      sessionId,
      role: "tool",
      name: toolCall.name,
      toolCallId: toolCall.toolCallId,
      content: [{ type: "text", text: toolOutput }]
    });
  }

  private modelTools(): RunloomModelTool[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  private async executeModelToolCall(
    toolCall: ModelToolCall,
    runId: string,
    sessionId: string,
    signal?: AbortSignal,
    options: { skipApproval?: boolean; approvalId?: string } = {}
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      this.emit("tool.call.failed", "tool", runId, sessionId, {
        toolName: toolCall.name,
        error: `Tool not found: ${toolCall.name}`,
        durationMs: 0
      });
      this.log({
        level: "error",
        code: "tool.not_found",
        message: `Tool not found: ${toolCall.name}`,
        runId,
        sessionId,
        details: {
          toolName: toolCall.name
        }
      });
      return {
        toolName: toolCall.name,
        runId,
        sessionId,
        status: "failed",
        error: `Tool not found: ${toolCall.name}`,
        durationMs: 0
      };
    }

    const result = await this.toolExecutor.execute(tool, toolCall.arguments, {
      workspace: this.workspace,
      runId,
      sessionId,
      signal,
      skipApproval: options.skipApproval,
      approvalId: options.approvalId
    });
    await this.artifactRecorder.recordToolResult(toolCall.name, result);
    return result;
  }

  private forwardProviderEvent(event: ModelProviderEvent, runId: string, sessionId: string): void {
    this.emit(event.type, "model", runId, sessionId, event);
  }

  private loadInitialApprovalPolicy(patch?: ApprovalPolicyPatch): ApprovalPolicyConfig {
    const savedPolicy = this.approvalPolicyStore?.load();
    const policy = savedPolicy ?? createDefaultApprovalPolicy();
    if (!patch) {
      return policy;
    }

    const patchedPolicy = applyApprovalPolicyPatch(policy, patch, savedPolicy ? "host_app" : "user");
    this.approvalPolicyStore?.save(patchedPolicy);
    return patchedPolicy;
  }

  private emit(type: string, source: RunloomEvent["source"], runId: string, sessionId: string, payload: unknown): void {
    this.bus.emit({
      id: `evt_${randomUUID()}`,
      type,
      runId,
      sessionId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      source,
      payload: redactValue(payload, { workspace: this.workspace })
    });
  }

  private log(input: Parameters<typeof emitLog>[1]): void {
    emitLog(this.options.logger, input, this.workspace);
  }

  private appendMessage(input: Omit<RunloomMessage, "id" | "createdAt">): void {
    const message = redactValue<RunloomMessage>(
      {
        id: `msg_${randomUUID()}`,
        createdAt: new Date().toISOString(),
        ...input
      },
      { workspace: this.workspace }
    );
    this.store.appendMessage(message);
    this.emit("message.created", "runtime", input.runId, input.sessionId, message);
  }

  private recordAudit(input: Omit<RunloomAuditRecord, "id" | "timestamp">): void {
    const record = redactValue<RunloomAuditRecord>(
      {
        id: `audit_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        ...input
      },
      { workspace: this.workspace }
    );
    this.store.appendAuditRecord(record);
    this.emit("audit.recorded", "audit", input.runId ?? "audit", input.sessionId ?? "global", record);
  }

  private updateStoredRun(runId: string, patch: Partial<RunloomRun>): void {
    const storedRun = this.runs.get(runId);
    if (!storedRun) {
      return;
    }
    this.runs.set(runId, {
      ...storedRun,
      run: {
        ...storedRun.run,
        ...patch,
        updatedAt: new Date().toISOString()
      }
    });
    this.saveRuntimeState();
  }
}

function cloneDiagnostic(diagnostic: RunloomDiagnostic): RunloomDiagnostic {
  return {
    ...diagnostic
  };
}
