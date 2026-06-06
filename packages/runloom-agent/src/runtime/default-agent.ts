import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FileApprovalPolicyStore } from "../approvals/file-policy-store.js";
import { applyApprovalPolicyPatch, createDefaultApprovalPolicy } from "../approvals/policy.js";
import { buildWorkspaceContext, inspectWorkspace } from "../coding/workspace-summary.js";
import { loadRunloomConfig, selectModel } from "../config/runloom-config.js";
import { ApprovalError, ProviderError, RuntimeError, ToolError } from "../errors.js";
import { RunloomEventBus } from "../events/event-bus.js";
import { errorToLogDetails, emitLog } from "../observability/logger.js";
import { OpenAIResponsesProvider } from "../providers/openai-responses-provider.js";
import { redactText, redactValue } from "../security/redaction.js";
import { InMemorySessionStore } from "../sessions/in-memory-store.js";
import { createBuiltInCodingTools } from "../tools/coding-tools.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type {
  ApprovalDecision,
  ApprovalPolicyConfig,
  ApprovalPolicyPatch,
  ApprovalRequest,
  CreateRunloomAgentOptions,
  ExecuteToolOptions,
  ListAuditRecordsOptions,
  ListDiffRecordsOptions,
  ListEditPlansOptions,
  ListEventsOptions,
  ListMessagesOptions,
  ListRunsOptions,
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
  RunloomDiffRecord,
  RunloomDiffSummary,
  RunloomEditPlan,
  RunloomInput,
  RunloomMessage,
  RunloomRun,
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
  openai: "openai-responses"
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

export class DefaultRunloomAgent implements RunloomAgent {
  private readonly workspace: string;
  private readonly bus = new RunloomEventBus();
  private readonly store = new InMemorySessionStore();
  private readonly providers = new Map<string, ModelProvider>();
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly skills = new Map<string, RunloomSkillSummary>();
  private readonly mcpServers = new Map<string, McpServerSummary>();
  private readonly runs = new Map<string, StoredRun>();
  private readonly approvalPolicyStore?: FileApprovalPolicyStore;
  private readonly config: RunloomConfig;
  private readonly toolExecutor: ToolExecutor;
  private readonly activeRuns = new Map<string, { sessionId: string; controller: AbortController }>();
  private approvalPolicy: ApprovalPolicyConfig;
  private sequence = 0;

  constructor(private readonly options: CreateRunloomAgentOptions) {
    this.workspace = resolve(options.workspace);
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

    if (!options.provider || options.provider === "openai-responses") {
      this.registerProviderSync(
        new OpenAIResponsesProvider({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl
        })
      );
    } else {
      this.registerProviderSync(options.provider);
    }

    for (const tool of createBuiltInCodingTools()) {
      this.tools.set(tool.name, tool);
    }
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
      const inspection = await inspectWorkspace(this.workspace);
      this.emit("coding.workspace.inspected", "coding", runId, session.id, inspection.summary);
      if (inspection.summary.git) {
        this.emit("coding.git.status", "coding", runId, session.id, inspection.summary.git);
      }

      const modelSelection = this.selectModelForRun(request);
      this.emit("model.selection.resolved", "runtime", runId, session.id, modelSelection);

      const provider = this.getProvider(modelSelection.providerId);
      const modelResult = await this.runModel(
        provider,
        modelSelection,
        runId,
        session.id,
        text,
        buildWorkspaceContext(inspection),
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
      .map((skill) => ({
        ...skill,
        triggers: skill.triggers ? [...skill.triggers] : undefined,
        requiredTools: skill.requiredTools ? [...skill.requiredTools] : undefined
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async registerSkill(skill: RunloomSkillSummary): Promise<void> {
    this.skills.set(skill.name, {
      ...skill,
      triggers: skill.triggers ? [...skill.triggers] : undefined,
      requiredTools: skill.requiredTools ? [...skill.requiredTools] : undefined
    });
  }

  async listMcpServers(): Promise<McpServerSummary[]> {
    return [...this.mcpServers.values()]
      .map((server) => ({
        ...server,
        tools: server.tools ? [...server.tools] : undefined
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async registerMcpServer(server: McpServerSummary): Promise<void> {
    this.mcpServers.set(server.name, {
      ...server,
      tools: server.tools ? [...server.tools] : undefined
    });
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

  private async runModel(
    provider: ModelProvider,
    modelSelection: ModelSelectionResult,
    runId: string,
    sessionId: string,
    userText: string,
    workspaceContext: string,
    signal?: AbortSignal
  ): Promise<ModelLoopResult> {
    const output: string[] = [];
    const redactedUserMessage = `${redactText(workspaceContext, {
      workspace: this.workspace
    })}\n\nUser task:\n${redactText(userText, { workspace: this.workspace })}`;
    const input: RunloomModelInputItem[] = [
      {
        type: "message",
        role: "system",
        content: [
          {
            type: "text",
            text:
              "You are Runloom, a professional local coding agent. Be concise, cite local evidence, protect user changes, and summarize verification. Before high-risk code modifications, call edit.plan with target files, risks, and verification commands."
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

    for (let step = 0; step < MAX_MODEL_TOOL_STEPS; step += 1) {
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

      for (const toolCall of toolCalls) {
        input.push({
          type: "function_call",
          toolCallId: toolCall.toolCallId,
          name: toolCall.name,
          arguments: toolCall.arguments,
          raw: toolCall.raw
        });

        const result = await this.executeModelToolCall(toolCall, runId, sessionId, signal);
        if (result.status === "waiting_approval") {
          return {
            status: "waiting_approval",
            outputText: output.join(""),
            approvalId: result.approvalId
          };
        }

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
    }

    throw new RuntimeError(`Model requested tools for more than ${MAX_MODEL_TOOL_STEPS} steps.`, {
      code: "runtime.model_tool_step_limit",
      details: {
        maxSteps: MAX_MODEL_TOOL_STEPS
      }
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
    signal?: AbortSignal
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
      signal
    });
    await this.recordDiffResult(toolCall.name, result);
    this.recordEditPlanResult(toolCall.name, result);
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
  }
}

function cloneRun(run: RunloomRun): RunloomRun {
  return {
    ...run
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

function cloneDiffSummary(diff: RunloomDiffSummary): RunloomDiffSummary {
  return {
    filesChanged: [...diff.filesChanged],
    additions: diff.additions,
    deletions: diff.deletions,
    patch: diff.patch
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
