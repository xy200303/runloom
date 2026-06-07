import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FileApprovalPolicyStore } from "../approvals/file-policy-store.js";
import { applyApprovalPolicyPatch, createDefaultApprovalPolicy } from "../approvals/policy.js";
import { A2APeerRuntime } from "../a2a/peer-runtime.js";
import { buildWorkspaceContext, inspectWorkspace } from "../coding/workspace-summary.js";
import { loadRunloomConfig, selectModel } from "../config/runloom-config.js";
import { ApprovalError, ProviderError, RuntimeError, ToolError } from "../errors.js";
import { RunloomEventBus } from "../events/event-bus.js";
import { ExternalAgentRuntime } from "../external-agents/runtime.js";
import { loadMcpServerConfigs } from "../mcp/mcp-config.js";
import { errorToLogDetails, emitLog } from "../observability/logger.js";
import { AnthropicMessagesProvider } from "../providers/anthropic-messages-provider.js";
import { GoogleGeminiProvider } from "../providers/google-gemini-provider.js";
import { OpenAIChatCompletionsProvider } from "../providers/openai-chat-completions-provider.js";
import { OpenAIResponsesProvider } from "../providers/openai-responses-provider.js";
import { redactText, redactValue } from "../security/redaction.js";
import { FileRuntimeStateStore } from "../sessions/file-runtime-state-store.js";
import { InMemorySessionStore } from "../sessions/in-memory-store.js";
import { loadSkills, validateSkillDefinition } from "../skills/skill-manifest.js";
import { SkillProposalStore, cloneSkillProposal, createSkillProposal } from "../skills/skill-proposals.js";
import { selectSkillActivations } from "../skills/skill-selector.js";
import { createBuiltInCodingTools } from "../tools/coding-tools.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type {
  RuntimeStateSnapshot,
  StoredModelToolCall,
  StoredPendingModelContinuation,
  StoredRunRecord
} from "../sessions/file-runtime-state-store.js";
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
  McpDiscoveryResult,
  McpServerConfig,
  McpServerSummary,
  McpToolDiscovery,
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
  RunloomDiffSummary,
  RunloomDiagnostic,
  RunloomEditPlan,
  RunloomInput,
  RunloomMessage,
  RunloomMcpPromptResult,
  RunloomMcpPromptSummary,
  RunloomMcpResourceReadResult,
  RunloomMcpServerAdapter,
  RunloomMcpServerResource,
  RunloomMcpServerTool,
  RunloomMcpServerToolCallOptions,
  RunloomMcpToolCallResult,
  RunloomReviewFindings,
  RunloomRun,
  RunloomSkillActivation,
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
const PROVIDER_ALIASES: Record<string, string> = {
  openai: "openai-responses",
  "openai-chat": "openai-chat-completions",
  chat: "openai-chat-completions",
  anthropic: "anthropic-messages",
  claude: "anthropic-messages",
  google: "google-gemini",
  gemini: "google-gemini"
};

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

interface NormalizedSubmitInput {
  text: string;
  model?: string;
  profile?: string;
  taskType?: string;
  language?: string;
}

interface StoredRun {
  run: RunloomRun;
  input: NormalizedSubmitInput;
}

type PendingModelContinuation = StoredPendingModelContinuation;

interface NormalizedMcpServerOptions {
  name: string;
  readOnly: boolean;
  exposeRunloomTools: boolean;
  exposeSkills: boolean;
  exposeSessions: boolean;
  exposeMemoryQuery: boolean;
  exposeAgentService: boolean;
  allowedToolNames?: string[];
  deniedToolNames?: string[];
}

export class DefaultRunloomAgent implements RunloomAgent {
  private readonly workspace: string;
  private readonly bus: RunloomEventBus;
  private readonly store: InMemorySessionStore;
  private readonly providers = new Map<string, ModelProvider>();
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly skills = new Map<string, RunloomSkillSummary>();
  private readonly mcpServers = new Map<string, McpServerSummary>();
  private readonly a2aRuntime: A2APeerRuntime;
  private readonly externalAgentRuntime: ExternalAgentRuntime;
  private readonly mcpServerConfigs = new Map<string, McpServerConfig>();
  private readonly discoveredMcpServers = new Set<string>();
  private readonly registeredMcpToolNames = new Set<string>();
  private readonly runs = new Map<string, StoredRun>();
  private readonly pendingModelContinuations = new Map<string, PendingModelContinuation>();
  private readonly runtimeStateStore?: FileRuntimeStateStore;
  private readonly approvalPolicyStore?: FileApprovalPolicyStore;
  private readonly config: RunloomConfig;
  private readonly toolExecutor: ToolExecutor;
  private readonly activeRuns = new Map<string, { sessionId: string; controller: AbortController }>();
  private approvalPolicy: ApprovalPolicyConfig;
  private sequence = 0;
  private readonly skillProposals = new Map<string, RunloomSkillProposal>();
  private readonly skillProposalStore?: SkillProposalStore;

