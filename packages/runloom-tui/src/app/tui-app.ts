import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import { APPROVAL_MODES, PERMISSION_SCOPES } from "runloom-agent";
import type {
  ApprovalMode,
  ApprovalPolicyConfig,
  ApprovalRequest,
  McpServerSummary,
  PermissionScope,
  RunloomAgent,
  RunloomEvent,
  RunloomSession,
  RunloomSkillProposal,
  RunloomSkillSummary,
  RunloomTodoItem,
  ToolSummary,
  ToolExecutionResult,
  Unsubscribe
} from "runloom-agent";

const MAX_VIEW_LINES = 200;

export interface CreateRunloomTuiAppOptions {
  agent: RunloomAgent;
  input?: Readable;
  output?: Writable;
}

export interface RunloomTuiApp {
  start(): Promise<void>;
  stop(): Promise<void>;
  runCommand(command: string): Promise<void>;
  submitPrompt(prompt: string): Promise<void>;
  render(event: RunloomEvent): void;
}

export function createRunloomTuiApp(options: CreateRunloomTuiAppOptions): RunloomTuiApp {
  return new BasicRunloomTuiApp(options);
}

interface TuiViewState {
  transcript: string[];
  activity: string[];
  todoItems: RunloomTodoItem[];
  runStatus: "idle" | string;
  latestModel?: {
    providerId?: string;
    model?: string;
    source?: string;
    reason?: string;
  };
}

class BasicRunloomTuiApp implements RunloomTuiApp {
  private unsubscribe?: Unsubscribe;
  private stopped = false;
  private activeModel?: string;
  private activeProfile?: string;
  private activeTaskType?: string;
  private activeLanguage?: string;
  private activeRunId?: string;
  private activeSessionId?: string;
  private assistantBuffer = "";
  private readonly viewState: TuiViewState = {
    transcript: [],
    activity: [],
    todoItems: [],
    runStatus: "idle"
  };

  constructor(private readonly options: CreateRunloomTuiAppOptions) {}

  async start(): Promise<void> {
    const input = this.options.input ?? defaultInput;
    const output = this.options.output ?? defaultOutput;
    const rl = createInterface({ input, output });

    this.unsubscribe = this.options.agent.subscribe((event) => this.render(event));
    output.write("Runloom Code\n");
    output.write("Type /help for commands. Type /quit to exit.\n\n");

    if (!isInteractiveInput(input)) {
      for await (const rawLine of rl) {
        await this.handleInputLine(String(rawLine));
        if (this.stopped) {
          break;
        }
      }
      rl.close();
      this.unsubscribe?.();
      return;
    }

    while (!this.stopped) {
      let answer: string;
      try {
        answer = await rl.question("runloom> ");
      } catch (error) {
        if (isReadlineClosedError(error)) {
          await this.stop();
          break;
        }
        throw error;
      }

      const line = answer.trim();
      await this.handleInputLine(line);
    }

    rl.close();
    this.unsubscribe?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    await this.options.agent.close();
  }

  async submitPrompt(prompt: string): Promise<void> {
    await this.options.agent.submit({
      text: prompt,
      model: this.activeModel,
      profile: this.activeProfile,
      taskType: this.activeTaskType,
      language: this.activeLanguage
    }, {
      sessionId: this.activeSessionId
    });
  }

  private async handleInputLine(rawLine: string): Promise<void> {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    if (line.startsWith("/")) {
      await this.runCommand(line);
      return;
    }
    await this.submitPrompt(line);
  }

  render(event: RunloomEvent): void {
    const output = this.options.output ?? defaultOutput;
    this.applyEventToViewState(event);

    switch (event.type) {
      case "run.started":
        output.write(`\n[run] started ${event.runId}\n`);
        break;
      case "coding.workspace.inspected":
        output.write("[coding] workspace inspected\n");
        break;
      case "coding.git.status":
        output.write(`[git] ${formatGitStatus(event.payload)}\n`);
        break;
      case "todo.updated":
        output.write(`[todo] ${formatTodo(event.payload)}\n`);
        break;
      case "response.output_text.delta":
        output.write(String((event.payload as { delta?: string }).delta ?? ""));
        break;
      case "response.completed":
        output.write("\n[model] completed\n");
        break;
      case "response.failed":
        output.write(`\n[model] failed: ${formatErrorPayload(event.payload)}\n`);
        break;
      case "model.selection.resolved":
        output.write(`[model] ${formatModelSelection(event.payload)}\n`);
        break;
      case "review.findings.created":
        output.write(formatReviewFindings(event.payload));
        break;
      case "approval.policy.updated":
        output.write(`[approval] policy updated\n${formatApprovalPolicy(event.payload as ApprovalPolicyConfig)}\n`);
        break;
      case "approval.requested":
        output.write(`[approval] requested ${formatApprovalRequest(event.payload)}\n`);
        break;
      case "approval.resolved":
        output.write(`[approval] resolved ${formatApprovalResolution(event.payload)}\n`);
        break;
      case "run.waiting_approval":
        output.write(`[run] waiting for approval ${formatWaitingApproval(event.payload)}\n\n`);
        break;
      case "run.cancel_requested":
        output.write(`[run] cancel requested ${event.runId}\n`);
        break;
      case "run.cancelled":
        output.write(`[run] cancelled ${event.runId}\n\n`);
        break;
      case "run.resumed":
        output.write(`[run] resumed ${event.runId}\n`);
        break;
      case "run.completed":
        output.write("[run] completed\n\n");
        break;
      case "run.failed":
        output.write(`[run] failed: ${formatErrorPayload(event.payload)}\n\n`);
        break;
      default:
        if (event.source !== "model") {
          output.write(`[${event.type}]\n`);
        }
        break;
    }
  }

