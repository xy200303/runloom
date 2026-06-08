import { randomUUID } from "node:crypto";
import { RuntimeError, ToolError } from "../errors.js";
import type {
  CreateRunloomMcpServerOptions,
  ExecuteToolOptions,
  ListMessagesOptions,
  ListRunsOptions,
  RunResult,
  RunloomAuditRecord,
  RunloomEventEnvelope,
  RunloomInput,
  RunloomMcpPromptResult,
  RunloomMcpPromptSummary,
  RunloomMcpResourceReadResult,
  RunloomMcpServerAdapter,
  RunloomMcpServerResource,
  RunloomMcpServerTool,
  RunloomMcpServerToolCallOptions,
  RunloomMcpToolCallResult,
  RunloomMessage,
  RunloomRun,
  RunloomSession,
  RunloomSkillProposal,
  RunloomSkillSummary,
  SubmitOptions,
  ToolDefinition,
  ToolExecutionResult
} from "../types.js";

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

export interface RunloomMcpServerRuntimeOptions {
  tools: Map<string, ToolDefinition>;
  createSession(sessionId?: string): Promise<RunloomSession>;
  listSkills(): Promise<RunloomSkillSummary[]>;
  listSkillProposals(): Promise<RunloomSkillProposal[]>;
  listSessions(): Promise<RunloomSession[]>;
  listRuns(options?: ListRunsOptions): Promise<RunloomRun[]>;
  listMessages(options?: ListMessagesOptions): Promise<RunloomMessage[]>;
  executeTool(name: string, input: unknown, options?: ExecuteToolOptions): Promise<ToolExecutionResult>;
  submit(input: RunloomInput, options?: SubmitOptions): Promise<RunResult>;
  emit(
    type: string,
    source: RunloomEventEnvelope["source"],
    runId: string,
    sessionId: string,
    payload: unknown
  ): void;
  recordAudit(input: Omit<RunloomAuditRecord, "id" | "timestamp">): void;
}

export class RunloomMcpServerRuntime {
  constructor(private readonly options: RunloomMcpServerRuntimeOptions) {}

  createServer(options: CreateRunloomMcpServerOptions = {}): RunloomMcpServerAdapter {
    const config = normalizeMcpServerOptions(options);
    return {
      name: config.name,
      listTools: () => this.listTools(config),
      callTool: (name, input, callOptions) => this.callTool(config, name, input, callOptions),
      listResources: () => this.listResources(config),
      readResource: (uri) => this.readResource(config, uri),
      listPrompts: () => this.listPrompts(),
      getPrompt: (name, args) => this.getPrompt(config, name, args)
    };
  }