  constructor(private readonly options: CreateRunloomAgentOptions) {
    this.workspace = resolve(options.host?.workspace?.root ?? options.workspace);
    this.runtimeStateStore = options.stateDir ? new FileRuntimeStateStore(options.stateDir, this.workspace) : undefined;
    this.skillProposalStore = options.stateDir ? new SkillProposalStore(options.stateDir) : undefined;
    const runtimeSnapshot = this.runtimeStateStore?.load();
    this.sequence = runtimeSnapshot?.sequence ?? 0;
    this.store = new InMemorySessionStore(runtimeSnapshot?.store, () => this.saveRuntimeState());
    this.bus = new RunloomEventBus(runtimeSnapshot?.events, () => this.saveRuntimeState());
    this.loadRuntimeSnapshot(runtimeSnapshot);
    this.approvalPolicyStore = options.stateDir ? new FileApprovalPolicyStore(options.stateDir, this.workspace) : undefined;
    this.approvalPolicy = this.loadInitialApprovalPolicy(options.approvalPolicy);
    this.config = loadRunloomConfig({
      stateDir: options.stateDir,
      workspace: this.workspace
    });
    this.toolExecutor = new ToolExecutor({
      workspace: this.workspace,
      getApprovalPolicy: () => this.approvalPolicy,
      saveApproval: (request) => this.store.saveApproval(request),
      emit: (type, source, runId, sessionId, payload) => this.emit(type, source, runId, sessionId, payload),
      logger: options.logger
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

    if (!options.provider || options.provider === "openai-responses") {
      this.registerProviderSync(
        new OpenAIResponsesProvider({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl
        })
      );
    } else if (options.provider === "openai-chat-completions") {
      this.registerProviderSync(
        new OpenAIChatCompletionsProvider({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl
        })
      );
    } else if (options.provider === "anthropic-messages") {
      this.registerProviderSync(
        new AnthropicMessagesProvider({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl
        })
      );
    } else if (options.provider === "google-gemini") {
      this.registerProviderSync(
        new GoogleGeminiProvider({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl
        })
      );
    } else {
      this.registerProviderSync(options.provider);
    }

    for (const tool of createBuiltInCodingTools({ terminal: options.host?.terminal })) {
      this.tools.set(tool.name, tool);
    }
    this.loadSkillProposals();
    this.loadConfiguredSkills();
    this.loadConfiguredMcpServers();
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

      const modelSelection = this.selectModelForRun(request);
      this.emit("model.selection.resolved", "runtime", runId, session.id, modelSelection);
      const skillSelection = this.selectSkillsForRun(text, modelSelection);
      for (const activation of skillSelection.activations) {
        this.emit("skill.activated", "runtime", runId, session.id, activation);
      }
      for (const diagnostic of skillSelection.diagnostics) {
        this.emit("skill.selection.diagnostic", "runtime", runId, session.id, diagnostic);
      }
      await this.discoverConfiguredMcpServers();

      const provider = this.getProvider(modelSelection.providerId);
      const modelResult = await this.runModel(
        provider,
        modelSelection,
        runId,
        session.id,
        text,
        `${buildWorkspaceContext(inspection)}${buildDiagnosticsContext(diagnostics)}`,
        this.buildSkillContext(skillSelection.activations),
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
    await this.recordDiffResult(name, result);
    this.recordEditPlanResult(name, result);
    this.recordDeliverySummaryResult(name, result);
    this.recordReviewFindingsResult(name, result);
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
    return this.store.listSessions(this.workspace);
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
    return [...this.skills.values()]
      .map(cloneSkill)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async registerSkill(skill: RunloomSkillSummary): Promise<void> {
    this.skills.set(skill.name, cloneSkill(skill));
  }

  async proposeSkill(
    input: CreateRunloomSkillProposalInput,
    options: CreateRunloomSkillProposalOptions = {}
  ): Promise<RunloomSkillProposal> {
    const session = options.sessionId ? await this.getSession(options.sessionId) : this.store.createSession(this.workspace);
    const runId = options.runId ?? `skill_${randomUUID()}`;
    const created = createSkillProposal(
      input,
      {
        runId,
        sessionId: session.id
      },
      this.approvalPolicy
    );
    this.saveSkillProposal(created.proposal);
    this.emit("skill.proposal.created", "runtime", runId, session.id, created.proposal);
    this.recordAudit({
      action: "skill.proposal.created",
      actor: "runtime",
      runId,
      sessionId: session.id,
      summary: `Skill proposal created: ${created.proposal.skillName}.`,
      details: {
        proposalId: created.proposal.id,
        skillName: created.proposal.skillName,
        changeType: created.proposal.changeType,
        status: created.proposal.status,
        validation: created.proposal.validation,
        risk: created.proposal.risk
      }
    });

    if (!created.proposal.validation.valid) {
      this.emit("skill.proposal.validation_failed", "runtime", runId, session.id, created.proposal);
      return cloneSkillProposal(created.proposal);
    }

    if (created.approval) {
      this.store.saveApproval(created.approval);
      this.emit("approval.requested", "approval", runId, session.id, created.approval);
      this.emit("skill.proposal.approval_requested", "runtime", runId, session.id, created.proposal);
      return cloneSkillProposal(created.proposal);
    }

    return this.installApprovedSkillProposal(created.proposal.id, "policy");
  }

  async listSkillProposals(options: ListSkillProposalsOptions = {}): Promise<RunloomSkillProposal[]> {
    const proposals = [...this.skillProposals.values()]
      .filter((proposal) => !options.status || proposal.status === options.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return takeLast(proposals, options.limit).map(cloneSkillProposal);
  }

  async approveSkillProposal(proposalId: string, decision: ApprovalDecision = { decision: "approved" }): Promise<RunloomSkillProposal> {
    const proposal = this.skillProposals.get(proposalId);
    if (!proposal) {
      throw new RuntimeError(`Skill proposal not found: ${proposalId}`, {
        code: "runtime.skill_proposal_not_found",
        details: { proposalId }
      });
    }
    if (proposal.status === "installed" || proposal.status === "denied" || proposal.status === "invalid") {
      return cloneSkillProposal(proposal);
    }
    if (!proposal.approvalId) {
      return this.installApprovedSkillProposal(proposalId, "policy");
    }
    const pendingApproval = this.store.getApproval(proposal.approvalId);
    if (pendingApproval) {
      await this.resolveApproval(proposal.approvalId, decision);
      const updated = this.skillProposals.get(proposalId);
      return cloneSkillProposal(updated ?? proposal);
    }
    const resolvedDecision = this.store.getApprovalDecision(proposal.approvalId);
    if (!resolvedDecision) {
      throw new ApprovalError(`Skill proposal approval has not been resolved: ${proposal.approvalId}`, {
        code: "approval.not_resolved",
        details: {
          approvalId: proposal.approvalId,
          proposalId
        }
      });
    }
    await this.applySkillProposalApproval(proposal.approvalId, resolvedDecision);
    const updated = this.skillProposals.get(proposalId);
    return cloneSkillProposal(updated ?? proposal);
  }

  async listMcpServers(): Promise<McpServerSummary[]> {
    await this.discoverConfiguredMcpServers();
    return [...this.mcpServers.values()]
      .map(cloneMcpServer)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async registerMcpServer(server: McpServerSummary): Promise<void> {
    this.mcpServers.set(server.name, cloneMcpServer(server));
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
    const config = normalizeMcpServerOptions(options);
    return {
      name: config.name,
      listTools: () => this.listRunloomMcpServerTools(config),
      callTool: (name, input, callOptions) => this.callRunloomMcpServerTool(config, name, input, callOptions),
      listResources: () => this.listRunloomMcpServerResources(config),
      readResource: (uri) => this.readRunloomMcpServerResource(config, uri),
      listPrompts: () => this.listRunloomMcpServerPrompts(),
      getPrompt: (name, args) => this.getRunloomMcpServerPrompt(config, name, args)
    };
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    return this.store.listApprovals().map((approval) => ({
      ...approval
    }));
  }

  async listAuditRecords(options: ListAuditRecordsOptions = {}): Promise<RunloomAuditRecord[]> {
    const records = this.store.listAuditRecords(options.action);
    return takeLast(records, options.limit).map((record) => ({ ...record }));
  }

  async getSession(sessionId: string): Promise<RunloomSession> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new RuntimeError(`Session not found: ${sessionId}`, {
        code: "runtime.session_not_found",
        details: { sessionId }
      });
    }
    return session;
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunloomRun[]> {
    return [...this.runs.values()]
      .map((storedRun) => cloneRun(storedRun.run))
      .filter((run) => !options.sessionId || run.sessionId === options.sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getRun(runId: string): Promise<RunloomRun> {
    const storedRun = this.runs.get(runId);
    if (!storedRun) {
      throw new RuntimeError(`Run not found: ${runId}`, {
        code: "runtime.run_not_found",
        details: { runId }
      });
    }
    return cloneRun(storedRun.run);
  }

  async listEvents(options: ListEventsOptions = {}): Promise<RunloomEvent[]> {
    const events = this.bus
      .listEvents(options.sessionId)
      .filter((event) => !options.runId || event.runId === options.runId);
    return takeLast(events, options.limit).map((event) => ({ ...event }));
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<RunloomMessage[]> {
    const messages = this.store.listMessages({
      sessionId: options.sessionId,
      runId: options.runId
    });
    return takeLast(messages, options.limit).map(cloneMessage);
  }

  async listEditPlans(options: ListEditPlansOptions = {}): Promise<RunloomEditPlan[]> {
    const plans = this.store.listEditPlans({
      sessionId: options.sessionId,
      runId: options.runId,
      status: options.status
    });
    return takeLast(plans, options.limit).map(cloneEditPlan);
  }

  async listDeliverySummaries(options: ListDeliverySummariesOptions = {}): Promise<RunloomDeliverySummary[]> {
    const summaries = this.store.listDeliverySummaries({
      sessionId: options.sessionId,
      runId: options.runId
    });
    return takeLast(summaries, options.limit).map(cloneDeliverySummary);
  }

  async listReviewFindings(options: ListReviewFindingsOptions = {}): Promise<RunloomReviewFindings[]> {
    const findings = this.store.listReviewFindings({
      sessionId: options.sessionId,
      runId: options.runId
    });
    return takeLast(findings, options.limit).map(cloneReviewFindings);
  }

  async listDiffRecords(options: ListDiffRecordsOptions = {}): Promise<RunloomDiffRecord[]> {
    const records = this.store.listDiffRecords({
      sessionId: options.sessionId,
      runId: options.runId
    });
    return takeLast(records, options.limit).map(cloneDiffRecord);
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

  private async resumeWaitingApprovalRun(storedRun: StoredRun, approvalId: string): Promise<RunResult> {
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
    await this.applySkillProposalApproval(approvalId, decision);
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
    this.registerProviderSync(provider);
  }

  async close(): Promise<void> {
    // Reserved for future persistent stores, providers, MCP connections, and daemon transports.
  }

  private loadSkillProposals(): void {
    const proposals = this.skillProposalStore?.list() ?? [];
    for (const proposal of proposals) {
      this.skillProposals.set(proposal.id, cloneSkillProposal(proposal));
    }
    if (proposals.length > 0) {
      this.emit("skill.proposals.loaded", "runtime", "skills", "global", {
        count: proposals.length,
        waitingApproval: proposals.filter((proposal) => proposal.status === "waiting_approval").length,
        installed: proposals.filter((proposal) => proposal.status === "installed").length,
        invalid: proposals.filter((proposal) => proposal.status === "invalid").length
      });
    }
  }

  private saveSkillProposal(proposal: RunloomSkillProposal): void {
    const cloned = cloneSkillProposal(proposal);
    this.skillProposals.set(cloned.id, cloned);
    this.skillProposalStore?.save(cloned);
  }

  private async applySkillProposalApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const proposal = [...this.skillProposals.values()].find((item) => item.approvalId === approvalId);
    if (!proposal) {
      return;
    }

    if (decision.decision === "denied") {
      const now = new Date().toISOString();
      const denied: RunloomSkillProposal = {
        ...proposal,
        status: "denied",
        deniedAt: now,
        updatedAt: now,
        diagnostics: decision.reason ? [decision.reason] : proposal.diagnostics
      };
      this.saveSkillProposal(denied);
      this.emit("skill.proposal.denied", "runtime", denied.runId, denied.sessionId, denied);
      this.recordAudit({
        action: "skill.proposal.denied",
        actor: "user",
        runId: denied.runId,
        sessionId: denied.sessionId,
        summary: `Skill proposal denied: ${denied.skillName}.`,
        details: {
          proposalId: denied.id,
          skillName: denied.skillName,
          reason: decision.reason
        }
      });
      return;
    }

    await this.installApprovedSkillProposal(proposal.id, "approval");
  }

  private async installApprovedSkillProposal(proposalId: string, actor: "approval" | "policy"): Promise<RunloomSkillProposal> {
    const proposal = this.skillProposals.get(proposalId);
    if (!proposal) {
      throw new RuntimeError(`Skill proposal not found: ${proposalId}`, {
        code: "runtime.skill_proposal_not_found",
        details: { proposalId }
      });
    }
    if (!proposal.validation.valid || !proposal.manifest || proposal.instructions === undefined) {
      throw new RuntimeError(`Skill proposal is not valid for installation: ${proposalId}`, {
        code: "runtime.skill_proposal_invalid",
        details: {
          proposalId,
          validation: proposal.validation
        }
      });
    }

    const validation = validateSkillDefinition({
      manifest: proposal.manifest,
      instructions: proposal.instructions,
      source: "generated"
    });
    if (!validation.skill) {
      const now = new Date().toISOString();
      const invalid: RunloomSkillProposal = {
        ...proposal,
        status: "invalid",
        updatedAt: now,
        validation: {
          ...proposal.validation,
          valid: false,
          diagnostics: validation.diagnostics
        },
        diagnostics: validation.diagnostics
      };
      this.saveSkillProposal(invalid);
      this.emit("skill.proposal.validation_failed", "runtime", invalid.runId, invalid.sessionId, invalid);
      throw new RuntimeError(`Skill proposal failed validation: ${proposalId}`, {
        code: "runtime.skill_proposal_invalid",
        details: {
          proposalId,
          diagnostics: validation.diagnostics
        }
      });
    }

    this.skillProposalStore?.installGeneratedSkill(proposal);
    const generatedSkill = cloneSkill(validation.skill);
    this.skills.set(generatedSkill.name, generatedSkill);
    const now = new Date().toISOString();
    const installed: RunloomSkillProposal = {
      ...proposal,
      skillName: generatedSkill.name,
      status: "installed",
      validation: {
        ...proposal.validation,
        valid: true,
        diagnostics: []
      },
      approvedAt: proposal.approvedAt ?? now,
      installedAt: now,
      updatedAt: now,
      diagnostics: undefined
    };
    this.saveSkillProposal(installed);
    this.emit("skill.proposal.approved", "runtime", installed.runId, installed.sessionId, installed);
    this.emit("skill.generated", "runtime", installed.runId, installed.sessionId, {
      proposalId: installed.id,
      skill: generatedSkill,
      persisted: Boolean(this.skillProposalStore),
      actor
    });
    this.emit("skill.installed", "runtime", installed.runId, installed.sessionId, {
      proposalId: installed.id,
      skill: generatedSkill,
      source: "generated",
      actor
    });
    this.recordAudit({
      action: "skill.generated",
      actor: actor === "approval" ? "user" : "runtime",
      runId: installed.runId,
      sessionId: installed.sessionId,
      summary: `Generated skill installed: ${generatedSkill.name}.`,
      details: {
        proposalId: installed.id,
        skillName: generatedSkill.name,
        version: generatedSkill.version,
        persisted: Boolean(this.skillProposalStore),
        contentHash: generatedSkill.contentHash
      }
    });
    return cloneSkillProposal(installed);
  }

  private loadConfiguredSkills(): void {
    if (!this.options.stateDir) {
      return;
    }
    const loaded = loadSkills({ stateDir: this.options.stateDir });
    for (const skill of loaded.skills) {
      this.skills.set(skill.name, cloneSkill(skill));
    }
    if (loaded.skills.length > 0 || loaded.diagnostics.length > 0) {
      this.emit("skills.loaded", "runtime", "skills", "global", {
        count: loaded.skills.length,
        enabled: loaded.skills.filter((skill) => skill.enabled).length,
        disabled: loaded.skills.filter((skill) => !skill.enabled).length,
        diagnostics: loaded.diagnostics
      });
    }
    for (const diagnostic of loaded.diagnostics) {
      this.emit("skills.diagnostic", "runtime", "skills", "global", diagnostic);
    }
  }

  private loadConfiguredMcpServers(): void {
    const configs = loadMcpServerConfigs({ stateDir: this.options.stateDir });
    for (const config of configs) {
      this.mcpServerConfigs.set(config.name, cloneMcpServerConfig(config));
      this.mcpServers.set(config.name, {
        name: config.name,
        enabled: config.enabled,
        transport: config.transport,
        status: config.enabled ? "disconnected" : "disconnected",
        tools: [],
        resources: 0,
        prompts: 0,
        permissions: cloneMcpPermissions(config.permissions)
      });
    }
  }

  private async discoverConfiguredMcpServers(): Promise<void> {
    if (!this.options.mcpClient) {
      return;
    }

    for (const config of this.mcpServerConfigs.values()) {
      if (!config.enabled || this.discoveredMcpServers.has(config.name)) {
        continue;
      }

      this.discoveredMcpServers.add(config.name);
      this.updateMcpServer(config.name, {
        status: "connecting",
        error: undefined
      });
      this.emit("mcp.server.connecting", "mcp", "mcp", "global", {
        serverName: config.name,
        transport: config.transport
      });

      try {
        const discovery = await this.options.mcpClient.discover(cloneMcpServerConfig(config));
        this.applyMcpDiscovery(config, discovery);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.updateMcpServer(config.name, {
          status: "error",
          error: message
        });
        this.emit("mcp.error", "mcp", "mcp", "global", {
          serverName: config.name,
          error: message
        });
      }
    }
  }

  private applyMcpDiscovery(config: McpServerConfig, discovery: McpDiscoveryResult): void {
    const tools = discovery.tools?.map((tool) => tool.name).filter(Boolean) ?? [];
    const registeredTools: string[] = [];
    for (const tool of discovery.tools ?? []) {
      if (this.shouldRegisterMcpTool(config, tool)) {
        const toolName = this.registerMcpTool(config, tool);
        registeredTools.push(toolName);
      }
    }

    this.updateMcpServer(config.name, {
      status: "connected",
      tools,
      resources: discovery.resources?.length ?? 0,
      prompts: discovery.prompts?.length ?? 0,
      error: undefined
    });
    this.emit("mcp.server.connected", "mcp", "mcp", "global", {
      serverName: config.name,
      transport: config.transport
    });
    this.emit("mcp.discovery.completed", "mcp", "mcp", "global", {
      serverName: config.name,
      tools,
      registeredTools,
      resources: discovery.resources?.length ?? 0,
      prompts: discovery.prompts?.length ?? 0
    });
  }

  private shouldRegisterMcpTool(config: McpServerConfig, tool: McpToolDiscovery): boolean {
    if (config.permissions.tools === "deny") {
      return false;
    }
    if (config.permissions.deniedToolNames?.includes(tool.name)) {
      return false;
    }
    if (config.permissions.allowedToolNames?.length && !config.permissions.allowedToolNames.includes(tool.name)) {
      return false;
    }
    return true;
  }

  private registerMcpTool(config: McpServerConfig, tool: McpToolDiscovery): string {
    const toolName = `mcp.${config.name}.${sanitizeToolName(tool.name)}`;
    if (this.registeredMcpToolNames.has(toolName)) {
      return toolName;
    }

    this.registeredMcpToolNames.add(toolName);
    this.tools.set(toolName, {
      name: toolName,
      description: tool.description ?? `MCP tool ${tool.name} from ${config.name}.`,
      inputSchema: tool.inputSchema ?? {
        type: "object",
        additionalProperties: true
      },
      permissions: ["mcp.tools"],
      execute: async (input, context) => {
        if (!this.options.mcpClient?.callTool) {
          throw new Error(`MCP client adapter does not support tool calls for ${config.name}.`);
        }
        this.emit("mcp.tool.call.requested", "mcp", context.runId, context.sessionId, {
          serverName: config.name,
          toolName: tool.name,
          runloomToolName: toolName
        });
        const output = await this.options.mcpClient.callTool(cloneMcpServerConfig(config), tool.name, input, context);
        this.emit("mcp.tool.call.completed", "mcp", context.runId, context.sessionId, {
          serverName: config.name,
          toolName: tool.name,
          runloomToolName: toolName
        });
        this.recordAudit({
          action: "mcp.tool.called",
          actor: "runtime",
          summary: `MCP tool called: ${config.name}/${tool.name}`,
          runId: context.runId,
          sessionId: context.sessionId,
          details: {
            serverName: config.name,
            toolName: tool.name,
            runloomToolName: toolName
          }
        });
        return output;
      }
    });
    this.emit("mcp.tool.registered", "mcp", "mcp", "global", {
      serverName: config.name,
      toolName: tool.name,
      runloomToolName: toolName
    });
    return toolName;
  }

  private updateMcpServer(name: string, patch: Partial<McpServerSummary>): void {
    const existing = this.mcpServers.get(name);
    if (!existing) {
      return;
    }
    this.mcpServers.set(name, cloneMcpServer({ ...existing, ...patch }));
  }

  private async listRunloomMcpServerTools(config: NormalizedMcpServerOptions): Promise<RunloomMcpServerTool[]> {
    const tools: RunloomMcpServerTool[] = [];
    if (config.exposeRunloomTools) {
      for (const tool of this.tools.values()) {
        if (shouldExposeRunloomTool(config, tool)) {
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: cloneJsonObject(tool.inputSchema),
            permissions: [...tool.permissions],
            runloomToolName: tool.name
          });
        }
      }
    }
    if (config.exposeMemoryQuery && isMcpServerToolNameAllowed(config, "runloom.memory.query")) {
      tools.push(createMemoryQueryMcpTool());
    }
    if (!config.readOnly && config.exposeAgentService && isMcpServerToolNameAllowed(config, "runloom.agent.submit")) {
      tools.push(createAgentSubmitMcpTool());
    }
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async callRunloomMcpServerTool(
    config: NormalizedMcpServerOptions,
    name: string,
    input: unknown,
    options: RunloomMcpServerToolCallOptions = {}
  ): Promise<RunloomMcpToolCallResult> {
    if (name === "runloom.memory.query" && config.exposeMemoryQuery && isMcpServerToolNameAllowed(config, name)) {
      return this.callRunloomMcpMemoryQuery(input, options);
    }
    if (
      name === "runloom.agent.submit" &&
      !config.readOnly &&
      config.exposeAgentService &&
      isMcpServerToolNameAllowed(config, name)
    ) {
      return this.callRunloomMcpAgentSubmit(input, options);
    }

    const tool = this.tools.get(name);
    if (!tool || !config.exposeRunloomTools || !shouldExposeRunloomTool(config, tool)) {
      throw new ToolError(`MCP server tool not found or not exposed: ${name}`, {
        code: "tool.not_found",
        details: {
          toolName: name,
          mcpServer: config.name
        }
      });
    }

    const context = await this.createMcpServerCallContext(options);
    this.emit("mcp.server.tool.call.requested", "mcp", context.runId, context.sessionId, {
      serverName: config.name,
      toolName: name,
      runloomToolName: name
    });
    const result = await this.executeTool(name, input, {
      runId: context.runId,
      sessionId: context.sessionId,
      signal: options.signal
    });
    this.emit("mcp.server.tool.call.completed", "mcp", result.runId, result.sessionId, {
      serverName: config.name,
      toolName: name,
      runloomToolName: name,
      status: result.status,
      approvalId: result.approvalId
    });
    this.recordAudit({
      action: "mcp.server.tool.called",
      actor: "runtime",
      runId: result.runId,
      sessionId: result.sessionId,
      summary: `MCP server tool called: ${name}.`,
      details: {
        serverName: config.name,
        toolName: name,
        status: result.status,
        approvalId: result.approvalId
      }
    });
    return toolExecutionResultToMcpResult(result);
  }

  private async callRunloomMcpMemoryQuery(
    input: unknown,
    options: RunloomMcpServerToolCallOptions
  ): Promise<RunloomMcpToolCallResult> {
    const context = await this.createMcpServerCallContext(options);
    const query = parseMemoryQueryInput(input);
    const output = {
      query: query.query,
      limit: query.limit,
      records: [],
      status: "unavailable",
      message: "Runloom memory stores are not implemented yet."
    };
    this.emit("mcp.server.tool.call.requested", "mcp", context.runId, context.sessionId, {
      serverName: "runloom",
      toolName: "runloom.memory.query"
    });
    this.emit("mcp.server.tool.call.completed", "mcp", context.runId, context.sessionId, {
      serverName: "runloom",
      toolName: "runloom.memory.query",
      status: "completed"
    });
    this.recordAudit({
      action: "mcp.server.tool.called",
      actor: "runtime",
      runId: context.runId,
      sessionId: context.sessionId,
      summary: "MCP server tool called: runloom.memory.query.",
      details: {
        toolName: "runloom.memory.query",
        status: "completed",
        query
      }
    });
    return structuredMcpToolResult("runloom.memory.query", context.runId, context.sessionId, "completed", output);
  }

  private async callRunloomMcpAgentSubmit(
    input: unknown,
    options: RunloomMcpServerToolCallOptions
  ): Promise<RunloomMcpToolCallResult> {
    const parsed = parseAgentSubmitInput(input);
    const context = await this.createMcpServerCallContext({
      ...options,
      sessionId: options.sessionId ?? parsed.sessionId
    });
    this.emit("mcp.server.tool.call.requested", "mcp", context.runId, context.sessionId, {
      serverName: "runloom",
      toolName: "runloom.agent.submit"
    });
    const result = await this.submit(parsed.input, {
      sessionId: context.sessionId,
      signal: options.signal
    });
    this.emit("mcp.server.tool.call.completed", "mcp", result.runId, result.sessionId, {
      serverName: "runloom",
      toolName: "runloom.agent.submit",
      status: result.status,
      approvalId: result.approvalId
    });
    this.recordAudit({
      action: "mcp.server.tool.called",
      actor: "runtime",
      runId: result.runId,
      sessionId: result.sessionId,
      summary: "MCP server tool called: runloom.agent.submit.",
      details: {
        toolName: "runloom.agent.submit",
        status: result.status,
        approvalId: result.approvalId
      }
    });
    return runResultToMcpResult("runloom.agent.submit", result);
  }

  private async createMcpServerCallContext(options: RunloomMcpServerToolCallOptions): Promise<{ runId: string; sessionId: string }> {
    const session = options.sessionId ? await this.getSession(options.sessionId) : this.store.createSession(this.workspace);
    return {
      runId: options.runId ?? `mcpserver_${randomUUID()}`,
      sessionId: session.id
    };
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

  private async listRunloomMcpServerResources(config: NormalizedMcpServerOptions): Promise<RunloomMcpServerResource[]> {
    const resources: RunloomMcpServerResource[] = [];
    if (config.exposeSkills) {
      resources.push({
        uri: "runloom://skills",
        name: "Runloom skills",
        description: "Installed, generated, and registered Runloom skills.",
        mimeType: "application/json"
      });
      resources.push({
        uri: "runloom://skill-proposals",
        name: "Runloom skill proposals",
        description: "Generated skill proposals and approval state.",
        mimeType: "application/json"
      });
      for (const skill of await this.listSkills()) {
        resources.push({
          uri: `runloom://skills/${encodeURIComponent(skill.name)}`,
          name: `Runloom skill: ${skill.name}`,
          description: skill.description,
          mimeType: "application/json"
        });
      }
    }
    if (config.exposeSessions) {
      resources.push({
        uri: "runloom://sessions",
        name: "Runloom sessions",
        description: "Known Runloom sessions for this workspace.",
        mimeType: "application/json"
      });
      for (const session of await this.listSessions()) {
        resources.push({
          uri: `runloom://sessions/${encodeURIComponent(session.id)}/summary`,
          name: `Runloom session summary: ${session.id}`,
          description: `Session updated at ${session.updatedAt}.`,
          mimeType: "application/json"
        });
      }
    }
    if (config.exposeMemoryQuery) {
      resources.push({
        uri: "runloom://memory",
        name: "Runloom memory query status",
        description: "Memory query capability status.",
        mimeType: "application/json"
      });
    }
    return resources.sort((a, b) => a.uri.localeCompare(b.uri));
  }

  private async readRunloomMcpServerResource(
    config: NormalizedMcpServerOptions,
    uri: string
  ): Promise<RunloomMcpResourceReadResult> {
    const payload = await this.resolveRunloomMcpServerResource(config, uri);
    this.emit("mcp.resource.read", "mcp", "mcp", "global", {
      serverName: config.name,
      uri
    });
    this.recordAudit({
      action: "mcp.server.resource.read",
      actor: "runtime",
      summary: `MCP server resource read: ${uri}.`,
      details: {
        serverName: config.name,
        uri
      }
    });
    return {
      uri,
      mimeType: "application/json",
      text: toJsonText(payload),
      structuredContent: payload
    };
  }

  private async resolveRunloomMcpServerResource(config: NormalizedMcpServerOptions, uri: string): Promise<unknown> {
    if (uri === "runloom://skills" && config.exposeSkills) {
      return {
        skills: await this.listSkills()
      };
    }
    if (uri === "runloom://skill-proposals" && config.exposeSkills) {
      return {
        proposals: await this.listSkillProposals()
      };
    }
    if (uri.startsWith("runloom://skills/") && config.exposeSkills) {
      const skillName = decodeURIComponent(uri.slice("runloom://skills/".length));
      const skill = (await this.listSkills()).find((item) => item.name === skillName);
      if (!skill) {
        throw new RuntimeError(`MCP server skill resource not found: ${skillName}`, {
          code: "runtime.mcp_resource_not_found",
          details: { uri, skillName }
        });
      }
      return { skill };
    }
    if (uri === "runloom://sessions" && config.exposeSessions) {
      return {
        sessions: await this.listSessions()
      };
    }
    if (uri.startsWith("runloom://sessions/") && uri.endsWith("/summary") && config.exposeSessions) {
      const sessionId = decodeURIComponent(uri.slice("runloom://sessions/".length, -"/summary".length));
      const session = await this.getSession(sessionId);
      return {
        session,
        runs: await this.listRuns({ sessionId }),
        messages: await this.listMessages({ sessionId, limit: 20 })
      };
    }
    if (uri === "runloom://memory" && config.exposeMemoryQuery) {
      return {
        status: "unavailable",
        records: [],
        message: "Runloom memory stores are not implemented yet."
      };
    }
    throw new RuntimeError(`MCP server resource not found or not exposed: ${uri}`, {
      code: "runtime.mcp_resource_not_found",
      details: {
        uri,
        serverName: config.name
      }
    });
  }

  private async listRunloomMcpServerPrompts(): Promise<RunloomMcpPromptSummary[]> {
    return [
      {
        name: "runloom.code-review",
        description: "Ask Runloom to perform a findings-first code review.",
        arguments: [
          {
            name: "topic",
            description: "Optional review focus.",
            required: false
          }
        ]
      },
      {
        name: "runloom.delivery-summary",
        description: "Ask Runloom to summarize changes, verification, and remaining risks."
      }
    ];
  }

  private async getRunloomMcpServerPrompt(
    config: NormalizedMcpServerOptions,
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<RunloomMcpPromptResult> {
    const topic = typeof args.topic === "string" && args.topic.trim() ? ` Focus: ${args.topic.trim()}` : "";
    let prompt: RunloomMcpPromptResult | undefined;
    if (name === "runloom.code-review") {
      prompt = {
        name,
        description: "Ask Runloom to perform a findings-first code review.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: `Review the current changes using findings-first review mode.${topic}` }]
          }
        ]
      };
    }
    if (name === "runloom.delivery-summary") {
      prompt = {
        name,
        description: "Ask Runloom to summarize changes, verification, and remaining risks.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Summarize modified files, core changes, verification, failures, and remaining risks." }]
          }
        ]
      };
    }
    if (!prompt) {
      throw new RuntimeError(`MCP server prompt not found: ${name}`, {
        code: "runtime.mcp_prompt_not_found",
        details: {
          promptName: name,
          serverName: config.name
        }
      });
    }
    this.emit("mcp.prompt.activated", "mcp", "mcp", "global", {
      serverName: config.name,
      promptName: name
    });
    this.recordAudit({
      action: "mcp.server.prompt.get",
      actor: "runtime",
      summary: `MCP server prompt read: ${name}.`,
      details: {
        serverName: config.name,
        promptName: name
      }
    });
    return prompt;
  }

  private selectSkillsForRun(text: string, modelSelection: ModelSelectionResult): {
    activations: RunloomSkillActivation[];
    diagnostics: Array<{ skillName: string; reason: string }>;
  } {
    return selectSkillActivations({
      text,
      taskType: modelSelection.taskType,
      language: modelSelection.language,
      availableTools: [...this.tools.keys()],
      skills: [...this.skills.values()]
    });
  }

  private buildSkillContext(activations: RunloomSkillActivation[]): string {
    if (activations.length === 0) {
      return "";
    }

    const lines = ["Activated skills:"];
    for (const activation of activations) {
      const skill = this.skills.get(activation.skillName);
      if (!skill) {
        continue;
      }
      const version = activation.version ? `@${activation.version}` : "";
      lines.push(`- ${skill.name}${version}: ${skill.description}`);
      lines.push(`  reason: ${activation.reason}`);
      if (skill.requiredTools?.length) {
        lines.push(`  required tools: ${skill.requiredTools.join(", ")}`);
      }
      const instructions = truncateForBudget(skill.instructions ?? "", activation.contextBudgetTokens);
      if (instructions) {
        lines.push("  instructions:");
        for (const line of instructions.split(/\r?\n/)) {
          if (line.trim()) {
            lines.push(`    ${line}`);
          }
        }
      }
    }
    return lines.join("\n");
  }

  private loadRuntimeSnapshot(snapshot?: RuntimeStateSnapshot): void {
    if (!snapshot) {
      return;
    }
    for (const storedRun of snapshot.runs) {
      this.runs.set(storedRun.run.id, {
        run: cloneRun(storedRun.run),
        input: { ...storedRun.input }
      });
    }
    for (const pending of snapshot.pendingModelContinuations) {
      this.pendingModelContinuations.set(pending.approvalId, clonePendingModelContinuation(pending));
    }
  }

  private saveRuntimeState(): void {
    this.runtimeStateStore?.save({
      store: this.store.snapshot(),
      runs: [...this.runs.values()].map(cloneStoredRun),
      events: this.bus.snapshot(),
      sequence: this.sequence,
      pendingModelContinuations: [...this.pendingModelContinuations.values()].map(clonePendingModelContinuation)
    });
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

    const provider = this.getProvider(pending.modelSelection.providerId);
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
    await this.recordDiffResult(toolCall.name, result);
    this.recordEditPlanResult(toolCall.name, result);
    this.recordDeliverySummaryResult(toolCall.name, result);
    this.recordReviewFindingsResult(toolCall.name, result);
    return result;
  }

  private forwardProviderEvent(event: ModelProviderEvent, runId: string, sessionId: string): void {
    this.emit(event.type, "model", runId, sessionId, event);
  }

  private getActiveProvider(): ModelProvider {
    const provider = this.providers.values().next().value as ModelProvider | undefined;
    if (!provider) {
      throw new ProviderError("No model provider is registered.", {
        code: "provider.not_registered"
      });
    }
    return provider;
  }

  private getProvider(providerId: string): ModelProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new ProviderError(`Model provider is not registered: ${providerId}`, {
        code: "provider.not_registered",
        details: { providerId }
      });
    }
    return provider;
  }

  private registerProviderSync(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  private selectModelForRun(input: NormalizedSubmitInput): ModelSelectionResult {
    return selectModel(this.config, {
      explicitModel: input.model,
      profile: input.profile,
      taskType: input.taskType,
      language: input.language,
      text: input.text,
      workspace: this.workspace,
      defaultProviderId: this.getActiveProvider().id,
      providerAliases: PROVIDER_ALIASES
    });
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

  private async recordDiffResult(toolName: string, result: ToolExecutionResult): Promise<void> {
    if (result.status !== "completed" || !isRunloomDiffSummary(result.output)) {
      return;
    }

    const diff = redactValue(cloneDiffSummary(result.output), { workspace: this.workspace });
    const record: RunloomDiffRecord = {
      id: `diff_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      runId: result.runId,
      sessionId: result.sessionId,
      toolName,
      diff,
      displayed: false
    };

    if (this.options.host?.diff) {
      try {
        await this.options.host.diff.showDiff(cloneDiffSummary(diff));
        record.displayed = true;
      } catch (error) {
        record.displayError = error instanceof Error ? error.message : String(error);
        this.log({
          level: "warn",
          source: "diff",
          code: "diff.display_failed",
          message: "Diff adapter failed to display a diff record.",
          runId: result.runId,
          sessionId: result.sessionId,
          details: {
            toolName,
            error: errorToLogDetails(error)
          }
        });
      }
    }

    const safeRecord = redactValue(record, { workspace: this.workspace });
    this.store.appendDiffRecord(safeRecord);
    this.emit("diff.recorded", "diff", result.runId, result.sessionId, safeRecord);
  }

  private recordEditPlanResult(toolName: string, result: ToolExecutionResult): void {
    if (toolName !== "edit.plan" || result.status !== "completed" || !isRunloomEditPlan(result.output)) {
      return;
    }

    const plan = redactValue(cloneEditPlan(result.output), { workspace: this.workspace });
    this.store.appendEditPlan(plan);
    this.emit("edit.plan.created", "coding", result.runId, result.sessionId, plan);
  }

  private recordDeliverySummaryResult(toolName: string, result: ToolExecutionResult): void {
    if (toolName !== "delivery.summary" || result.status !== "completed" || !isRunloomDeliverySummary(result.output)) {
      return;
    }

    const summary = redactValue(cloneDeliverySummary(result.output), { workspace: this.workspace });
    this.store.appendDeliverySummary(summary);
    this.emit("delivery.summary.created", "coding", result.runId, result.sessionId, summary);
  }

  private recordReviewFindingsResult(toolName: string, result: ToolExecutionResult): void {
    if (toolName !== "review.findings" || result.status !== "completed" || !isRunloomReviewFindings(result.output)) {
      return;
    }

    const findings = redactValue(cloneReviewFindings(result.output), { workspace: this.workspace });
    this.store.appendReviewFindings(findings);
    this.emit("review.findings.created", "coding", result.runId, result.sessionId, findings);
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

function cloneRun(run: RunloomRun): RunloomRun {
  return {
    ...run
  };
}

function cloneStoredRun(storedRun: StoredRun): StoredRunRecord {
  return {
    run: cloneRun(storedRun.run),
    input: { ...storedRun.input }
  };
}

function clonePendingModelContinuation(pending: StoredPendingModelContinuation): StoredPendingModelContinuation {
  return {
    ...pending,
    modelSelection: { ...pending.modelSelection },
    input: pending.input.map(cloneModelInputItem),
    tools: pending.tools.map(cloneModelTool),
    output: [...pending.output],
    pendingToolCall: cloneModelToolCall(pending.pendingToolCall),
    remainingToolCalls: pending.remainingToolCalls.map(cloneModelToolCall)
  };
}

function cloneSkill(skill: RunloomSkillSummary): RunloomSkillSummary {
  return {
    ...skill,
    triggers: skill.triggers ? [...skill.triggers] : undefined,
    requiredTools: skill.requiredTools ? [...skill.requiredTools] : undefined,
    permissions: skill.permissions ? { ...skill.permissions } : undefined,
    validation: skill.validation
      ? {
          ...skill.validation,
          tests: skill.validation.tests ? [...skill.validation.tests] : undefined
        }
      : undefined,
    diagnostics: skill.diagnostics ? [...skill.diagnostics] : undefined
  };
}

function cloneMcpServer(server: McpServerSummary): McpServerSummary {
  return {
    ...server,
    tools: server.tools ? [...server.tools] : undefined,
    permissions: server.permissions ? cloneMcpPermissions(server.permissions) : undefined
  };
}

function cloneMcpServerConfig(config: McpServerConfig): McpServerConfig {
  return {
    ...config,
    args: config.args ? [...config.args] : undefined,
    permissions: cloneMcpPermissions(config.permissions)
  };
}

function cloneMcpPermissions(permissions: McpServerConfig["permissions"]): McpServerConfig["permissions"] {
  return {
    ...permissions,
    allowedToolNames: permissions.allowedToolNames ? [...permissions.allowedToolNames] : undefined,
    deniedToolNames: permissions.deniedToolNames ? [...permissions.deniedToolNames] : undefined
  };
}

function normalizeMcpServerOptions(options: CreateRunloomMcpServerOptions): NormalizedMcpServerOptions {
  const readOnly = options.readOnly ?? true;
  return {
    name: options.name?.trim() || "runloom",
    readOnly,
    exposeRunloomTools: options.exposeRunloomTools ?? true,
    exposeSkills: options.exposeSkills ?? true,
    exposeSessions: options.exposeSessions ?? true,
    exposeMemoryQuery: options.exposeMemoryQuery ?? true,
    exposeAgentService: options.exposeAgentService ?? !readOnly,
    allowedToolNames: options.allowedToolNames ? [...options.allowedToolNames] : undefined,
    deniedToolNames: options.deniedToolNames ? [...options.deniedToolNames] : undefined
  };
}

function shouldExposeRunloomTool(config: NormalizedMcpServerOptions, tool: ToolDefinition): boolean {
  if (!isMcpServerToolNameAllowed(config, tool.name)) {
    return false;
  }
  if (!config.readOnly) {
    return true;
  }
  return tool.permissions.every((scope) => scope === "filesystem.read");
}

function isMcpServerToolNameAllowed(config: NormalizedMcpServerOptions, name: string): boolean {
  if (config.deniedToolNames?.includes(name)) {
    return false;
  }
  if (config.allowedToolNames?.length && !config.allowedToolNames.includes(name)) {
    return false;
  }
  return true;
}

function createMemoryQueryMcpTool(): RunloomMcpServerTool {
  return {
    name: "runloom.memory.query",
    description: "Query Runloom memory records. Returns an empty unavailable result until memory stores are implemented.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" }
      },
      additionalProperties: false
    },
    permissions: ["filesystem.read"]
  };
}

function createAgentSubmitMcpTool(): RunloomMcpServerTool {
  return {
    name: "runloom.agent.submit",
    description: "Submit a task to the Runloom agent service.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        model: { type: "string" },
        profile: { type: "string" },
        taskType: { type: "string" },
        language: { type: "string" },
        sessionId: { type: "string" }
      },
      required: ["text"],
      additionalProperties: false
    },
    permissions: ["external_agents"]
  };
}

function toolExecutionResultToMcpResult(result: ToolExecutionResult): RunloomMcpToolCallResult {
  const structuredContent =
    result.status === "completed"
      ? result.output
      : {
          status: result.status,
          error: result.error,
          approvalId: result.approvalId
        };
  return {
    toolName: result.toolName,
    runId: result.runId,
    sessionId: result.sessionId,
    status: result.status,
    structuredContent,
    approvalId: result.approvalId,
    durationMs: result.durationMs,
    isError: result.status === "failed",
    content: [
      {
        type: "text",
        mimeType: "application/json",
        text: stringifyToolResult(result)
      }
    ]
  };
}

function runResultToMcpResult(toolName: string, result: RunResult): RunloomMcpToolCallResult {
  const structuredContent = {
    status: result.status,
    outputText: result.outputText,
    approvalId: result.approvalId
  };
  return {
    toolName,
    runId: result.runId,
    sessionId: result.sessionId,
    status: result.status,
    structuredContent,
    approvalId: result.approvalId,
    isError: result.status === "failed" || result.status === "cancelled",
    content: [
      {
        type: "text",
        mimeType: "application/json",
        text: toJsonText(structuredContent)
      }
    ]
  };
}

function structuredMcpToolResult(
  toolName: string,
  runId: string,
  sessionId: string,
  status: RunloomMcpToolCallResult["status"],
  output: unknown
): RunloomMcpToolCallResult {
  return {
    toolName,
    runId,
    sessionId,
    status,
    structuredContent: output,
    content: [
      {
        type: "text",
        mimeType: "application/json",
        text: toJsonText(output)
      }
    ]
  };
}

function parseMemoryQueryInput(input: unknown): { query?: string; limit?: number } {
  if (!isRecord(input)) {
    return {};
  }
  return {
    query: typeof input.query === "string" ? input.query : undefined,
    limit: typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined
  };
}

function parseAgentSubmitInput(input: unknown): { input: RunloomInput; sessionId?: string } {
  if (!isRecord(input) || typeof input.text !== "string" || !input.text.trim()) {
    throw new RuntimeError("MCP agent submit input requires a non-empty text field.", {
      code: "runtime.invalid_mcp_agent_submit_input",
      details: { input }
    });
  }
  return {
    input: {
      text: input.text,
      model: typeof input.model === "string" ? input.model : undefined,
      profile: typeof input.profile === "string" ? input.profile : undefined,
      taskType: typeof input.taskType === "string" ? input.taskType : undefined,
      language: typeof input.language === "string" ? input.language : undefined
    },
    sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined
  };
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function toJsonText(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return json.length > 120_000 ? `${json.slice(0, 120_000)}...[truncated]` : json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeToolName(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]/gi, "_") || "tool";
}

function cloneModelInputItem(item: RunloomModelInputItem): RunloomModelInputItem {
  if (item.type === "message") {
    return {
      ...item,
      content: item.content.map((part) => ({ ...part }))
    };
  }
  if (item.type === "function_call") {
    return {
      ...item
    };
  }
  return {
    ...item
  };
}

function cloneModelTool(tool: RunloomModelTool): RunloomModelTool {
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema }
  };
}

function cloneModelToolCall(toolCall: StoredModelToolCall): StoredModelToolCall {
  return {
    ...toolCall
  };
}

function cloneMessage(message: RunloomMessage): RunloomMessage {
  return {
    ...message,
    content: message.content.map((part) => ({ ...part })),
    metadata: message.metadata ? { ...message.metadata } : undefined
  };
}

function cloneDiffRecord(record: RunloomDiffRecord): RunloomDiffRecord {
  return {
    ...record,
    diff: cloneDiffSummary(record.diff)
  };
}

function cloneEditPlan(plan: RunloomEditPlan): RunloomEditPlan {
  return {
    ...plan,
    targetFiles: [...plan.targetFiles],
    risks: [...plan.risks],
    verificationCommands: [...plan.verificationCommands]
  };
}

function cloneDeliverySummary(summary: RunloomDeliverySummary): RunloomDeliverySummary {
  return {
    ...summary,
    modifiedFiles: [...summary.modifiedFiles],
    coreChanges: [...summary.coreChanges],
    verificationResults: summary.verificationResults.map((result) => ({ ...result })),
    failedItems: [...summary.failedItems],
    remainingRisks: [...summary.remainingRisks]
  };
}

function cloneReviewFindings(findings: RunloomReviewFindings): RunloomReviewFindings {
  return {
    ...findings,
    reviewedFiles: [...findings.reviewedFiles],
    findings: findings.findings.map((finding) => ({
      ...finding,
      location: finding.location ? { ...finding.location } : undefined,
      evidence: finding.evidence ? [...finding.evidence] : undefined
    }))
  };
}

function cloneDiffSummary(diff: RunloomDiffSummary): RunloomDiffSummary {
  return {
    filesChanged: [...diff.filesChanged],
    additions: diff.additions,
    deletions: diff.deletions,
    patch: diff.patch
  };
}

function cloneDiagnostic(diagnostic: RunloomDiagnostic): RunloomDiagnostic {
  return {
    ...diagnostic
  };
}

function isRunloomDiffSummary(value: unknown): value is RunloomDiffSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { filesChanged?: unknown }).filesChanged) &&
    (value as { filesChanged: unknown[] }).filesChanged.every((item) => typeof item === "string")
  );
}

function isRunloomEditPlan(value: unknown): value is RunloomEditPlan {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const plan = value as Partial<RunloomEditPlan>;
  return (
    typeof plan.id === "string" &&
    typeof plan.runId === "string" &&
    typeof plan.sessionId === "string" &&
    plan.status === "proposed" &&
    typeof plan.goal === "string" &&
    isStringArray(plan.targetFiles) &&
    isStringArray(plan.risks) &&
    isStringArray(plan.verificationCommands) &&
    typeof plan.createdAt === "string" &&
    typeof plan.updatedAt === "string"
  );
}

function isRunloomDeliverySummary(value: unknown): value is RunloomDeliverySummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const summary = value as Partial<RunloomDeliverySummary>;
  return (
    typeof summary.id === "string" &&
    typeof summary.runId === "string" &&
    typeof summary.sessionId === "string" &&
    typeof summary.createdAt === "string" &&
    isStringArray(summary.modifiedFiles) &&
    isStringArray(summary.coreChanges) &&
    isVerificationResultArray(summary.verificationResults) &&
    isStringArray(summary.failedItems) &&
    isStringArray(summary.remainingRisks)
  );
}

function isRunloomReviewFindings(value: unknown): value is RunloomReviewFindings {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const findings = value as Partial<RunloomReviewFindings>;
  return (
    typeof findings.id === "string" &&
    typeof findings.runId === "string" &&
    typeof findings.sessionId === "string" &&
    typeof findings.createdAt === "string" &&
    isReviewFindingArray(findings.findings) &&
    isStringArray(findings.reviewedFiles) &&
    (findings.summary === undefined || typeof findings.summary === "string")
  );
}

function isVerificationResultArray(value: unknown): value is RunloomDeliverySummary["verificationResults"] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== "object" || item === null) {
        return false;
      }
      const result = item as Partial<RunloomDeliverySummary["verificationResults"][number]>;
      return (
        typeof result.command === "string" &&
        (result.status === "passed" || result.status === "failed" || result.status === "skipped") &&
        (result.exitCode === undefined || typeof result.exitCode === "number") &&
        (result.durationMs === undefined || typeof result.durationMs === "number") &&
        (result.summary === undefined || typeof result.summary === "string")
      );
    })
  );
}

const REVIEW_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const REVIEW_CATEGORIES = new Set([
  "bug",
  "regression",
  "security",
  "performance",
  "maintainability",
  "test_gap",
  "api_risk",
  "other"
]);

function isReviewFindingArray(value: unknown): value is RunloomReviewFindings["findings"] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== "object" || item === null) {
        return false;
      }
      const finding = item as Partial<RunloomReviewFindings["findings"][number]>;
      return (
        typeof finding.severity === "string" &&
        REVIEW_SEVERITIES.has(finding.severity) &&
        typeof finding.title === "string" &&
        typeof finding.description === "string" &&
        (finding.category === undefined ||
          (typeof finding.category === "string" && REVIEW_CATEGORIES.has(finding.category))) &&
        (finding.location === undefined || isReviewLocation(finding.location)) &&
        (finding.evidence === undefined || isStringArray(finding.evidence)) &&
        (finding.recommendation === undefined || typeof finding.recommendation === "string")
      );
    })
  );
}

function isReviewLocation(value: unknown): value is RunloomReviewFindings["findings"][number]["location"] {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const location = value as NonNullable<RunloomReviewFindings["findings"][number]["location"]>;
  return (
    typeof location.path === "string" &&
    (location.line === undefined || typeof location.line === "number") &&
    (location.column === undefined || typeof location.column === "number") &&
    (location.endLine === undefined || typeof location.endLine === "number") &&
    (location.endColumn === undefined || typeof location.endColumn === "number")
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function takeLast<TItem>(items: TItem[], limit?: number): TItem[] {
  if (typeof limit !== "number" || limit < 0) {
    return items;
  }
  if (limit === 0) {
    return [];
  }
  return items.slice(-limit);
}

function stringifyToolResult(result: ToolExecutionResult): string {
  const payload =
    result.status === "completed"
      ? {
          status: result.status,
          output: result.output
        }
      : {
          status: result.status,
          error: result.error ?? `Tool ${result.toolName} did not complete.`
        };

  const json = JSON.stringify(payload);
  return json.length > 120_000 ? `${json.slice(0, 120_000)}...[truncated]` : json;
}

function outputDelta(previous: string, next: string): string {
  if (!previous) {
    return next;
  }
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function truncateForBudget(value: string, budgetTokens: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const maxChars = Math.max(500, budgetTokens * 4);
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...[truncated]` : trimmed;
}

function buildSystemPrompt(taskType?: string): string {
  const base =
    "You are Runloom, a professional local coding agent. Be concise, cite local evidence, protect user changes, and summarize verification. Before high-risk code modifications, call edit.plan with target files, risks, and verification commands. At task completion, call delivery.summary with modified files, core changes, verification results, failed items, and remaining risks.";
  if (taskType !== "code_review") {
    return base;
  }

  return `${base} Review mode is active: use a findings-first code review template. Prioritize bugs, behavioral regressions, security issues, public API risks, and missing tests. Order findings by severity, include file and line evidence when available, state clearly when there are no findings, keep summaries secondary, and call review.findings with structured findings and reviewedFiles before completing the task.`;
}

function buildDiagnosticsContext(diagnostics: RunloomDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }
  const lines = ["", "Host diagnostics:"];
  for (const diagnostic of diagnostics.slice(0, 30)) {
    const location = diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : "";
    const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
    lines.push(`- ${diagnostic.severity} ${diagnostic.path}${location}${source}: ${diagnostic.message}`);
  }
  if (diagnostics.length > 30) {
    lines.push(`- ...${diagnostics.length - 30} more diagnostic(s)`);
  }
  return `\n${lines.join("\n")}`;
}

function normalizeSubmitInput(
  input: string | RunloomInput,
  options: SubmitOptions,
  defaultModel?: string
): NormalizedSubmitInput {
  if (typeof input === "string") {
    return {
      text: input,
      model: options.model ?? defaultModel,
      profile: options.profile,
      taskType: options.taskType,
      language: options.language
    };
  }

  return {
    text: input.text,
    model: options.model ?? input.model ?? defaultModel,
    profile: options.profile ?? input.profile,
    taskType: options.taskType ?? input.taskType,
    language: options.language ?? input.language
  };
}
