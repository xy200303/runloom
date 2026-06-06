import { DefaultRunloomAgent } from "./runtime/default-agent.js";
import type { CreateRunloomAgentOptions, RunloomAgent } from "./types.js";

export async function createRunloomAgent(options: CreateRunloomAgentOptions): Promise<RunloomAgent> {
  return new DefaultRunloomAgent(options);
}

export { APPROVAL_MODES, PERMISSION_SCOPES } from "./approvals/policy.js";
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
  ExecuteToolOptions,
  GitStatusSummary,
  ModelCapabilities,
  ModelProvider,
  ModelProviderContext,
  ModelProviderEvent,
  ModelRequest,
  ModelRouteConfig,
  ModelRouteMatcher,
  ModelSelectionResult,
  ModelUsage,
  NormalizedProviderError,
  PermissionScope,
  RunResult,
  RunloomAgent,
  RunloomConfig,
  RunloomContentPart,
  RunloomDiffSummary,
  RunloomEvent,
  RunloomEventEnvelope,
  RunloomEventListener,
  RunloomHostAdapter,
  RunloomInput,
  RunloomModelConfig,
  RunloomModelInputItem,
  RunloomModelMessage,
  RunloomModelTool,
  RunloomSession,
  RunloomTaskType,
  RunloomTodoItem,
  SubmitOptions,
  SubscribeOptions,
  TerminalAdapter,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolSummary,
  Unsubscribe,
  VerificationResult,
  WorkspaceAdapter
} from "./types.js";
