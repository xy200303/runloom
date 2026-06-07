import type { ExternalAgentAdapter } from "../types.js";
import {
  createLocalCliExternalAgentAdapter,
  type LocalCliExternalAgentAdapterOptions
} from "./local-cli-adapter.js";

const DEFAULT_CLAUDE_CODE_CAPABILITIES = ["code_review", "edit"] as const;

export interface ClaudeCodeExternalAgentAdapterOptions extends Partial<LocalCliExternalAgentAdapterOptions> {}

export function createClaudeCodeExternalAgentAdapter(
  options: ClaudeCodeExternalAgentAdapterOptions = {}
): ExternalAgentAdapter {
  return createLocalCliExternalAgentAdapter({
    name: options.name ?? "claude-code",
    description: options.description ?? "Claude Code CLI",
    command: options.command ?? "claude",
    enabled: options.enabled,
    status: options.status,
    capabilities: options.capabilities ? [...options.capabilities] : [...DEFAULT_CLAUDE_CODE_CAPABILITIES],
    maxTurns: options.maxTurns,
    error: options.error
  });
}
