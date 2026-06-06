export type BuiltInProviderName = "openai-responses";

export type ApprovalMode = "full_access" | "ask" | "auto_decide";

export type PermissionScope =
  | "filesystem.read"
  | "filesystem.write"
  | "filesystem.delete"
  | "shell"
  | "network"
  | "browser"
  | "gui"
  | "mcp.tools"
  | "external_agents"
  | "a2a.delegation"
  | "memory.write"
  | "identity.write"
  | "tools.register"
  | "skills.register"
  | "evolution.apply"
  | "npm.publish";

export interface ApprovalPolicyConfig {
  defaultMode: ApprovalMode;
  scopes: Partial<Record<PermissionScope, ApprovalMode>>;
  updatedAt: string;
  updatedBy: "user" | "host_app" | "migration";
}

export interface ApprovalPolicyPatch {
  defaultMode?: ApprovalMode;
  scopes?: Partial<Record<PermissionScope, ApprovalMode>>;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  scope: PermissionScope;
  action: string;
  risk: "low" | "medium" | "high" | "critical";
  mode: ApprovalMode;
  summary: string;
  details: unknown;
  expiresAt?: string;
}

export interface ApprovalDecision {
  decision: "approved" | "denied";
  reason?: string;
  remember?: "never" | "session" | "workspace" | "global";
  setModeForScope?: ApprovalMode;
}

export interface RunloomEventEnvelope<TPayload = unknown> {
  id: string;
  type: string;
  runId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  source:
    | "model"
    | "runtime"
    | "tool"
    | "approval"
    | "coding"
    | "mcp"
    | "a2a"
    | "external_agent"
    | "memory"
    | "evolution"
    | "eval";
  payload: TPayload;
}

export type RunloomEvent = RunloomEventEnvelope;

export type RunloomEventListener = (event: RunloomEvent) => void;
export type Unsubscribe = () => void;

export interface RunloomTodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
  priority?: "low" | "normal" | "high";
  evidence?: string[];
  updatedAt: string;
}

export interface RunloomSession {
  id: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunResult {
  runId: string;
  sessionId: string;
  status: "completed" | "failed" | "cancelled" | "waiting_approval";
  outputText: string;
  approvalId?: string;
}

export interface ExecuteToolOptions {
  runId?: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ToolExecutionResult<TOutput = unknown> {
  toolName: string;
  runId: string;
  sessionId: string;
  status: "completed" | "failed" | "waiting_approval";
  output?: TOutput;
  error?: string;
  approvalId?: string;
  durationMs: number;
}

export interface SubmitOptions {
  sessionId?: string;
  signal?: AbortSignal;
}

export interface SubscribeOptions {
  replay?: boolean;
  sessionId?: string;
}

export interface ListSessionsOptions {
  workspace?: string;
}

export interface RunloomInput {
  text: string;
}

export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  reasoning?: boolean;
  structuredOutput?: boolean;
  vision?: boolean;
  files?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  raw?: unknown;
}

export type ModelFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error" | "unknown";

export interface NormalizedProviderError {
  code: string;
  message: string;
  provider: string;
  retryable: boolean;
  statusCode?: number;
  rateLimited?: boolean;
  authenticationFailed?: boolean;
  contextWindowExceeded?: boolean;
  raw?: unknown;
}

export type ModelProviderEvent =
  | { type: "response.created"; responseId?: string }
  | { type: "response.output_text.delta"; delta: string }
  | { type: "response.reasoning.delta"; delta: string }
  | { type: "response.tool_call.delta"; toolCallId: string; name?: string; argumentsDelta?: string }
  | { type: "response.tool_call.completed"; toolCallId: string; name: string; arguments: unknown; raw?: unknown }
  | { type: "response.structured_output.completed"; value: unknown }
  | { type: "response.usage"; usage: ModelUsage }
  | { type: "response.completed"; finishReason: ModelFinishReason }
  | { type: "response.failed"; error: NormalizedProviderError };

export interface RunloomContentPart {
  type: "text" | "redacted";
  text?: string;
  reason?: string;
}

export interface RunloomModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: RunloomContentPart[];
  toolCallId?: string;
  name?: string;
}

