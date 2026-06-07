export type BuiltInProviderName =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "google-gemini";

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
  instructions?: string;
  permissions?: RunloomSkillPermissions;
  validation?: RunloomSkillValidation;
  contentHash?: string;
  diagnostics?: string[];
}

export interface RunloomSkillPermissions {
  readWorkspace?: boolean;
  writeWorkspace?: boolean;
  shell?: ApprovalMode | boolean;
}

export interface RunloomSkillValidation {
  schema: "skill-manifest@1";
  tests?: string[];
}

export interface RunloomSkillActivation {
  skillName: string;
  version?: string;
  reason: string;
  confidence: number;
  contextBudgetTokens: number;
}

export type RunloomSkillProposalChangeType = "create" | "update" | "disable" | "delete";

export type RunloomSkillProposalStatus = "invalid" | "waiting_approval" | "approved" | "denied" | "installed";

export interface RunloomSkillManifestDraft {
  name: string;
  description: string;
  version?: string;
  triggers?: string[];
  requiredTools?: string[];
  permissions?: RunloomSkillPermissions;
  validation: RunloomSkillValidation;
}

export interface RunloomSkillProposalValidationResult {
  valid: boolean;
  diagnostics: string[];
  tests?: string[];
}

export interface RunloomSkillRiskAssessment {
  level: ApprovalRequest["risk"];
  reasons: string[];
}

export interface CreateRunloomSkillProposalInput {
  skillName?: string;
  changeType: RunloomSkillProposalChangeType;
  reason: string;
  evidence?: string[];
  manifest?: RunloomSkillManifestDraft;
  instructions?: string;
  diff?: string;
}

export interface CreateRunloomSkillProposalOptions {
  sessionId?: string;
  runId?: string;
}

export interface RunloomSkillProposal {
  id: string;
  skillName: string;
  changeType: RunloomSkillProposalChangeType;
  reason: string;
  evidence: string[];
  diff: string;
  validation: RunloomSkillProposalValidationResult;
  risk: RunloomSkillRiskAssessment;
  status: RunloomSkillProposalStatus;
  createdAt: string;
  updatedAt: string;
  runId: string;
  sessionId: string;
  manifest?: RunloomSkillManifestDraft;
  instructions?: string;
  approvalId?: string;
  approvedAt?: string;
  deniedAt?: string;
  installedAt?: string;
  diagnostics?: string[];
}

export interface ListSkillProposalsOptions {
  status?: RunloomSkillProposalStatus;
  limit?: number;
}

export type ExternalAgentAdapterKind = "local_cli" | "sdk" | "a2a" | "custom";

export type ExternalAgentAdapterStatus = "disabled" | "available" | "unavailable" | "error";

export interface ExternalAgentContextItem {
  kind: "text" | "file" | "diff" | "diagnostic";
  title?: string;
  text?: string;
  path?: string;
}

export type ExternalAgentOutputFormat = "summary" | "json" | "patch" | "report";

export interface ExternalAgentOutputContract {
  format: ExternalAgentOutputFormat;
  schema?: Record<string, unknown>;
  requireChangedFilesSummary?: boolean;
  requireVerificationNotes?: boolean;
}

export interface ExternalAgentDelegationRequest {
  task: string;
  workspace: string;
  sessionId?: string;
  runId?: string;
  approvalId?: string;
  maxTurns?: number;
  constraints?: string[];
  expectedOutput?: ExternalAgentOutputContract;
  context?: ExternalAgentContextItem[];
}

export interface ExternalAgentDelegationResult {
  status: "completed" | "failed" | "cancelled" | "waiting_approval";
  summary: string;
  approvalId?: string;
  outputText?: string;
  structuredOutput?: unknown;
  changedFiles?: string[];
  verificationNotes?: string[];
  events?: RunloomEvent[];
  diagnostics?: string[];
}