  async runCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;

    if (command === "/quit" || command === "/exit") {
      await this.stop();
      return;
    }

    if (command === "/help") {
      output.write(
        [
          "Commands:",
          "  /help          Show this help",
          "  /status        Show status panel and approval policy",
          "  /view          Show status, todo, activity, and transcript panels",
          "  /transcript    Show recent transcript",
          "  /activity      Show recent activity",
          "  /replay        Rebuild panels from stored events",
          "  /permissions   Show approval policy",
          "  /approval      Show or update approval policy",
          "  /approval default <full_access|ask|auto_decide>",
          "  /approval <scope> <full_access|ask|auto_decide>",
          "  /approvals     List pending approvals",
          "  /approve <id>  Approve a pending approval",
          "  /deny <id>     Deny a pending approval",
          "  /model        Show or set model overrides",
          "  /model set <provider:model|model>",
          "  /model profile <name>",
          "  /model clear",
          "  /tools         List registered coding tools",
          "  /session       Show or switch sessions",
          "  /todo          Show current todo state",
          "  /diff          Show current git diff",
          "  /review        Enable code review mode",
          "  /stop          Stop the active run",
          "  /resume        Resume a previous run",
          "  /skills        List registered skills",
          "  /mcp           List MCP servers",
          "  /git           Show git status",
          "  /tests         Run verification command",
          "  /quit          Exit"
        ].join("\n") + "\n"
      );
      return;
    }

    if (command === "/status") {
      const policy = await this.options.agent.getApprovalPolicy();
      output.write(formatStatusView(this.viewState, {
        activeSessionId: this.activeSessionId,
        activeRunId: this.activeRunId,
        activeModel: this.activeModel,
        activeProfile: this.activeProfile,
        activeTaskType: this.activeTaskType,
        activeLanguage: this.activeLanguage
      }));
      output.write(formatApprovalPolicy(policy));
      return;
    }

    if (command === "/permissions") {
      const policy = await this.options.agent.getApprovalPolicy();
      output.write(formatApprovalPolicy(policy));
      return;
    }

    if (command === "/transcript") {
      output.write(formatTranscriptView(this.viewState.transcript));
      return;
    }

    if (command === "/activity") {
      output.write(formatActivityView(this.viewState.activity));
      return;
    }

    if (command === "/view") {
      output.write(formatCompositeView(this.viewState, {
        activeSessionId: this.activeSessionId,
        activeRunId: this.activeRunId,
        activeModel: this.activeModel,
        activeProfile: this.activeProfile,
        activeTaskType: this.activeTaskType,
        activeLanguage: this.activeLanguage
      }));
      return;
    }

    if (command === "/replay") {
      await this.handleReplayCommand();
      return;
    }

    if (command === "/tools") {
      const tools = await this.options.agent.listTools();
      output.write(formatTools(tools));
      return;
    }

    if (command === "/approvals") {
      const approvals = await this.options.agent.listApprovals();
      output.write(formatApprovals(approvals));
      return;
    }

    if (command.startsWith("/approve") || command.startsWith("/deny")) {
      await this.handleApprovalDecisionCommand(command);
      return;
    }

    if (command === "/session" || command.startsWith("/session ")) {
      await this.handleSessionCommand(command);
      return;
    }

    if (command === "/todo") {
      output.write(formatTodoView(this.viewState.todoItems));
      return;
    }

    if (command === "/diff") {
      await this.handleDiffCommand();
      return;
    }

    if (command === "/review" || command === "/review on" || command === "/review off") {
      this.handleReviewCommand(command);
      return;
    }

