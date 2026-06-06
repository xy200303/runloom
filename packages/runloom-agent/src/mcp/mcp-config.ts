import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpPermissionMode, McpPermissionPolicy, McpServerConfig } from "../types.js";

export interface LoadMcpConfigOptions {
  stateDir?: string;
}

export function loadMcpServerConfigs(options: LoadMcpConfigOptions): McpServerConfig[] {
  if (!options.stateDir) {
    return [];
  }
  const path = join(resolve(options.stateDir), "mcp", "servers.json");
  if (!existsSync(path)) {
    return [];
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid MCP servers JSON at ${path}: ${message}`, { cause: error });
  }

  return parseMcpServersConfig(parsed, path);
}

function parseMcpServersConfig(value: unknown, path: string): McpServerConfig[] {
  if (!isRecord(value) || !isRecord(value.servers)) {
    throw new Error(`MCP config must contain a servers object: ${path}`);
  }

  return Object.entries(value.servers)
    .map(([name, server]) => parseServerConfig(name, server, path))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseServerConfig(name: string, value: unknown, path: string): McpServerConfig {
  if (!isRecord(value)) {
    throw new Error(`MCP server config must be an object for ${name}: ${path}`);
  }
  const transport = parseTransport(value.transport, name, path);
  const config: McpServerConfig = {
    name: parseServerName(name, path),
    enabled: value.enabled === undefined ? true : parseBoolean(value.enabled, `${name}.enabled`, path),
    transport,
    command: value.command === undefined ? undefined : parseString(value.command, `${name}.command`, path),
    args: value.args === undefined ? undefined : parseStringArray(value.args, `${name}.args`, path),
    url: value.url === undefined ? undefined : parseString(value.url, `${name}.url`, path),
    permissions: parsePermissions(value.permissions, path)
  };

  if (transport === "stdio" && !config.command) {
    throw new Error(`MCP stdio server requires command for ${name}: ${path}`);
  }
  if ((transport === "http" || transport === "sse") && !config.url) {
    throw new Error(`MCP ${transport} server requires url for ${name}: ${path}`);
  }
  return config;
}

function parsePermissions(value: unknown, path: string): McpPermissionPolicy {
  const input = isRecord(value) ? value : {};
  return {
    tools: parsePermissionMode(input.tools, "permissions.tools", path, "ask"),
    resources: parsePermissionMode(input.resources, "permissions.resources", path, "allow"),
    prompts: parsePermissionMode(input.prompts, "permissions.prompts", path, "allow"),
    allowedToolNames:
      input.allowedToolNames === undefined ? undefined : parseStringArray(input.allowedToolNames, "permissions.allowedToolNames", path),
    deniedToolNames:
      input.deniedToolNames === undefined ? undefined : parseStringArray(input.deniedToolNames, "permissions.deniedToolNames", path)
  };
}

function parsePermissionMode(value: unknown, field: string, path: string, fallback: McpPermissionMode): McpPermissionMode {
  if (value === undefined) {
    return fallback;
  }
  if (value === "allow" || value === "ask" || value === "deny") {
    return value;
  }
  throw new Error(`MCP ${field} must be allow, ask, or deny: ${path}`);
}

function parseTransport(value: unknown, name: string, path: string): McpServerConfig["transport"] {
  if (value === "stdio" || value === "http" || value === "sse" || value === "custom") {
    return value;
  }
  throw new Error(`MCP server ${name} transport must be stdio, http, sse, or custom: ${path}`);
}

function parseServerName(value: string, path: string): string {
  if (/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)) {
    return value;
  }
  throw new Error(`MCP server name is invalid: ${path}`);
}

function parseBoolean(value: unknown, field: string, path: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`MCP ${field} must be a boolean: ${path}`);
}

function parseString(value: unknown, field: string, path: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`MCP ${field} must be a non-empty string: ${path}`);
}

function parseStringArray(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`MCP ${field} must be a string array: ${path}`);
  }
  return value.map((item) => parseString(item, field, path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