export interface ExternalAgentAdapter {
  name: string;
  description: string;
  kind: ExternalAgentAdapterKind;
  enabled?: boolean;
  status?: ExternalAgentAdapterStatus;
  capabilities?: string[];
  command?: string;
  maxTurns?: number;
  error?: string;
  delegate?: (request: ExternalAgentDelegationRequest) => Promise<ExternalAgentDelegationResult>;
}

export interface ExternalAgentSummary {
  name: string;
  description: string;
  kind: ExternalAgentAdapterKind;
  enabled: boolean;
  status: ExternalAgentAdapterStatus;
  capabilities?: string[];
  command?: string;
  maxTurns?: number;
  error?: string;
}

export type A2APeerTransport = "http" | "stdio" | "sse" | "custom";

export type A2APeerStatus = "disabled" | "available" | "unavailable" | "error";

export interface A2ACapabilitySummary {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface A2APeerSummary {
  id: string;
  name: string;
  version?: string;
  endpoint?: string;
  transport?: A2APeerTransport;
  enabled: boolean;
  status: A2APeerStatus;
  capabilities?: A2ACapabilitySummary[];
  error?: string;
}

export interface A2ADelegationRequest {
  task: string;
  workspace: string;
  sessionId?: string;
  runId?: string;
  approvalId?: string;
  capability?: string;
  constraints?: string[];
  context?: ExternalAgentContextItem[];
}

export interface A2ADelegationResult {
  status: "completed" | "failed" | "cancelled" | "waiting_approval";
  summary: string;
  approvalId?: string;
  outputText?: string;
  structuredOutput?: unknown;
  events?: RunloomEvent[];
  diagnostics?: string[];
}

export interface A2APeerRegistration extends A2APeerSummary {
  delegate?: (request: A2ADelegationRequest) => Promise<A2ADelegationResult>;
}

export interface McpServerSummary {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse" | "custom";
  status: "disconnected" | "connecting" | "connected" | "error";
  tools?: string[];
  resources?: number;
  prompts?: number;
  permissions?: McpPermissionPolicy;
  error?: string;
}

export type McpPermissionMode = "allow" | "ask" | "deny";

export interface McpPermissionPolicy {
  tools: McpPermissionMode;
  resources: McpPermissionMode;
  prompts: McpPermissionMode;
  allowedToolNames?: string[];
  deniedToolNames?: string[];
}

export interface McpServerConfig {
  name: string;
  enabled: boolean;
  transport: McpServerSummary["transport"];
  command?: string;
  args?: string[];
  url?: string;
  permissions: McpPermissionPolicy;
}

export interface McpToolDiscovery {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResourceDiscovery {
  uri: string;
  name?: string;
  description?: string;
}

export interface McpPromptDiscovery {
  name: string;
  description?: string;
}

export interface McpDiscoveryResult {
  tools?: McpToolDiscovery[];
  resources?: McpResourceDiscovery[];
  prompts?: McpPromptDiscovery[];
}

export interface McpClientAdapter {
  discover(server: McpServerConfig): Promise<McpDiscoveryResult>;
  callTool?(server: McpServerConfig, toolName: string, input: unknown, context: ToolContext): Promise<unknown>;
}

export interface CreateRunloomMcpServerOptions {
  name?: string;
  readOnly?: boolean;
  exposeRunloomTools?: boolean;
  exposeSkills?: boolean;
  exposeSessions?: boolean;
  exposeMemoryQuery?: boolean;
  exposeAgentService?: boolean;
  allowedToolNames?: string[];
  deniedToolNames?: string[];
}

export interface RunloomMcpServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissions?: PermissionScope[];
  runloomToolName?: string;
}

export interface RunloomMcpServerToolCallOptions {
  sessionId?: string;
  runId?: string;
  signal?: AbortSignal;
}

export interface RunloomMcpContentPart {
  type: "text";
  text: string;
  mimeType?: string;
}

export interface RunloomMcpToolCallResult {
  toolName: string;
  runId: string;
  sessionId: string;
  status: ToolExecutionResult["status"] | RunResult["status"];
  content: RunloomMcpContentPart[];
  structuredContent?: unknown;
  approvalId?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface RunloomMcpServerResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface RunloomMcpResourceReadResult {
  uri: string;
  mimeType: string;
  text: string;
  structuredContent?: unknown;
}

export interface RunloomMcpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface RunloomMcpPromptSummary {
  name: string;
  description?: string;
  arguments?: RunloomMcpPromptArgument[];
}

export interface RunloomMcpPromptResult {
  name: string;
  description?: string;
  messages: RunloomModelMessage[];
}

export interface RunloomMcpServerAdapter {
  name: string;
  listTools(): Promise<RunloomMcpServerTool[]>;
  callTool(name: string, input: unknown, options?: RunloomMcpServerToolCallOptions): Promise<RunloomMcpToolCallResult>;
  listResources(): Promise<RunloomMcpServerResource[]>;
  readResource(uri: string): Promise<RunloomMcpResourceReadResult>;
  listPrompts(): Promise<RunloomMcpPromptSummary[]>;
  getPrompt(name: string, args?: Record<string, unknown>): Promise<RunloomMcpPromptResult>;
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

export type RunloomReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type RunloomReviewFindingCategory =
  | "bug"
  | "regression"
  | "security"
  | "performance"
  | "maintainability"
  | "test_gap"
  | "api_risk"
  | "other";

export interface RunloomReviewLocation {
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface CodeReviewFinding {
  severity: RunloomReviewFindingSeverity;
  title: string;
  description: string;
  category?: RunloomReviewFindingCategory;
  location?: RunloomReviewLocation;
  evidence?: string[];
  recommendation?: string;
}

export interface CodeReviewFindings {
  findings: CodeReviewFinding[];
  reviewedFiles: string[];
  summary?: string;
}

export interface RunloomReviewFindings extends CodeReviewFindings {
  id: string;
  runId: string;
  sessionId: string;
  createdAt: string;
}

export interface ListReviewFindingsOptions {
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
  roots?: WorkspaceRoot[];
  kind?: "local" | "virtual" | "remote" | "custom";
  readonly?: boolean;
  listFiles?(query?: WorkspaceFileQuery): Promise<WorkspaceFile[]>;
  readFile?(path: string, options?: WorkspaceReadFileOptions): Promise<WorkspaceFileContent>;
  applyPatch?(patch: UnifiedPatch, options?: ApplyPatchOptions): Promise<PatchResult>;
  stat?(path: string): Promise<WorkspaceFileStat>;
  getGitStatus?(): Promise<GitStatusSummary>;
}

export interface WorkspaceRoot {
  id: string;
  name?: string;
  path: string;
  readonly?: boolean;
  virtual?: boolean;
}

export interface WorkspaceFileQuery {
  rootId?: string;
  path?: string;
  recursive?: boolean;
  maxEntries?: number;
  includeDirectories?: boolean;
}

export interface WorkspaceFile {
  path: string;
  rootId?: string;
  type: "file" | "directory" | "symlink" | "unknown";
  size?: number;
  modifiedAt?: string;
}

export interface WorkspaceReadFileOptions {
  maxBytes?: number;
  encoding?: "utf8";
}

export interface WorkspaceFileContent {
  path: string;
  rootId?: string;
  content: string;
  encoding: "utf8";
  truncated?: boolean;
}

export interface UnifiedPatch {
  patch: string;
  filesChanged?: string[];
}

export interface ApplyPatchOptions {
  rootId?: string;
  dryRun?: boolean;
  allowDirty?: boolean;
}

export interface PatchResult {
  applied: boolean;
  diff?: RunloomDiffSummary;
  message?: string;
}

export interface WorkspaceFileStat {
  path: string;
  rootId?: string;
  type: WorkspaceFile["type"];
  size?: number;
  modifiedAt?: string;
  readonly?: boolean;
}

export interface TerminalAdapter {
  run(command: RunloomCommand, options?: TerminalRunOptions): AsyncIterable<TerminalEvent>;
}

export interface RunloomCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface TerminalRunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type TerminalEvent =
  | { type: "started"; command: string; args?: string[]; cwd?: string }
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; exitCode: number; signal?: string; durationMs?: number }
  | { type: "failed"; error: string; exitCode?: number; durationMs?: number };

export interface DiffAdapter {
  showDiff(diff: RunloomDiffSummary, options?: ShowDiffOptions): Promise<void>;
  showPatchPreview?(patch: UnifiedPatch): Promise<DiffDecision>;
}

export interface ShowDiffOptions {
  title?: string;
  runId?: string;
  sessionId?: string;
}

export interface DiffDecision {
  decision: "accepted" | "rejected" | "edited";
  patch?: UnifiedPatch;
  reason?: string;
}

export interface ApprovalBridge {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  onPolicyUpdated?(policy: ApprovalPolicyConfig): void;
}

export interface DiagnosticsAdapter {
  getDiagnostics?(context?: DiagnosticsContext): Promise<RunloomDiagnostic[]>;
}

export interface DiagnosticsContext {
  workspace: string;
  sessionId?: string;
  runId?: string;
}

export interface RunloomDiagnostic {
  path: string;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  line?: number;
  column?: number;
}

export interface NotificationAdapter {
  notify(message: RunloomNotification): Promise<void> | void;
}

export interface RunloomNotification {
  level: "info" | "warning" | "error";
  message: string;
  runId?: string;
  sessionId?: string;
}

export interface SecretAdapter {
  getSecret(name: string): Promise<string | undefined>;
}

export interface RunloomHostAdapter {
  kind: "tui" | "vscode" | "web" | "daemon" | "ci" | "custom";
  workspace?: WorkspaceAdapter;
  terminal?: TerminalAdapter;
  diff?: DiffAdapter;
  approvals?: ApprovalBridge;
  diagnostics?: DiagnosticsAdapter;
  notifications?: NotificationAdapter;
  secrets?: SecretAdapter;
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
  mcpClient?: McpClientAdapter;
}

export interface RunloomAgent {
  submit(input: string | RunloomInput, options?: SubmitOptions): Promise<RunResult>;
  executeTool<TOutput = unknown>(name: string, input: unknown, options?: ExecuteToolOptions): Promise<ToolExecutionResult<TOutput>>;
  listTools(): Promise<ToolSummary[]>;
  listSkills(): Promise<RunloomSkillSummary[]>;
  registerSkill(skill: RunloomSkillSummary): Promise<void>;
  proposeSkill(input: CreateRunloomSkillProposalInput, options?: CreateRunloomSkillProposalOptions): Promise<RunloomSkillProposal>;
  listSkillProposals(options?: ListSkillProposalsOptions): Promise<RunloomSkillProposal[]>;
  approveSkillProposal(proposalId: string, decision?: ApprovalDecision): Promise<RunloomSkillProposal>;
  listMcpServers(): Promise<McpServerSummary[]>;
  registerMcpServer(server: McpServerSummary): Promise<void>;
  listA2APeers(): Promise<A2APeerSummary[]>;
  registerA2APeer(peer: A2APeerRegistration): Promise<void>;
  delegateA2APeer(peerId: string, request: A2ADelegationRequest): Promise<A2ADelegationResult>;
  listExternalAgents(): Promise<ExternalAgentSummary[]>;
  registerExternalAgent(adapter: ExternalAgentAdapter): Promise<void>;
  delegateExternalAgent(name: string, request: ExternalAgentDelegationRequest): Promise<ExternalAgentDelegationResult>;
  createMcpServer(options?: CreateRunloomMcpServerOptions): RunloomMcpServerAdapter;
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
  listReviewFindings(options?: ListReviewFindingsOptions): Promise<RunloomReviewFindings[]>;
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