export type RunloomModelInputItem =
  | {
      type: "message";
      role: "system" | "user" | "assistant";
      content: RunloomContentPart[];
    }
  | {
      type: "function_call";
      toolCallId: string;
      name: string;
      arguments: unknown;
      raw?: unknown;
    }
  | {
      type: "function_call_output";
      toolCallId: string;
      output: string;
    };

export interface RunloomModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RunloomResponseFormat {
  type: "text" | "json_schema";
  schema?: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  input?: RunloomModelInputItem[];
  messages?: RunloomModelMessage[];
  tools?: RunloomModelTool[];
  toolChoice?: "auto" | "none" | { name: string };
  responseFormat?: RunloomResponseFormat;
  maxOutputTokens?: number;
  temperature?: number;
  metadata?: Record<string, string>;
}

export interface ModelProviderContext {
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
}

export interface ModelProvider {
  id: string;
  protocol: "openai-responses" | "openai-chat-completions" | "anthropic-messages" | "google-gemini" | "custom";
  capabilities: ModelCapabilities;
  createResponse(request: ModelRequest, context: ModelProviderContext): AsyncIterable<ModelProviderEvent>;
}

export interface ToolContext {
  workspace: string;
  runId: string;
  sessionId: string;
  signal?: AbortSignal;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissions: PermissionScope[];
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface CodingTaskSummary {
  workspace: string;
  packageName?: string;
  packageManager?: string;
  git?: GitStatusSummary;
}

export interface CodeEditPlan {
  goal: string;
  targetFiles: string[];
  risks: string[];
  verificationCommands: string[];
}

export interface RunloomDiffSummary {
  filesChanged: string[];
  additions?: number;
  deletions?: number;
  patch?: string;
}

export interface VerificationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface GitStatusSummary {
  branch?: string;
  isRepository: boolean;
  isDirty: boolean;
  changedFiles: string[];
}

export interface WorkspaceAdapter {
  root: string;
}

export interface TerminalAdapter {
  run(command: string, args?: string[]): AsyncIterable<unknown>;
}

export interface DiffAdapter {
  showDiff(diff: RunloomDiffSummary): Promise<void>;
}

export interface ApprovalBridge {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface DiagnosticsAdapter {
  getDiagnostics?(): Promise<unknown[]>;
}

export interface RunloomHostAdapter {
  kind: "tui" | "vscode" | "web" | "daemon" | "ci" | "custom";
  workspace?: WorkspaceAdapter;
  terminal?: TerminalAdapter;
  diff?: DiffAdapter;
  approvals?: ApprovalBridge;
  diagnostics?: DiagnosticsAdapter;
}

export interface CreateRunloomAgentOptions {
  provider?: BuiltInProviderName | ModelProvider;
  model?: string;
  workspace: string;
  stateDir?: string;
  apiKey?: string;
  baseUrl?: string;
  approvalPolicy?: ApprovalPolicyPatch;
  host?: RunloomHostAdapter;
}

export interface RunloomAgent {
  submit(input: string | RunloomInput, options?: SubmitOptions): Promise<RunResult>;
  executeTool<TOutput = unknown>(name: string, input: unknown, options?: ExecuteToolOptions): Promise<ToolExecutionResult<TOutput>>;
  subscribe(listener: RunloomEventListener, options?: SubscribeOptions): Unsubscribe;
  listSessions(options?: ListSessionsOptions): Promise<RunloomSession[]>;
  getSession(sessionId: string): Promise<RunloomSession>;
  resume(runId: string): Promise<RunResult>;
  cancel(runId: string): Promise<void>;
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  getApprovalPolicy(): Promise<ApprovalPolicyConfig>;
  updateApprovalPolicy(patch: ApprovalPolicyPatch): Promise<ApprovalPolicyConfig>;
  registerTool(tool: ToolDefinition): Promise<void>;
  registerProvider(provider: ModelProvider): Promise<void>;
  close(): Promise<void>;
}
