import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { applyApprovalPolicyPatch, createDefaultApprovalPolicy } from "../approvals/policy.js";
import { buildWorkspaceContext, inspectWorkspace } from "../coding/workspace-summary.js";
import { RunloomEventBus } from "../events/event-bus.js";
import { OpenAIResponsesProvider } from "../providers/openai-responses-provider.js";
import { InMemorySessionStore } from "../sessions/in-memory-store.js";
import type {
  ApprovalDecision,
  ApprovalPolicyConfig,
  ApprovalPolicyPatch,
  CreateRunloomAgentOptions,
  ModelProvider,
  ModelProviderEvent,
  RunResult,
  RunloomAgent,
  RunloomEvent,
  RunloomEventListener,
  RunloomInput,
  RunloomSession,
  RunloomTodoItem,
  SubscribeOptions,
  SubmitOptions,
  ToolDefinition,
  Unsubscribe
} from "../types.js";

export class DefaultRunloomAgent implements RunloomAgent {
  private readonly workspace: string;
  private readonly bus = new RunloomEventBus();
  private readonly store = new InMemorySessionStore();
  private readonly providers = new Map<string, ModelProvider>();
  private readonly tools = new Map<string, ToolDefinition>();
  private approvalPolicy: ApprovalPolicyConfig;
  private sequence = 0;

  constructor(private readonly options: CreateRunloomAgentOptions) {
    this.workspace = resolve(options.workspace);
    this.approvalPolicy = createDefaultApprovalPolicy(options.approvalPolicy);

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
  }

  async submit(input: string | RunloomInput, options: SubmitOptions = {}): Promise<RunResult> {
    const text = typeof input === "string" ? input : input.text;
    const session = options.sessionId ? await this.getSession(options.sessionId) : this.store.createSession(this.workspace);
    const runId = `run_${randomUUID()}`;

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

      const provider = this.getActiveProvider();
      const outputText = await this.runModel(provider, runId, session.id, text, buildWorkspaceContext(inspection), options.signal);

      const completedTodo: RunloomTodoItem = {
        ...todo,
        status: "completed",
        updatedAt: new Date().toISOString()
      };
      this.emit("todo.updated", "runtime", runId, session.id, { items: [completedTodo] });
      this.emit("run.completed", "runtime", runId, session.id, {
        outputText
      });
      this.store.touchSession(session.id);

      return {
        runId,
        sessionId: session.id,
        status: "completed",
        outputText
      };
    } catch (error) {
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
    }
  }

  subscribe(listener: RunloomEventListener, options?: SubscribeOptions): Unsubscribe {
    return this.bus.subscribe(listener, options);
  }

  async listSessions(): Promise<RunloomSession[]> {
    return this.store.listSessions(this.workspace);
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
    this.emit("run.cancelled", "runtime", runId, "unknown", {});
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
    runId: string,
    sessionId: string,
    userText: string,
    workspaceContext: string,
    signal?: AbortSignal
  ): Promise<string> {
    const output: string[] = [];
    const model = this.options.model ?? "gpt-4.1";

    const events = provider.createResponse(
      {
        model,
        messages: [
          {
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
            role: "user",
            content: [
              {
                type: "text",
                text: `${workspaceContext}\n\nUser task:\n${userText}`
              }
            ]
          }
        ],
        metadata: {
          runtime: "runloom"
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
      if (event.type === "response.failed") {
        throw new Error(event.error.message);
      }
    }

    return output.join("");
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

  private registerProviderSync(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
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
