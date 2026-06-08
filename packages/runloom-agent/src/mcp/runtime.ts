import { loadMcpServerConfigs } from "./mcp-config.js";
import type {
  McpClientAdapter,
  McpDiscoveryResult,
  McpServerConfig,
  McpServerSummary,
  McpToolDiscovery,
  RunloomAuditRecord,
  RunloomEventEnvelope,
  ToolDefinition
} from "../types.js";

export interface ConfiguredMcpRuntimeOptions {
  stateDir?: string;
  mcpClient?: McpClientAdapter;
  tools: Map<string, ToolDefinition>;
  emit(
    type: string,
    source: RunloomEventEnvelope["source"],
    runId: string,
    sessionId: string,
    payload: unknown
  ): void;
  recordAudit(input: Omit<RunloomAuditRecord, "id" | "timestamp">): void;
}

export class ConfiguredMcpRuntime {
  private readonly mcpServers = new Map<string, McpServerSummary>();
  private readonly mcpServerConfigs = new Map<string, McpServerConfig>();
  private readonly discoveredMcpServers = new Set<string>();
  private readonly registeredMcpToolNames = new Set<string>();

  constructor(private readonly options: ConfiguredMcpRuntimeOptions) {}

  loadConfigured(): void {
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

  async listServers(): Promise<McpServerSummary[]> {
    await this.discoverConfiguredServers();
    return [...this.mcpServers.values()]
      .map(cloneMcpServer)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  registerServer(server: McpServerSummary): void {
    this.mcpServers.set(server.name, cloneMcpServer(server));
  }

  async discoverConfiguredServers(): Promise<void> {
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
      this.options.emit("mcp.server.connecting", "mcp", "mcp", "global", {
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
        this.options.emit("mcp.error", "mcp", "mcp", "global", {
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
    this.options.emit("mcp.server.connected", "mcp", "mcp", "global", {
      serverName: config.name,
      transport: config.transport
    });
    this.options.emit("mcp.discovery.completed", "mcp", "mcp", "global", {
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
    this.options.tools.set(toolName, {
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
        this.options.emit("mcp.tool.call.requested", "mcp", context.runId, context.sessionId, {
          serverName: config.name,
          toolName: tool.name,
          runloomToolName: toolName
        });
        const output = await this.options.mcpClient.callTool(cloneMcpServerConfig(config), tool.name, input, context);
        this.options.emit("mcp.tool.call.completed", "mcp", context.runId, context.sessionId, {
          serverName: config.name,
          toolName: tool.name,
          runloomToolName: toolName
        });
        this.options.recordAudit({
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
    this.options.emit("mcp.tool.registered", "mcp", "mcp", "global", {
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

function sanitizeToolName(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]/gi, "_") || "tool";
}
