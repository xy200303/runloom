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
  sessionId: string;
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
    | "eval"
    | "audit"
    | "diff";
  payload: TPayload;
}

export type RunloomEvent = RunloomEventEnvelope;

export type RunloomEventListener = (event: RunloomEvent) => void;
export type Unsubscribe = () => void;

export type RunloomErrorCategory =
  | "provider"
  | "tool"
  | "approval"
  | "store"
  | "security"
  | "runtime"
  | "evolution";

export type RunloomLogLevel = "debug" | "info" | "warn" | "error";

export interface RunloomLogRecord {
  timestamp: string;
  level: RunloomLogLevel;
  source: RunloomEventEnvelope["source"] | "security";
  code: string;
  message: string;
  runId?: string;
  sessionId?: string;
  details?: unknown;
}

export interface RunloomLogger {
  log(record: RunloomLogRecord): void;
}

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

export type RunloomRunStatus = RunResult["status"] | "running";

export interface RunloomRun {
  id: string;
  sessionId: string;
  status: RunloomRunStatus;
  inputText: string;
  createdAt: string;
  updatedAt: string;
  outputText?: string;
  approvalId?: string;
  model?: string;
  profile?: string;
  taskType?: string;
  language?: string;
}

export type RunloomMessageRole = "system" | "user" | "assistant" | "tool";

export interface RunloomMessage {
  id: string;
  runId: string;
  sessionId: string;
  role: RunloomMessageRole;
  content: RunloomContentPart[];
  createdAt: string;
  name?: string;
  toolCallId?: string;
  metadata?: Record<string, string>;
}

export type RunloomTaskType =
  | "frontend_design"
  | "go_development"
  | "prototype_design"
  | "code_review"
  | "test_fix"
  | "general";

export interface ModelRouteMatcher {
  taskType?: RunloomTaskType | string;
  language?: string;
  workspacePattern?: string;
}

export interface ModelRouteConfig {
  when: ModelRouteMatcher;
  model: string;
  profile?: string;
}

export interface RunloomModelConfig {
  default?: string;
  profiles?: Record<string, string>;
  routes?: ModelRouteConfig[];
}

export interface RunloomConfig {
  model?: RunloomModelConfig;
}

export interface ModelSelectionResult {
  providerId: string;
  model: string;
  modelRef: string;
  source: "explicit" | "profile" | "route" | "default" | "fallback";
  reason: string;
  profile?: string;
  taskType?: string;
  language?: string;
  routeIndex?: number;
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

export interface ToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissions: PermissionScope[];
}

export interface RunloomSkillSummary {
  name: string;
  description: string;
  enabled: boolean;
  source: "installed" | "generated" | "workspace" | "registered";
  version?: string;
  triggers?: string[];
  requiredTools?: string[];
}

export interface McpServerSummary {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse" | "custom";
  status: "disconnected" | "connecting" | "connected" | "error";
  tools?: string[];
  resources?: number;
  prompts?: number;
  error?: string;
}

export interface RunloomAuditRecord {
  id: string;
  timestamp: string;
  action: string;
  actor: "user" | "host_app" | "runtime";
  summary: string;
  runId?: string;
  sessionId?: string;
  details?: unknown;
}

export interface ListAuditRecordsOptions {
  action?: string;
  limit?: number;
}

export interface SubmitOptions {
  sessionId?: string;
  model?: string;
  profile?: string;
  taskType?: RunloomTaskType | string;
  language?: string;
  signal?: AbortSignal;
}

export interface SubscribeOptions {
  replay?: boolean;
  sessionId?: string;
}

export interface ListSessionsOptions {
  workspace?: string;
}

export interface ListRunsOptions {
  sessionId?: string;
}

export interface ListEventsOptions {
  sessionId?: string;
  runId?: string;
  limit?: number;
}

export interface ListMessagesOptions {
  sessionId?: string;
  runId?: string;
  limit?: number;
}