    if (command === "/stop") {
      await this.handleStopCommand();
      return;
    }

    if (command === "/resume" || command.startsWith("/resume ")) {
      await this.handleResumeCommand(command);
      return;
    }

    if (command === "/skills") {
      const skills = await this.options.agent.listSkills();
      const proposals = await this.options.agent.listSkillProposals();
      output.write(formatSkills(skills, proposals));
      return;
    }

    if (command === "/mcp") {
      const servers = await this.options.agent.listMcpServers();
      output.write(formatMcpServers(servers));
      return;
    }

    if (command === "/git") {
      await this.handleGitCommand();
      return;
    }

    if (command === "/tests" || command.startsWith("/tests ")) {
      await this.handleTestsCommand(command);
      return;
    }

    if (command.startsWith("/model")) {
      this.handleModelCommand(command);
      return;
    }

    if (command.startsWith("/approval")) {
      await this.handleApprovalCommand(command);
      return;
    }

    output.write(`Unknown command: ${command}\n`);
  }

  private async handleGitCommand(): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const result = await this.options.agent.executeTool("git.status", {}, { sessionId: this.activeSessionId });
    this.trackToolSession(result);
    if (result.status !== "completed") {
      output.write(formatToolExecutionState(result));
      return;
    }
    output.write(`[git] ${formatGitStatus(result.output)}\n`);
  }

  private async handleTestsCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const verification = parseVerificationCommand(command);
    const result = await this.options.agent.executeTool("shell.verify", verification, { sessionId: this.activeSessionId });
    this.trackToolSession(result);
    if (result.status !== "completed") {
      output.write(formatToolExecutionState(result));
      return;
    }
    output.write(formatVerificationResult(result.output));
  }

  private async handleDiffCommand(): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const result = await this.options.agent.executeTool("git.diff", {}, { sessionId: this.activeSessionId });
    this.trackToolSession(result);
    if (result.status !== "completed") {
      output.write(formatToolExecutionState(result));
      return;
    }
    output.write(formatDiffSummary(result.output));
  }

  private async handleSessionCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const [, action, sessionId] = command.split(/\s+/);

    if (!action) {
      if (!this.activeSessionId) {
        output.write("Session: (none yet)\n");
        return;
      }
      const session = await this.options.agent.getSession(this.activeSessionId);
      output.write(formatCurrentSession(session, this.activeRunId));
      return;
    }

    if (action === "list") {
      const sessions = await this.options.agent.listSessions();
      output.write(formatSessions(sessions, this.activeSessionId));
      return;
    }

    if (action === "switch") {
      if (!sessionId) {
        output.write("Missing session id for /session switch\n");
        return;
      }
      const session = await this.options.agent.getSession(sessionId);
      this.activeSessionId = session.id;
      this.activeRunId = undefined;
      this.viewState.todoItems = [];
      this.viewState.runStatus = "idle";
      output.write(`Session switched to ${session.id}\n`);
      return;
    }

    output.write(`Unknown /session action: ${action}\n`);
    output.write(formatSessionCommandHelp());
  }

  private handleReviewCommand(command: string): void {
    const output = this.options.output ?? defaultOutput;
    if (command === "/review off") {
      if (this.activeTaskType === "code_review") {
        this.activeTaskType = undefined;
      }
      output.write("Review mode disabled\n");
      return;
    }
    this.activeTaskType = "code_review";
    output.write("Review mode enabled\n");
  }

  private async handleStopCommand(): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    if (!this.activeRunId) {
      output.write("No active run to stop\n");
      return;
    }
    const runId = this.activeRunId;
    await this.options.agent.cancel(runId);
    output.write(`Stop requested for ${runId}\n`);
  }

  private async handleResumeCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const [, runIdArg] = command.split(/\s+/);
    const runId = runIdArg ?? this.activeRunId;
    if (!runId) {
      output.write("No run to resume\n");
      return;
    }
    try {
      const result = await this.options.agent.resume(runId);
      this.activeRunId = result.runId;
      this.activeSessionId = result.sessionId;
      output.write(`[resume] ${runId} -> ${result.runId} ${result.status}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.write(`Resume failed: ${message}\n`);
    }
  }

  private async handleReplayCommand(): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const events = await this.options.agent.listEvents({
      sessionId: this.activeSessionId,
      limit: MAX_VIEW_LINES
    });
    this.rebuildViewState(events);
    output.write(`[replay] loaded ${events.length} event(s)\n`);
    output.write(formatCompositeView(this.viewState, {
      activeSessionId: this.activeSessionId,
      activeRunId: this.activeRunId,
      activeModel: this.activeModel,
      activeProfile: this.activeProfile,
      activeTaskType: this.activeTaskType,
      activeLanguage: this.activeLanguage
    }));
  }

  private trackToolSession(result: ToolExecutionResult): void {
    this.activeRunId = result.runId;
    this.activeSessionId = result.sessionId;
  }

  private async handleApprovalCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const [, target, modeText] = command.split(/\s+/);

    if (!target) {
      const policy = await this.options.agent.getApprovalPolicy();
      output.write(formatApprovalPolicy(policy));
      output.write(formatApprovalCommandHelp());
      return;
    }

    const mode = parseApprovalMode(modeText);
    if (!mode) {
      output.write(`Invalid approval mode: ${modeText ?? "(missing)"}\n`);
      output.write(formatApprovalCommandHelp());
      return;
    }

    if (target === "default") {
      await this.options.agent.updateApprovalPolicy({ defaultMode: mode });
      output.write(`Approval default mode set to ${mode}\n`);
      return;
    }

    const scope = parsePermissionScope(target);
    if (!scope) {
      output.write(`Invalid permission scope: ${target}\n`);
      output.write(formatScopeList());
      return;
    }

    await this.options.agent.updateApprovalPolicy({
      scopes: {
        [scope]: mode
      }
    });
    output.write(`Approval mode for ${scope} set to ${mode}\n`);
  }

  private async handleApprovalDecisionCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const [action, approvalId] = command.split(/\s+/);
    if (!approvalId) {
      output.write(`Missing approval id for ${action}\n`);
      return;
    }
    const decision = action === "/approve" ? "approved" : "denied";
    try {
      await this.options.agent.resolveApproval(approvalId, { decision });
      output.write(`Approval ${approvalId} ${decision}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.write(`Approval decision failed: ${message}\n`);
    }
  }

  private handleModelCommand(command: string): void {
    const output = this.options.output ?? defaultOutput;
    const [, action, ...rest] = command.split(/\s+/);
    const value = rest.join(" ").trim();

    if (!action) {
      output.write(formatActiveModelState(this.activeModel, this.activeProfile, this.activeTaskType, this.activeLanguage));
      output.write(formatModelCommandHelp());
      return;
    }

    if (action === "clear") {
      this.activeModel = undefined;
      this.activeProfile = undefined;
      this.activeTaskType = undefined;
      this.activeLanguage = undefined;
      output.write("Model overrides cleared\n");
      return;
    }

    if (!value) {
      output.write(`Missing value for /model ${action}\n`);
      output.write(formatModelCommandHelp());
      return;
    }

    if (action === "set") {
      this.activeModel = value;
      this.activeProfile = undefined;
      output.write(`Model override set to ${value}\n`);
      return;
    }

    if (action === "profile") {
      this.activeProfile = value;
      this.activeModel = undefined;
      output.write(`Model profile set to ${value}\n`);
      return;
    }

    if (action === "task") {
      this.activeTaskType = value;
      output.write(`Model task type set to ${value}\n`);
      return;
    }

    if (action === "language") {
      this.activeLanguage = value;
      output.write(`Model language set to ${value}\n`);
      return;
    }

    output.write(`Unknown /model action: ${action}\n`);
    output.write(formatModelCommandHelp());
  }

  private applyEventToViewState(event: RunloomEvent): void {
    switch (event.type) {
      case "run.started": {
        this.activeRunId = event.runId;
        this.activeSessionId = event.sessionId;
        this.viewState.runStatus = "running";
        this.assistantBuffer = "";
        const input = (event.payload as { input?: string }).input;
        if (input) {
          this.recordTranscript(`user: ${truncateText(input)}`);
        }
        this.recordActivity(`run ${event.runId} started`);
        break;
      }
      case "model.selection.resolved": {
        const selection = event.payload as TuiViewState["latestModel"];
        this.viewState.latestModel = selection;
        this.recordActivity(`model ${formatModelSelection(event.payload)}`);
        break;
      }
      case "response.output_text.delta": {
        this.assistantBuffer += String((event.payload as { delta?: string }).delta ?? "");
        break;
      }
      case "response.completed": {
        this.flushAssistantTranscript();
        this.recordActivity("model completed");
        break;
      }
      case "response.failed": {
        this.flushAssistantTranscript();
        this.recordActivity(`model failed: ${formatErrorPayload(event.payload)}`);
        break;
      }
      case "run.waiting_approval":
        this.viewState.runStatus = "waiting_approval";
        this.recordActivity(`run waiting for approval ${formatWaitingApproval(event.payload)}`.trimEnd());
        break;
      case "run.completed":
        this.viewState.runStatus = "completed";
        this.recordActivity(`run ${event.runId} completed`);
        break;
      case "run.failed":
        this.viewState.runStatus = "failed";
        this.activeRunId = undefined;
        this.recordActivity(`run failed: ${formatErrorPayload(event.payload)}`);
        break;
      case "run.cancel_requested":
        this.recordActivity(`run ${event.runId} cancel requested`);
        break;
      case "run.cancelled":
        this.viewState.runStatus = "cancelled";
        if (event.runId === this.activeRunId) {
          this.activeRunId = undefined;
        }
        this.recordActivity(`run ${event.runId} cancelled`);
        break;
      case "run.resumed":
        this.activeRunId = event.runId;
        this.activeSessionId = event.sessionId;
        this.viewState.runStatus = "running";
        this.recordActivity(`run ${event.runId} resumed`);
        break;
      case "todo.updated":
        if (!this.activeSessionId || event.sessionId === this.activeSessionId) {
          this.viewState.todoItems = (event.payload as { items?: RunloomTodoItem[] }).items ?? [];
        }
        this.recordActivity(`todo ${formatTodo(event.payload)}`.trimEnd());
        break;
      case "coding.workspace.inspected":
        this.recordActivity("workspace inspected");
        break;
      case "coding.git.status":
        this.recordActivity(`git ${formatGitStatus(event.payload)}`);
        break;
      case "approval.requested":
        this.recordActivity(`approval requested ${formatApprovalRequest(event.payload)}`);
        break;
      case "approval.resolved":
        this.recordActivity(`approval resolved ${formatApprovalResolution(event.payload)}`);
        break;
      case "approval.policy.updated":
        this.recordActivity("approval policy updated");
        break;
      case "review.findings.created":
        this.recordActivity("review findings recorded");
        break;
      case "skill.activated":
        this.recordActivity(`skill activated ${formatSkillActivation(event.payload)}`);
        break;
      default:
        if (event.type.startsWith("tool.")) {
          this.recordActivity(formatToolActivityEvent(event));
        } else if (event.type.startsWith("mcp.")) {
          this.recordActivity(event.type);
        }
        break;
    }
  }

  private rebuildViewState(events: RunloomEvent[]): void {
    this.viewState.transcript = [];
    this.viewState.activity = [];
    this.viewState.todoItems = [];
    this.viewState.runStatus = "idle";
    this.viewState.latestModel = undefined;
    this.activeRunId = undefined;
    this.assistantBuffer = "";
    for (const event of events) {
      this.applyEventToViewState(event);
    }
    this.flushAssistantTranscript();
  }

  private flushAssistantTranscript(): void {
    if (!this.assistantBuffer.trim()) {
      this.assistantBuffer = "";
      return;
    }
    this.recordTranscript(`assistant: ${truncateText(this.assistantBuffer)}`);
    this.assistantBuffer = "";
  }

  private recordTranscript(line: string): void {
    pushCapped(this.viewState.transcript, line);
  }

  private recordActivity(line: string): void {
    if (!line.trim()) {
      return;
    }
    pushCapped(this.viewState.activity, line);
  }
}

