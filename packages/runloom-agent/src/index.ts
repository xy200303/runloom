import { DefaultRunloomAgent } from "./runtime/default-agent.js";
import type { CreateRunloomAgentOptions, RunloomAgent } from "./types.js";

export async function createRunloomAgent(options: CreateRunloomAgentOptions): Promise<RunloomAgent> {
  return new DefaultRunloomAgent(options);
}

export { OpenAIResponsesProvider } from "./providers/openai-responses-provider.js";
export type {
  ApprovalBridge,
  ApprovalDecision,
  ApprovalMode,
  ApprovalPolicyConfig,
  ApprovalPolicyPatch,
  ApprovalRequest,
  CodeEditPlan,
  CodingTaskSummary,
  CreateRunloomAgentOptions,
  DiagnosticsAdapter,
  DiffAdapter,
  GitStatusSummary,
  ModelCapabilities,
  ModelProvider,
  ModelProviderContext,
  ModelProviderEvent,
  ModelRequest,
  ModelUsage,
  NormalizedProviderError,
  PermissionScope,
  RunResult,
  RunloomAgent,
  RunloomDiffSummary,
  RunloomEvent,
  RunloomEventEnvelope,
  RunloomEventListener,
  RunloomHostAdapter,
  RunloomInput,
  RunloomSession,
  RunloomTodoItem,
  SubmitOptions,
  SubscribeOptions,
  TerminalAdapter,
  ToolContext,
  ToolDefinition,
  Unsubscribe,
  VerificationResult,
  WorkspaceAdapter
} from "./types.js";