export interface RunloomInput {
  text: string;
  model?: string;
  profile?: string;
  taskType?: RunloomTaskType | string;
  language?: string;
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
  reason?: string;
}

export type RunloomEditPlanStatus = "proposed" | "accepted" | "completed" | "cancelled";

export interface RunloomEditPlan extends CodeEditPlan {
  id: string;
  runId: string;
  sessionId: string;
  status: RunloomEditPlanStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ListEditPlansOptions {
  sessionId?: string;
  runId?: string;
  status?: RunloomEditPlanStatus;
  limit?: number;
}

export type RunloomDeliveryVerificationStatus = "passed" | "failed" | "skipped";

export interface RunloomDeliveryVerificationResult {
  command: string;
  status: RunloomDeliveryVerificationStatus;
  exitCode?: number;
  durationMs?: number;
  summary?: string;
}

export interface CodeDeliverySummary {
  modifiedFiles: string[];
  coreChanges: string[];
  verificationResults: RunloomDeliveryVerificationResult[];
  failedItems: string[];
  remainingRisks: string[];
  notes?: string;
}

export interface RunloomDeliverySummary extends CodeDeliverySummary {
  id: string;
  runId: string;
  sessionId: string;
  createdAt: string;
}

export interface ListDeliverySummariesOptions {
  sessionId?: string;
  runId?: string;
  limit?: number;
}

export interface RunloomDiffSummary {
  filesChanged: string[];
  additions?: number;
  deletions?: number;
  patch?: string;
}

export interface RunloomDiffRecord {
  id: string;
  timestamp: string;
  runId: string;
  sessionId: string;
  toolName: string;
  diff: RunloomDiffSummary;
  displayed: boolean;
  displayError?: string;
}

export interface ListDiffRecordsOptions {
  sessionId?: string;
  runId?: string;
  limit?: number;
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
  logger?: RunloomLogger;
}

export interface RunloomAgent {
  submit(input: string | RunloomInput, options?: SubmitOptions): Promise<RunResult>;
  executeTool<TOutput = unknown>(name: string, input: unknown, options?: ExecuteToolOptions): Promise<ToolExecutionResult<TOutput>>;
  listTools(): Promise<ToolSummary[]>;
  listSkills(): Promise<RunloomSkillSummary[]>;
  registerSkill(skill: RunloomSkillSummary): Promise<void>;
  listMcpServers(): Promise<McpServerSummary[]>;
  registerMcpServer(server: McpServerSummary): Promise<void>;
  listApprovals(): Promise<ApprovalRequest[]>;
  listAuditRecords(options?: ListAuditRecordsOptions): Promise<RunloomAuditRecord[]>;
  subscribe(listener: RunloomEventListener, options?: SubscribeOptions): Unsubscribe;
  listSessions(options?: ListSessionsOptions): Promise<RunloomSession[]>;
  getSession(sessionId: string): Promise<RunloomSession>;
  listRuns(options?: ListRunsOptions): Promise<RunloomRun[]>;
  getRun(runId: string): Promise<RunloomRun>;
  listEvents(options?: ListEventsOptions): Promise<RunloomEvent[]>;
  listMessages(options?: ListMessagesOptions): Promise<RunloomMessage[]>;
  listEditPlans(options?: ListEditPlansOptions): Promise<RunloomEditPlan[]>;
  listDeliverySummaries(options?: ListDeliverySummariesOptions): Promise<RunloomDeliverySummary[]>;
  listDiffRecords(options?: ListDiffRecordsOptions): Promise<RunloomDiffRecord[]>;
  resume(runId: string): Promise<RunResult>;
  cancel(runId: string): Promise<void>;
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  getApprovalPolicy(): Promise<ApprovalPolicyConfig>;
  updateApprovalPolicy(patch: ApprovalPolicyPatch): Promise<ApprovalPolicyConfig>;
  registerTool(tool: ToolDefinition): Promise<void>;
  registerProvider(provider: ModelProvider): Promise<void>;
  close(): Promise<void>;
}
