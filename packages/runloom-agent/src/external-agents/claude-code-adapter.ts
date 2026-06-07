import type { ExternalAgentAdapter, ExternalAgentAdapterStatus } from "../types.js";

const DEFAULT_CLAUDE_CODE_CAPABILITIES = ["code_review", "edit"] as const;

export interface ClaudeCodeExternalAgentAdapterOptions {
  name?: string;
  description?: string;
  command?: string;
  enabled?: boolean;
  status?: ExternalAgentAdapterStatus;
  capabilities?: string[];
  maxTurns?: number;
  error?: string;
}

export function createClaudeCodeExternalAgentAdapter(
  options: ClaudeCodeExternalAgentAdapterOptions = {}
): ExternalAgentAdapter {
  const enabled = options.enabled ?? true;
  return {
    name: options.name ?? "claude-code",
    description: options.description ?? "Claude Code CLI",
    kind: "local_cli",
    enabled,
    status: options.status ?? (enabled ? "available" : "disabled"),
    capabilities: options.capabilities ? [...options.capabilities] : [...DEFAULT_CLAUDE_CODE_CAPABILITIES],
    command: options.command ?? "claude",
    maxTurns: options.maxTurns ?? 3,
    error: options.error
  };
}