  private async listTools(config: NormalizedMcpServerOptions): Promise<RunloomMcpServerTool[]> {
    const tools: RunloomMcpServerTool[] = [];
    if (config.exposeRunloomTools) {
      for (const tool of this.options.tools.values()) {
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

  private async callTool(
    config: NormalizedMcpServerOptions,
    name: string,
    input: unknown,
    options: RunloomMcpServerToolCallOptions = {}
  ): Promise<RunloomMcpToolCallResult> {
    if (name === "runloom.memory.query" && config.exposeMemoryQuery && isMcpServerToolNameAllowed(config, name)) {
      return this.callMemoryQuery(input, options);
    }
    if (
      name === "runloom.agent.submit" &&
      !config.readOnly &&
      config.exposeAgentService &&
      isMcpServerToolNameAllowed(config, name)
    ) {
      return this.callAgentSubmit(input, options);
    }

    const tool = this.options.tools.get(name);
    if (!tool || !config.exposeRunloomTools || !shouldExposeRunloomTool(config, tool)) {
      throw new ToolError(`MCP server tool not found or not exposed: ${name}`, {
        code: "tool.not_found",
        details: {
          toolName: name,
          mcpServer: config.name
        }
      });
    }

    const context = await this.createCallContext(options);
    this.options.emit("mcp.server.tool.call.requested", "mcp", context.runId, context.sessionId, {
      serverName: config.name,
      toolName: name,
      runloomToolName: name
    });
    const result = await this.options.executeTool(name, input, {
      runId: context.runId,
      sessionId: context.sessionId,
      signal: options.signal
    });
    this.options.emit("mcp.server.tool.call.completed", "mcp", result.runId, result.sessionId, {
      serverName: config.name,
      toolName: name,
      runloomToolName: name,
      status: result.status,
      approvalId: result.approvalId
    });
    this.options.recordAudit({
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

  private async callMemoryQuery(
    input: unknown,
    options: RunloomMcpServerToolCallOptions
  ): Promise<RunloomMcpToolCallResult> {
    const context = await this.createCallContext(options);
    const query = parseMemoryQueryInput(input);
    const output = {
      query: query.query,
      limit: query.limit,
      records: [],
      status: "unavailable",
      message: "Runloom memory stores are not implemented yet."
    };
    this.options.emit("mcp.server.tool.call.requested", "mcp", context.runId, context.sessionId, {
      serverName: "runloom",
      toolName: "runloom.memory.query"
    });
    this.options.emit("mcp.server.tool.call.completed", "mcp", context.runId, context.sessionId, {
      serverName: "runloom",
      toolName: "runloom.memory.query",
      status: "completed"
    });
    this.options.recordAudit({
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

  private async callAgentSubmit(
    input: unknown,
    options: RunloomMcpServerToolCallOptions
  ): Promise<RunloomMcpToolCallResult> {
    const parsed = parseAgentSubmitInput(input);
    const context = await this.createCallContext({
      ...options,
      sessionId: options.sessionId ?? parsed.sessionId
    });
    this.options.emit("mcp.server.tool.call.requested", "mcp", context.runId, context.sessionId, {
      serverName: "runloom",
      toolName: "runloom.agent.submit"
    });
    const result = await this.options.submit(parsed.input, {
      sessionId: context.sessionId,
      signal: options.signal
    });
    this.options.emit("mcp.server.tool.call.completed", "mcp", result.runId, result.sessionId, {
      serverName: "runloom",
      toolName: "runloom.agent.submit",
      status: result.status,
      approvalId: result.approvalId
    });
    this.options.recordAudit({
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

  private async createCallContext(options: RunloomMcpServerToolCallOptions): Promise<{ runId: string; sessionId: string }> {
    const session = await this.options.createSession(options.sessionId);
    return {
      runId: options.runId ?? `mcpserver_${randomUUID()}`,
      sessionId: session.id
    };
  }

  private async listResources(config: NormalizedMcpServerOptions): Promise<RunloomMcpServerResource[]> {
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
      for (const skill of await this.options.listSkills()) {
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
      for (const session of await this.options.listSessions()) {
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

  private async readResource(config: NormalizedMcpServerOptions, uri: string): Promise<RunloomMcpResourceReadResult> {
    const payload = await this.resolveResource(config, uri);
    this.options.emit("mcp.resource.read", "mcp", "mcp", "global", {
      serverName: config.name,
      uri
    });
    this.options.recordAudit({
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

  private async resolveResource(config: NormalizedMcpServerOptions, uri: string): Promise<unknown> {
    if (uri === "runloom://skills" && config.exposeSkills) {
      return {
        skills: await this.options.listSkills()
      };
    }
    if (uri === "runloom://skill-proposals" && config.exposeSkills) {
      return {
        proposals: await this.options.listSkillProposals()
      };
    }
    if (uri.startsWith("runloom://skills/") && config.exposeSkills) {
      const skillName = decodeURIComponent(uri.slice("runloom://skills/".length));
      const skill = (await this.options.listSkills()).find((item) => item.name === skillName);
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
        sessions: await this.options.listSessions()
      };
    }
    if (uri.startsWith("runloom://sessions/") && uri.endsWith("/summary") && config.exposeSessions) {
      const sessionId = decodeURIComponent(uri.slice("runloom://sessions/".length, -"/summary".length));
      const session = await this.options.createSession(sessionId);
      return {
        session,
        runs: await this.options.listRuns({ sessionId }),
        messages: await this.options.listMessages({ sessionId, limit: 20 })
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

  private async listPrompts(): Promise<RunloomMcpPromptSummary[]> {
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

  private async getPrompt(
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
    this.options.emit("mcp.prompt.activated", "mcp", "mcp", "global", {
      serverName: config.name,
      promptName: name
    });
    this.options.recordAudit({
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
