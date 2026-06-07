import type { ExternalAgentAdapter, ExternalAgentAdapterStatus } from "../types.js";

export interface LocalCliExternalAgentAdapterOptions {
  name: string;
  description: string;
  command: string;
  enabled?: boolean;
  status?: ExternalAgentAdapterStatus;
  capabilities?: string[];
  maxTurns?: number;
  error?: string;
}

export function createLocalCliExternalAgentAdapter(
  options: LocalCliExternalAgentAdapterOptions
): ExternalAgentAdapter {
  const enabled = options.enabled ?? true;
  return {
    name: options.name,
    description: options.description,
    kind: "local_cli",
    enabled,
    status: options.status ?? (enabled ? "available" : "disabled"),
    capabilities: options.capabilities ? [...options.capabilities] : undefined,
    command: options.command,
    maxTurns: options.maxTurns ?? 3,
    error: options.error
  };
}
