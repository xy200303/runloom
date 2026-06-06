import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FileApprovalPolicyStore } from "../approvals/file-policy-store.js";
import { applyApprovalPolicyPatch, createDefaultApprovalPolicy } from "../approvals/policy.js";
import { buildWorkspaceContext, inspectWorkspace } from "../coding/workspace-summary.js";
import { loadRunloomConfig, selectModel } from "../config/runloom-config.js";
import { RunloomEventBus } from "../events/event-bus.js";
import { OpenAIResponsesProvider } from "../providers/openai-responses-provider.js";
import { InMemorySessionStore } from "../sessions/in-memory-store.js";
import { createBuiltInCodingTools } from "../tools/coding-tools.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type {
  ApprovalDecision,
  ApprovalPolicyConfig,
  ApprovalPolicyPatch,
  CreateRunloomAgentOptions,
  ExecuteToolOptions,
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
  RunloomInput,
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

export class DefaultRunloomAgent implements RunloomAgent {
  private readonly workspace: string;
  private readonly bus = new RunloomEventBus();
  private readonly store = new InMemorySessionStore();
  private readonly providers = new Map<string, ModelProvider>();
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly skills = new Map<string, RunloomSkillSummary>();
  private readonly mcpServers = new Map<string, McpServerSummary>();
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
      emit: (type, source, runId, sessionId, payload) => this.emit(type, source, runId, sessionId, payload)
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
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", abortFromParent, { once: true });
    }
    this.activeRuns.set(runId, { sessionId: session.id, controller });

    this.emit("run.started", "runtime", runId, session.id, {
      input: text,
      workspace: this.workspace
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
        this.emit("run.waiting_approval", "runtime", runId, session.id, {
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
      this.emit("todo.updated", "runtime", runId, session.id, { items: [completedTodo] });
      this.emit("run.completed", "runtime", runId, session.id, {
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
      throw new Error(`Tool not found: ${name}`);
    }

    const session = options.sessionId ? await this.getSession(options.sessionId) : this.store.createSession(this.workspace);
    const runId = options.runId ?? `run_${randomUUID()}`;

    return this.toolExecutor.execute<TOutput>(tool, input, {
      workspace: this.workspace,
      runId,
      sessionId: session.id,
      signal: options.signal
    });
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

  async getSession(sessionId: string): Promise<RunloomSession> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  async resume(runId: string): Promise<RunResult> {
    throw new Error(`Run resume is not implemented yet: ${runId}`);
  }

  async cancel(runId: string): Promise<void> {
    const activeRun = this.activeRuns.get(runId);
    if (activeRun) {
      activeRun.controller.abort();
      this.emit("run.cancel_requested", "runtime", runId, activeRun.sessionId, {});
      return;
    }
    this.emit("run.cancelled", "runtime", runId, "unknown", {
      reason: "not_active"
    });
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const approval = this.store.getApproval(approvalId);
    this.store.resolveApproval(approvalId, decision);
    if (approval?.runId) {
      this.emit("approval.resolved", "approval", approval.runId, "unknown", {
        approvalId,
        decision
      });
    }
  }

  async getApprovalPolicy(): Promise<ApprovalPolicyConfig> {
    return this.approvalPolicy;
  }

  async updateApprovalPolicy(patch: ApprovalPolicyPatch): Promise<ApprovalPolicyConfig> {
    this.approvalPolicy = applyApprovalPolicyPatch(this.approvalPolicy, patch);
    this.approvalPolicyStore?.save(this.approvalPolicy);
    this.emit("approval.policy.updated", "approval", "policy", "global", this.approvalPolicy);
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
    const input: RunloomModelInputItem[] = [
      {
        type: "message",
        role: "system",
        content: [
          {
            type: "text",
            text:
              "You are Runloom, a professional local coding agent. Be concise, cite local evidence, protect user changes, and summarize verification."
          }
        ]
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "text",
            text: `${workspaceContext}\n\nUser task:\n${userText}`
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
          output.push(event.delta);
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
          throw new Error(event.error.message);
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

        input.push({
          type: "function_call_output",
          toolCallId: toolCall.toolCallId,
          output: stringifyToolResult(result)
        });
      }
    }

    throw new Error(`Model requested tools for more than ${MAX_MODEL_TOOL_STEPS} steps.`);
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
      return {
        toolName: toolCall.name,
        runId,
        sessionId,
        status: "failed",
        error: `Tool not found: ${toolCall.name}`,
        durationMs: 0
      };
    }

    return this.toolExecutor.execute(tool, toolCall.arguments, {
      workspace: this.workspace,
      runId,
      sessionId,
      signal
    });
  }

  private forwardProviderEvent(event: ModelProviderEvent, runId: string, sessionId: string): void {
    this.emit(event.type, "model", runId, sessionId, event);
  }

  private getActiveProvider(): ModelProvider {
    const provider = this.providers.values().next().value as ModelProvider | undefined;
    if (!provider) {
      throw new Error("No model provider is registered.");
    }
    return provider;
  }

  private getProvider(providerId: string): ModelProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Model provider is not registered: ${providerId}`);
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
      payload
    });
  }
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
