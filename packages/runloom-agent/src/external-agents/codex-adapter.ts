import type { ExternalAgentAdapter } from "../types.js";
import {
  createLocalCliExternalAgentAdapter,
  type LocalCliExternalAgentAdapterOptions
} from "./local-cli-adapter.js";

const DEFAULT_CODEX_CAPABILITIES = ["code_review", "edit"] as const;

export interface CodexExternalAgentAdapterOptions extends Partial<LocalCliExternalAgentAdapterOptions> {}

export function createCodexExternalAgentAdapter(
  options: CodexExternalAgentAdapterOptions = {}
): ExternalAgentAdapter {
  return createLocalCliExternalAgentAdapter({
    name: options.name ?? "codex",
    description: options.description ?? "Codex CLI",
    command: options.command ?? "codex",
    enabled: options.enabled,
    status: options.status,
    capabilities: options.capabilities ? [...options.capabilities] : [...DEFAULT_CODEX_CAPABILITIES],
    maxTurns: options.maxTurns,
    error: options.error
  });
}
