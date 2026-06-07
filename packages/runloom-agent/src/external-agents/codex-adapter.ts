import type { ExternalAgentAdapter, ExternalAgentAdapterStatus } from "../types.js";

const DEFAULT_CODEX_CAPABILITIES = ["code_review", "edit"] as const;

export interface CodexExternalAgentAdapterOptions {
  name?: string;
  description?: string;
  command?: string;
  enabled?: boolean;
  status?: ExternalAgentAdapterStatus;
  capabilities?: string[];
  maxTurns?: number;
  error?: string;
}

export function createCodexExternalAgentAdapter(
  options: CodexExternalAgentAdapterOptions = {}
): ExternalAgentAdapter {
  const enabled = options.enabled ?? true;
  return {
    name: options.name ?? "codex",
    description: options.description ?? "Codex CLI",
    kind: "local_cli",
    enabled,
    status: options.status ?? (enabled ? "available" : "disabled"),
    capabilities: options.capabilities ? [...options.capabilities] : [...DEFAULT_CODEX_CAPABILITIES],
    command: options.command ?? "codex",
    maxTurns: options.maxTurns ?? 3,
    error: options.error
  };
}