function formatGitStatus(payload: unknown): string {
  const status = payload as { isRepository?: boolean; branch?: string; isDirty?: boolean; changedFiles?: string[] };
  if (!status.isRepository) {
    return "not a git repository";
  }
  const dirty = status.isDirty ? "dirty" : "clean";
  const files = status.changedFiles?.length ? `, changed: ${status.changedFiles.join(", ")}` : "";
  return `${status.branch ?? "unknown branch"} (${dirty})${files}`;
}

function formatTodo(payload: unknown): string {
  const items = (payload as { items?: Array<{ title: string; status: string }> }).items ?? [];
  return items.map((item) => `${item.status}: ${item.title}`).join("; ");
}

function formatTodoView(items: RunloomTodoItem[]): string {
  if (items.length === 0) {
    return "Todo: (none)\n";
  }
  const lines = ["Todo:"];
  for (const item of items) {
    const evidence = item.evidence?.length ? ` evidence=${item.evidence.join(",")}` : "";
    lines.push(`  ${item.status} ${item.title}${evidence}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatStatusView(
  state: TuiViewState,
  context: {
    activeSessionId?: string;
    activeRunId?: string;
    activeModel?: string;
    activeProfile?: string;
    activeTaskType?: string;
    activeLanguage?: string;
  }
): string {
  const latestActivity = state.activity.at(-1) ?? "(none)";
  return [
    "Status:",
    `  session: ${context.activeSessionId ?? "(none)"}`,
    `  run: ${context.activeRunId ?? "(none)"} status=${state.runStatus}`,
    `  model: ${formatStatusModel(state, context)}`,
    `  taskType: ${context.activeTaskType ?? "(auto)"}`,
    `  language: ${context.activeLanguage ?? "(auto)"}`,
    `  todo: ${formatTodoCounts(state.todoItems)}`,
    `  latest activity: ${latestActivity}`
  ].join("\n") + "\n";
}

function formatCompositeView(
  state: TuiViewState,
  context: {
    activeSessionId?: string;
    activeRunId?: string;
    activeModel?: string;
    activeProfile?: string;
    activeTaskType?: string;
    activeLanguage?: string;
  }
): string {
  return [
    formatStatusView(state, context).trimEnd(),
    formatTodoView(state.todoItems).trimEnd(),
    formatActivityView(state.activity, 8).trimEnd(),
    formatTranscriptView(state.transcript, 8).trimEnd()
  ].join("\n") + "\n";
}

function formatTranscriptView(lines: string[], limit = 20): string {
  if (lines.length === 0) {
    return "Transcript: (empty)\n";
  }
  return `Transcript:\n${lines.slice(-limit).map((line) => `  ${line}`).join("\n")}\n`;
}

function formatActivityView(lines: string[], limit = 20): string {
  if (lines.length === 0) {
    return "Activity: (none)\n";
  }
  return `Activity:\n${lines.slice(-limit).map((line) => `  ${line}`).join("\n")}\n`;
}

function formatStatusModel(
  state: TuiViewState,
  context: {
    activeModel?: string;
    activeProfile?: string;
  }
): string {
  if (context.activeModel) {
    return `${context.activeModel} override`;
  }
  if (context.activeProfile) {
    return `profile:${context.activeProfile}`;
  }
  if (state.latestModel?.providerId || state.latestModel?.model) {
    return `${state.latestModel.providerId ?? "unknown"}:${state.latestModel.model ?? "unknown"}`;
  }
  return "(auto)";
}

function formatTodoCounts(items: RunloomTodoItem[]): string {
  if (items.length === 0) {
    return "none";
  }

  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ");
}

function formatErrorPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error: unknown }).error);
  }
  if (payload && typeof payload === "object" && "message" in payload) {
    return String((payload as { message: unknown }).message);
  }
  return JSON.stringify(payload);
}

function isReadlineClosedError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ERR_USE_AFTER_CLOSE");
}

function isInteractiveInput(input: Readable): boolean {
  return Boolean((input as { isTTY?: boolean }).isTTY);
}

function formatApprovalRequest(payload: unknown): string {
  const request = payload as { id?: string; scope?: string; mode?: string; summary?: string };
  return `${request.id ?? "unknown"} scope=${request.scope ?? "unknown"} mode=${request.mode ?? "unknown"} ${request.summary ?? ""}`;
}

function formatApprovalResolution(payload: unknown): string {
  const resolution = payload as { approvalId?: string; decision?: { decision?: string } };
  return `${resolution.approvalId ?? "unknown"} decision=${resolution.decision?.decision ?? "unknown"}`;
}

function formatWaitingApproval(payload: unknown): string {
  const waiting = payload as { approvalId?: string };
  return waiting.approvalId ? `approval=${waiting.approvalId}` : "";
}

function formatSkillActivation(payload: unknown): string {
  const activation = payload as { skillName?: string; reason?: string };
  const reason = activation.reason ? ` reason=${activation.reason}` : "";
  return `${activation.skillName ?? "unknown"}${reason}`;
}

function formatToolActivityEvent(event: RunloomEvent): string {
  const payload = event.payload as {
    toolName?: string;
    name?: string;
    status?: string;
    approvalId?: string;
    error?: string;
  };
  const toolName = payload.toolName ?? payload.name;
  const status = payload.status ? ` status=${payload.status}` : "";
  const approval = payload.approvalId ? ` approval=${payload.approvalId}` : "";
  const error = payload.error ? ` error=${payload.error}` : "";
  return `${event.type}${toolName ? ` ${toolName}` : ""}${status}${approval}${error}`;
}

function formatModelSelection(payload: unknown): string {
  const selection = payload as { providerId?: string; model?: string; reason?: string; source?: string };
  const model = `${selection.providerId ?? "unknown"}:${selection.model ?? "unknown"}`;
  const source = selection.source ? ` source=${selection.source}` : "";
  const reason = selection.reason ? ` reason=${selection.reason}` : "";
  return `${model}${source}${reason}`;
}

function formatApprovalPolicy(policy: ApprovalPolicyConfig): string {
  const lines = [`Approval policy: default=${policy.defaultMode}`];
  for (const [scope, mode] of Object.entries(policy.scopes)) {
    lines.push(`  ${scope}: ${mode}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatTools(tools: ToolSummary[]): string {
  if (tools.length === 0) {
    return "No tools registered.\n";
  }
  const lines = ["Tools:"];
  for (const tool of tools) {
    const permissions = tool.permissions.length ? tool.permissions.join(", ") : "none";
    lines.push(`  ${tool.name} - ${tool.description} [${permissions}]`);
  }
  return `${lines.join("\n")}\n`;
}

function formatApprovals(approvals: ApprovalRequest[]): string {
  if (approvals.length === 0) {
    return "Approvals: (none pending)\n";
  }
  const lines = ["Approvals:"];
  for (const approval of approvals) {
    lines.push(
      `  ${approval.id} run=${approval.runId} scope=${approval.scope} risk=${approval.risk} mode=${approval.mode} ${approval.summary}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatSkills(skills: RunloomSkillSummary[], proposals: RunloomSkillProposal[] = []): string {
  if (skills.length === 0 && proposals.length === 0) {
    return "Skills: (none registered)\n";
  }
  const lines = ["Skills:"];
  for (const skill of skills) {
    const state = skill.enabled ? "enabled" : "disabled";
    const version = skill.version ? `@${skill.version}` : "";
    const requiredTools = skill.requiredTools?.length ? ` tools=${skill.requiredTools.join(",")}` : "";
    const permissions = formatSkillPermissions(skill.permissions);
    const diagnostics = skill.diagnostics?.length ? ` diagnostics=${skill.diagnostics.join("; ")}` : "";
    lines.push(
      `  ${skill.name}${version} ${state} source=${skill.source}${requiredTools}${permissions}${diagnostics} - ${skill.description}`
    );
  }
  if (proposals.length > 0) {
    lines.push("Skill proposals:");
    for (const proposal of proposals) {
      const approval = proposal.approvalId ? ` approval=${proposal.approvalId}` : "";
      const diagnostics = proposal.diagnostics?.length ? ` diagnostics=${proposal.diagnostics.join("; ")}` : "";
      lines.push(
        `  ${proposal.id} ${proposal.status} ${proposal.changeType} skill=${proposal.skillName} risk=${proposal.risk.level}${approval}${diagnostics}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatSkillPermissions(permissions: RunloomSkillSummary["permissions"]): string {
  if (!permissions) {
    return "";
  }
  const entries: string[] = [];
  if (permissions.readWorkspace !== undefined) {
    entries.push(`readWorkspace:${permissions.readWorkspace}`);
  }
  if (permissions.writeWorkspace !== undefined) {
    entries.push(`writeWorkspace:${permissions.writeWorkspace}`);
  }
  if (permissions.shell !== undefined) {
    entries.push(`shell:${permissions.shell}`);
  }
  return entries.length ? ` permissions=${entries.join(",")}` : "";
}

function formatMcpServers(servers: McpServerSummary[]): string {
  if (servers.length === 0) {
    return "MCP servers: (none registered)\n";
  }
  const lines = ["MCP servers:"];
  for (const server of servers) {
    const state = server.enabled ? "enabled" : "disabled";
    const tools = server.tools?.length ? ` tools=${server.tools.join(",")}` : "";
    const inventory = `resources=${server.resources ?? 0} prompts=${server.prompts ?? 0}`;
    const permissions = server.permissions
      ? ` permissions=tools:${server.permissions.tools},resources:${server.permissions.resources},prompts:${server.permissions.prompts}`
      : "";
    const error = server.error ? ` error=${server.error}` : "";
    lines.push(`  ${server.name} ${state} transport=${server.transport} status=${server.status}${tools} ${inventory}${permissions}${error}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatCurrentSession(session: RunloomSession, activeRunId?: string): string {
  return [
    `Session: ${session.id}`,
    `  workspace: ${session.workspace}`,
    `  createdAt: ${session.createdAt}`,
    `  updatedAt: ${session.updatedAt}`,
    `  activeRun: ${activeRunId ?? "(none)"}`
  ].join("\n") + "\n";
}

function formatSessions(sessions: RunloomSession[], activeSessionId?: string): string {
  if (sessions.length === 0) {
    return "Sessions: (none)\n";
  }
  const lines = ["Sessions:"];
  for (const session of sessions) {
    const marker = session.id === activeSessionId ? "*" : " ";
    lines.push(`${marker} ${session.id} updated=${session.updatedAt} workspace=${session.workspace}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatSessionCommandHelp(): string {
  return [
    "Usage:",
    "  /session",
    "  /session list",
    "  /session switch <session-id>"
  ].join("\n") + "\n";
}

function formatToolExecutionState(result: { toolName: string; status: string; error?: string; approvalId?: string }): string {
  if (result.status === "waiting_approval") {
    return `[tool] ${result.toolName} waiting for approval ${result.approvalId ?? ""}\n`;
  }
  return `[tool] ${result.toolName} ${result.status}${result.error ? `: ${result.error}` : ""}\n`;
}

function formatVerificationResult(payload: unknown): string {
  const result = payload as { command?: string; exitCode?: number; durationMs?: number; stdout?: string; stderr?: string };
  const lines = [
    `[tests] ${result.command ?? "verification"} exit=${result.exitCode ?? "unknown"} duration=${result.durationMs ?? 0}ms`
  ];
  if (result.stdout?.trim()) {
    lines.push(result.stdout.trim());
  }
  if (result.stderr?.trim()) {
    lines.push(result.stderr.trim());
  }
  return `${lines.join("\n")}\n`;
}

function formatDiffSummary(payload: unknown): string {
  const diff = payload as { filesChanged?: string[]; additions?: number; deletions?: number; patch?: string };
  const files = diff.filesChanged ?? [];
  if (files.length === 0 && !diff.patch?.trim()) {
    return "Diff: no tracked changes\n";
  }
  const lines = [`Diff: ${files.length} file(s), +${diff.additions ?? 0}/-${diff.deletions ?? 0}`];
  if (files.length) {
    lines.push(`Files: ${files.join(", ")}`);
  }
  if (diff.patch?.trim()) {
    lines.push(diff.patch.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

function formatReviewFindings(payload: unknown): string {
  const review = payload as {
    findings?: Array<{
      severity?: string;
      title?: string;
      category?: string;
      location?: { path?: string; line?: number };
      recommendation?: string;
    }>;
    reviewedFiles?: string[];
    summary?: string;
  };
  const findings = review.findings ?? [];
  const lines = [`[review] ${findings.length} finding(s)`];
  if (review.reviewedFiles?.length) {
    lines.push(`Files: ${review.reviewedFiles.join(", ")}`);
  }
  if (review.summary) {
    lines.push(`Summary: ${review.summary}`);
  }
  if (findings.length === 0) {
    lines.push("No findings recorded.");
    return `${lines.join("\n")}\n`;
  }
  for (const finding of findings) {
    const location = finding.location?.path
      ? ` ${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ""}`
      : "";
    const category = finding.category ? ` ${finding.category}` : "";
    lines.push(`  ${finding.severity ?? "unknown"}${category}${location} - ${finding.title ?? "(untitled)"}`);
    if (finding.recommendation) {
      lines.push(`    recommendation: ${finding.recommendation}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseVerificationCommand(command: string): { command: string; args: string[] } {
  const parts = command.split(/\s+/).slice(1).filter(Boolean);
  if (parts.length === 0) {
    return {
      command: "pnpm",
      args: ["test"]
    };
  }
  return {
    command: parts[0] ?? "pnpm",
    args: parts.slice(1)
  };
}

function formatActiveModelState(model?: string, profile?: string, taskType?: string, language?: string): string {
  return [
    "Model overrides:",
    `  model: ${model ?? "(auto)"}`,
    `  profile: ${profile ?? "(auto)"}`,
    `  taskType: ${taskType ?? "(auto)"}`,
    `  language: ${language ?? "(auto)"}`
  ].join("\n") + "\n";
}

function formatModelCommandHelp(): string {
  return [
    "Usage:",
    "  /model",
    "  /model set <provider:model|model>",
    "  /model profile <name>",
    "  /model task <taskType>",
    "  /model language <language>",
    "  /model clear"
  ].join("\n") + "\n";
}

function parseApprovalMode(value: string | undefined): ApprovalMode | undefined {
  return APPROVAL_MODES.includes(value as ApprovalMode) ? (value as ApprovalMode) : undefined;
}

function parsePermissionScope(value: string): PermissionScope | undefined {
  return PERMISSION_SCOPES.includes(value as PermissionScope) ? (value as PermissionScope) : undefined;
}

function formatApprovalCommandHelp(): string {
  return [
    "Usage:",
    "  /approval",
    "  /approval default <full_access|ask|auto_decide>",
    "  /approval <scope> <full_access|ask|auto_decide>",
    formatScopeList().trimEnd()
  ].join("\n") + "\n";
}

function formatScopeList(): string {
  return `Scopes: ${PERMISSION_SCOPES.join(", ")}\n`;
}

function pushCapped(lines: string[], line: string): void {
  lines.push(line);
  if (lines.length > MAX_VIEW_LINES) {
    lines.splice(0, lines.length - MAX_VIEW_LINES);
  }
}

function truncateText(value: string, maxLength = 300): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}
