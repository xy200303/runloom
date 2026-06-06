import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import { APPROVAL_MODES, PERMISSION_SCOPES } from "runloom-agent";
import type {
  ApprovalDecision,
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
const DEFAULT_PANEL_LINES = 20;
const COMPOSITE_PANEL_LINES = 8;

type TuiPanel = "status" | "transcript" | "todo" | "activity";
type ScrollAction = "up" | "down" | "top" | "bottom";
type TuiShortcut = "ctrl+l" | "pgup" | "pgdn" | "alt+1" | "alt+2" | "alt+3" | "n" | "p" | "v" | "a" | "s" | "d";
type ApprovalShortcut = Extract<TuiShortcut, "n" | "p" | "v" | "a" | "s" | "d">;
type ActivityCategory = "runs" | "models" | "todos" | "coding" | "tools" | "approvals" | "reviews" | "skills" | "mcp";

interface TuiViewContext {
  activeSessionId?: string;
  activeRunId?: string;
  activeModel?: string;
  activeProfile?: string;
  activeTaskType?: string;
  activeLanguage?: string;
}

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
  activityRecords: TuiActivityRecord[];
  todoItems: RunloomTodoItem[];
  runStatus: "idle" | string;
  focus: TuiPanel;
  transcriptScrollOffset: number;
  activityScrollOffset: number;
  todoScrollOffset: number;
  latestModel?: {
    providerId?: string;
    model?: string;
    source?: string;
    reason?: string;
  };
}

interface TuiActivityRecord {
  category: ActivityCategory;
  line: string;
  eventType?: string;
  runId?: string;
  sessionId?: string;
  source?: string;
  timestamp?: string;
  payload?: unknown;
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
  private focusedApprovalId?: string;
  private assistantBuffer = "";
  private readonly viewState: TuiViewState = {
    transcript: [],
    activity: [],
    activityRecords: [],
    todoItems: [],
    runStatus: "idle",
    focus: "transcript",
    transcriptScrollOffset: 0,
    activityScrollOffset: 0,
    todoScrollOffset: 0
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
          "  /activity      Show recent activity, optionally filtered",
          "  /focus <panel> Focus status, transcript, todo, or activity",
          "  /scroll <dir>  Scroll focused panel up, down, top, or bottom",
          "  /clear        Clear the current view without deleting the session",
          "  /key <key>    Dispatch a keyboard shortcut",
          "  /replay        Rebuild panels from stored events",
          "  /permissions   Show or update approval policy panel",
          "  /permissions set <scope|default> <mode>",
          "  /approval      Show or update approval policy",
          "  /approval default <full_access|ask|auto_decide>",
          "  /approval <scope> <full_access|ask|auto_decide>",
          "  /approvals     List pending approvals",
          "  /approvals next|prev|view [id]",
          "  /approve <id> [once|session|workspace|global] [mode=<mode>]",
          "  /deny <id> [reason]",
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

    if (command === "/permissions" || command.startsWith("/permissions ")) {
      await this.handlePermissionsCommand(command);
      return;
    }

    if (command === "/transcript" || command.startsWith("/transcript ")) {
      await this.handlePanelCommand("transcript", command);
      return;
    }

    if (command === "/activity" || command.startsWith("/activity ")) {
      this.handleActivityCommand(command);
      return;
    }

    if (command === "/focus" || command.startsWith("/focus ")) {
      this.handleFocusCommand(command);
      return;
    }

    if (command === "/scroll" || command.startsWith("/scroll ")) {
      this.handleScrollCommand(command);
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

    if (command === "/clear") {
      this.clearViewState({ preserveActiveRun: true, preserveLatestModel: true });
      output.write("View cleared\n");
      return;
    }

    if (command === "/key" || command.startsWith("/key ")) {
      await this.handleShortcutCommand(command);
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

    if (command === "/approvals" || command.startsWith("/approvals ")) {
      await this.handleApprovalsCommand(command);
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

    if (command === "/todo" || command.startsWith("/todo ")) {
      await this.handlePanelCommand("todo", command);
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
      this.recordToolCommandActivity(result, formatToolExecutionState(result).trim(), "tools");
      output.write(formatToolExecutionState(result));
      return;
    }
    this.recordToolCommandActivity(result, `git ${formatGitStatus(result.output)}`, "coding");
    output.write(`[git] ${formatGitStatus(result.output)}\n`);
  }

  private async handleTestsCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const verification = parseVerificationCommand(command);
    const result = await this.options.agent.executeTool("shell.verify", verification, { sessionId: this.activeSessionId });
    this.trackToolSession(result);
    if (result.status !== "completed") {
      this.recordToolCommandActivity(result, formatToolExecutionState(result).trim(), "tools");
      output.write(formatToolExecutionState(result));
      return;
    }
    this.recordToolCommandActivity(result, `tests ${formatVerificationActivity(result.output)}`, "coding");
    output.write(formatVerificationResult(result.output));
  }

  private async handleDiffCommand(): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const result = await this.options.agent.executeTool("git.diff", {}, { sessionId: this.activeSessionId });
    this.trackToolSession(result);
    if (result.status !== "completed") {
      this.recordToolCommandActivity(result, formatToolExecutionState(result).trim(), "tools");
      output.write(formatToolExecutionState(result));
      return;
    }
    this.recordToolCommandActivity(result, `diff ${formatDiffActivity(result.output)}`, "coding");
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
      const events = await this.rebuildFromStoredEvents(session.id);
      output.write(`Session switched to ${session.id}\n`);
      output.write(`[replay] loaded ${events.length} event(s)\n`);
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
    const events = await this.rebuildFromStoredEvents(this.activeSessionId);
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

  private async handlePanelCommand(panel: TuiPanel, command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const [, action, amountText] = command.split(/\s+/);
    if (action && isScrollAction(action)) {
      this.viewState.focus = panel;
      this.scrollPanel(panel, action, parseScrollAmount(amountText));
    }
    output.write(this.formatPanel(panel));
  }

  private handleActivityCommand(command: string): void {
    const output = this.options.output ?? defaultOutput;
    const [, first, second, third] = command.split(/\s+/);
    let category: ActivityCategory | undefined;
    let actionText = first;
    let amountText = second;

    const firstToken = first?.toLowerCase();
    if (firstToken === "view") {
      output.write(this.formatActivityDetailCommand(second, third));
      return;
    }

    if (firstToken && isScrollAction(firstToken)) {
      actionText = firstToken;
    } else if (firstToken) {
      if (firstToken === "all") {
        actionText = second?.toLowerCase();
        amountText = third;
      } else {
        category = parseActivityCategory(firstToken);
        if (!category) {
          output.write(`Invalid activity filter: ${first}\n`);
          output.write(formatActivityCommandHelp());
          return;
        }
        actionText = second?.toLowerCase();
        amountText = third;
      }
    }

    if (actionText === "view") {
      output.write(this.formatActivityDetailCommand(category, amountText));
      return;
    }

    if (actionText && isScrollAction(actionText)) {
      this.viewState.focus = "activity";
      this.scrollActivity(category, actionText, parseScrollAmount(amountText));
    } else if (actionText) {
      output.write(`Invalid activity action: ${actionText}\n`);
      output.write(formatActivityCommandHelp());
      return;
    }

    output.write(this.formatActivity(category));
  }

  private handleFocusCommand(command: string): void {
    const output = this.options.output ?? defaultOutput;
    const [, panelText] = command.split(/\s+/);
    if (!panelText) {
      output.write(`Focus: ${this.viewState.focus}\n`);
      output.write(formatFocusCommandHelp());
      return;
    }

    const panel = parsePanel(panelText);
    if (!panel) {
      output.write(`Invalid panel: ${panelText}\n`);
      output.write(formatFocusCommandHelp());
      return;
    }

    this.viewState.focus = panel;
    output.write(`Focus set to ${panel}\n`);
    output.write(this.formatPanel(panel));
  }

  private handleScrollCommand(command: string): void {
    const output = this.options.output ?? defaultOutput;
    const [, actionText, amountText] = command.split(/\s+/);
    const action = actionText ?? "down";
    if (!isScrollAction(action)) {
      output.write(`Invalid scroll direction: ${action}\n`);
      output.write(formatScrollCommandHelp());
      return;
    }

    this.scrollPanel(this.viewState.focus, action, parseScrollAmount(amountText));
    output.write(this.formatPanel(this.viewState.focus));
  }

  private async handleShortcutCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const [, shortcutText, ...shortcutArgs] = command.split(/\s+/);
    const shortcut = normalizeShortcut(shortcutText ?? "");

    if (!shortcut) {
      output.write("Invalid keyboard shortcut\n");
      output.write(formatShortcutCommandHelp());
      return;
    }

    if (shortcut === "ctrl+l") {
      this.clearViewState({ preserveActiveRun: true, preserveLatestModel: true });
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      output.write("View cleared\n");
      return;
    }

    if (shortcut === "pgup" || shortcut === "pgdn") {
      this.scrollPanel("transcript", shortcut === "pgup" ? "up" : "down", DEFAULT_PANEL_LINES);
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      output.write(formatTranscriptView(this.viewState.transcript, DEFAULT_PANEL_LINES, this.viewState.transcriptScrollOffset));
      return;
    }

    if (isApprovalShortcut(shortcut)) {
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      await this.handleApprovalShortcut(shortcut, shortcutArgs);
      return;
    }

    const panel = panelForShortcut(shortcut);
    if (!panel) {
      output.write("Invalid keyboard shortcut\n");
      output.write(formatShortcutCommandHelp());
      return;
    }
    this.viewState.focus = panel;
    output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
    output.write(`Focus set to ${panel}\n`);
    output.write(this.formatPanel(panel));
  }

  private async handleApprovalShortcut(shortcut: ApprovalShortcut, args: string[]): Promise<void> {
    if (shortcut === "n") {
      await this.handleApprovalsCommand("/approvals next");
      return;
    }
    if (shortcut === "p") {
      await this.handleApprovalsCommand("/approvals prev");
      return;
    }
    if (shortcut === "v") {
      await this.handleApprovalsCommand("/approvals view selected");
      return;
    }
    if (shortcut === "a") {
      await this.handleApprovalDecisionCommand("/approve selected once");
      return;
    }
    if (shortcut === "s") {
      await this.handleApprovalDecisionCommand("/approve selected session");
      return;
    }
    await this.handleApprovalDecisionCommand(`/deny selected ${args.join(" ")}`.trimEnd());
  }

  private scrollPanel(panel: TuiPanel, action: ScrollAction, amount: number): void {
    const maxOffset = this.maxScrollOffset(panel);
    const current = this.getScrollOffset(panel);
    let next: number;

    if (action === "up") {
      next = current + amount;
    } else if (action === "down") {
      next = current - amount;
    } else if (action === "top") {
      next = maxOffset;
    } else {
      next = 0;
    }

    this.setScrollOffset(panel, clamp(next, 0, maxOffset));
  }

  private scrollActivity(category: ActivityCategory | undefined, action: ScrollAction, amount: number): void {
    const maxOffset = Math.max(0, this.activityLines(category).length - DEFAULT_PANEL_LINES);
    const current = this.viewState.activityScrollOffset;
    let next: number;

    if (action === "up") {
      next = current + amount;
    } else if (action === "down") {
      next = current - amount;
    } else if (action === "top") {
      next = maxOffset;
    } else {
      next = 0;
    }

    this.viewState.activityScrollOffset = clamp(next, 0, maxOffset);
  }

  private maxScrollOffset(panel: TuiPanel): number {
    if (panel === "transcript") {
      return Math.max(0, this.viewState.transcript.length - DEFAULT_PANEL_LINES);
    }
    if (panel === "activity") {
      return Math.max(0, this.viewState.activity.length - DEFAULT_PANEL_LINES);
    }
    if (panel === "todo") {
      return Math.max(0, this.viewState.todoItems.length - DEFAULT_PANEL_LINES);
    }
    return 0;
  }

  private getScrollOffset(panel: TuiPanel): number {
    if (panel === "transcript") {
      return this.viewState.transcriptScrollOffset;
    }
    if (panel === "activity") {
      return this.viewState.activityScrollOffset;
    }
    if (panel === "todo") {
      return this.viewState.todoScrollOffset;
    }
    return 0;
  }

  private setScrollOffset(panel: TuiPanel, offset: number): void {
    if (panel === "transcript") {
      this.viewState.transcriptScrollOffset = offset;
    } else if (panel === "activity") {
      this.viewState.activityScrollOffset = offset;
    } else if (panel === "todo") {
      this.viewState.todoScrollOffset = offset;
    }
  }

  private resetScrollOffsets(): void {
    this.viewState.transcriptScrollOffset = 0;
    this.viewState.activityScrollOffset = 0;
    this.viewState.todoScrollOffset = 0;
  }

  private formatPanel(panel: TuiPanel): string {
    if (panel === "status") {
      return formatStatusView(this.viewState, this.viewContext());
    }
    if (panel === "todo") {
      return formatTodoView(this.viewState.todoItems, DEFAULT_PANEL_LINES, this.viewState.todoScrollOffset);
    }
    if (panel === "activity") {
      return this.formatActivity();
    }
    return formatTranscriptView(this.viewState.transcript, DEFAULT_PANEL_LINES, this.viewState.transcriptScrollOffset);
  }

  private formatActivity(category?: ActivityCategory): string {
    const lines = this.activityLines(category);
    const scrollOffset = clamp(this.viewState.activityScrollOffset, 0, Math.max(0, lines.length - DEFAULT_PANEL_LINES));
    return formatActivityView(
      lines,
      DEFAULT_PANEL_LINES,
      scrollOffset,
      category
    );
  }

  private activityLines(category?: ActivityCategory): string[] {
    return this.activityRecords(category).map((record) => record.line);
  }

  private activityRecords(category?: ActivityCategory): TuiActivityRecord[] {
    if (!category) {
      return this.viewState.activityRecords;
    }
    return this.viewState.activityRecords.filter((record) => record.category === category);
  }

  private formatActivityDetailCommand(categoryOrTarget?: ActivityCategory | string, targetText?: string): string {
    let category: ActivityCategory | undefined;
    let target = targetText;

    if (typeof categoryOrTarget === "string") {
      const token = categoryOrTarget.toLowerCase();
      if (token === "all") {
        target = targetText;
      } else {
        const parsedCategory = parseActivityCategory(token);
        if (parsedCategory) {
          category = parsedCategory;
          target = targetText;
        } else {
          target = categoryOrTarget;
        }
      }
    } else {
      category = categoryOrTarget;
    }

    return formatActivityDetail(
      this.activityRecords(category),
      this.viewState.activityRecords,
      category,
      target
    );
  }

  private viewContext(): TuiViewContext {
    return {
      activeSessionId: this.activeSessionId,
      activeRunId: this.activeRunId,
      activeModel: this.activeModel,
      activeProfile: this.activeProfile,
      activeTaskType: this.activeTaskType,
      activeLanguage: this.activeLanguage
    };
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
      output.write(formatApprovalPolicyPanel(policy));
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

  private async handlePermissionsCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const [, action, target, modeText] = command.split(/\s+/);

    if (!action) {
      const policy = await this.options.agent.getApprovalPolicy();
      output.write(formatApprovalPolicyPanel(policy));
      output.write(formatPermissionsCommandHelp());
      return;
    }

    if (action !== "set") {
      output.write(`Unknown /permissions action: ${action}\n`);
      output.write(formatPermissionsCommandHelp());
      return;
    }

    const mode = parseApprovalMode(modeText);
    if (!mode) {
      output.write(`Invalid approval mode: ${modeText ?? "(missing)"}\n`);
      output.write(formatPermissionsCommandHelp());
      return;
    }

    if (target === "default") {
      await this.options.agent.updateApprovalPolicy({ defaultMode: mode });
      output.write(`Approval default mode set to ${mode}\n`);
      return;
    }

    if (!target) {
      output.write("Missing permission scope for /permissions set\n");
      output.write(formatPermissionsCommandHelp());
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

  private async handleApprovalsCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const [, action, approvalId] = command.split(/\s+/);
    const approvals = await this.options.agent.listApprovals();

    if (!action) {
      const focusedApprovalId = this.syncFocusedApproval(approvals);
      output.write(formatApprovals(approvals, focusedApprovalId));
      return;
    }

    if (action === "next" || action === "prev") {
      const focusedApprovalId = this.moveFocusedApproval(approvals, action === "next" ? 1 : -1);
      if (!focusedApprovalId) {
        output.write("Approvals: (none pending)\n");
        return;
      }
      output.write(`Approval focus set to ${focusedApprovalId}\n`);
      output.write(formatApprovals(approvals, focusedApprovalId));
      return;
    }

    if (action !== "view" && action !== "focus") {
      output.write(`Unknown /approvals action: ${action}\n`);
      output.write(formatApprovalsCommandHelp());
      return;
    }

    const targetApprovalId = approvalId
      ? this.resolveApprovalTargetId(approvalId, approvals)
      : this.syncFocusedApproval(approvals);
    if (!targetApprovalId) {
      output.write("No approval selected\n");
      return;
    }

    const approval = approvals.find((item) => item.id === targetApprovalId);
    if (!approval) {
      output.write(`Approval not found: ${targetApprovalId}\n`);
      return;
    }

    this.focusedApprovalId = approval.id;
    if (action === "focus") {
      output.write(`Approval focus set to ${approval.id}\n`);
    }
    output.write(formatApprovalDetail(approval));
  }

  private async handleApprovalDecisionCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;
    const [action, approvalTarget, ...rest] = command.split(/\s+/);
    if (!approvalTarget) {
      output.write(`Missing approval id for ${action}\n`);
      return;
    }
    const approvals = await this.options.agent.listApprovals();
    const approvalId = this.resolveApprovalTargetId(approvalTarget, approvals);
    if (!approvalId) {
      output.write("No approval selected\n");
      return;
    }
    const parsedDecision = parseApprovalDecisionCommand(action, rest);
    if ("error" in parsedDecision) {
      output.write(`${parsedDecision.error}\n`);
      output.write(formatApprovalDecisionCommandHelp());
      return;
    }

    try {
      await this.options.agent.resolveApproval(approvalId, parsedDecision.decision);
      output.write(`Approval ${approvalId} ${formatApprovalDecision(parsedDecision.decision)}\n`);
      const remainingApprovals = await this.options.agent.listApprovals();
      const focusedApprovalId = this.syncFocusedApproval(remainingApprovals);
      if (focusedApprovalId) {
        output.write(`Approval focus set to ${focusedApprovalId}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.write(`Approval decision failed: ${message}\n`);
    }
  }

  private syncFocusedApproval(approvals: ApprovalRequest[]): string | undefined {
    if (approvals.length === 0) {
      this.focusedApprovalId = undefined;
      return undefined;
    }
    if (!this.focusedApprovalId || !approvals.some((approval) => approval.id === this.focusedApprovalId)) {
      this.focusedApprovalId = approvals[0]?.id;
    }
    return this.focusedApprovalId;
  }

  private moveFocusedApproval(approvals: ApprovalRequest[], direction: 1 | -1): string | undefined {
    if (approvals.length === 0) {
      this.focusedApprovalId = undefined;
      return undefined;
    }
    const currentIndex = approvals.findIndex((approval) => approval.id === this.focusedApprovalId);
    const nextIndex = currentIndex === -1
      ? (direction === 1 ? 0 : approvals.length - 1)
      : (currentIndex + direction + approvals.length) % approvals.length;
    this.focusedApprovalId = approvals[nextIndex]?.id;
    return this.focusedApprovalId;
  }

  private resolveApprovalTargetId(target: string, approvals: ApprovalRequest[]): string | undefined {
    if (isSelectedApprovalTarget(target)) {
      return this.syncFocusedApproval(approvals);
    }
    return target;
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

  private async rebuildFromStoredEvents(sessionId?: string): Promise<RunloomEvent[]> {
    const events = await this.options.agent.listEvents({
      sessionId,
      limit: MAX_VIEW_LINES
    });
    this.rebuildViewState(events);
    return events;
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
        this.recordActivity(`run ${event.runId} started`, "runs", event);
        break;
      }
      case "model.selection.resolved": {
        const selection = event.payload as TuiViewState["latestModel"];
        this.viewState.latestModel = selection;
        this.recordActivity(`model ${formatModelSelection(event.payload)}`, "models", event);
        break;
      }
      case "response.output_text.delta": {
        this.assistantBuffer += String((event.payload as { delta?: string }).delta ?? "");
        break;
      }
      case "response.completed": {
        this.flushAssistantTranscript();
        this.recordActivity("model completed", "models", event);
        break;
      }
      case "response.failed": {
        this.flushAssistantTranscript();
        this.recordActivity(`model failed: ${formatErrorPayload(event.payload)}`, "models", event);
        break;
      }
      case "run.waiting_approval":
        this.viewState.runStatus = "waiting_approval";
        this.recordActivity(`run waiting for approval ${formatWaitingApproval(event.payload)}`.trimEnd(), "approvals", event);
        break;
      case "run.completed":
        this.viewState.runStatus = "completed";
        this.recordActivity(`run ${event.runId} completed`, "runs", event);
        break;
      case "run.failed":
        this.viewState.runStatus = "failed";
        this.activeRunId = undefined;
        this.recordActivity(`run failed: ${formatErrorPayload(event.payload)}`, "runs", event);
        break;
      case "run.cancel_requested":
        this.recordActivity(`run ${event.runId} cancel requested`, "runs", event);
        break;
      case "run.cancelled":
        this.viewState.runStatus = "cancelled";
        if (event.runId === this.activeRunId) {
          this.activeRunId = undefined;
        }
        this.recordActivity(`run ${event.runId} cancelled`, "runs", event);
        break;
      case "run.resumed":
        this.activeRunId = event.runId;
        this.activeSessionId = event.sessionId;
        this.viewState.runStatus = "running";
        this.recordActivity(`run ${event.runId} resumed`, "runs", event);
        break;
      case "todo.updated":
        if (!this.activeSessionId || event.sessionId === this.activeSessionId) {
          this.viewState.todoItems = (event.payload as { items?: RunloomTodoItem[] }).items ?? [];
        }
        this.recordActivity(`todo ${formatTodo(event.payload)}`.trimEnd(), "todos", event);
        break;
      case "coding.workspace.inspected":
        this.recordActivity("workspace inspected", "coding", event);
        break;
      case "coding.git.status":
        this.recordActivity(`git ${formatGitStatus(event.payload)}`, "coding", event);
        break;
      case "approval.requested":
        this.recordActivity(`approval requested ${formatApprovalRequest(event.payload)}`, "approvals", event);
        break;
      case "approval.resolved":
        this.recordActivity(`approval resolved ${formatApprovalResolution(event.payload)}`, "approvals", event);
        break;
      case "approval.policy.updated":
        this.recordActivity("approval policy updated", "approvals", event);
        break;
      case "review.findings.created":
        this.recordActivity("review findings recorded", "reviews", event);
        break;
      case "skill.activated":
        this.recordActivity(`skill activated ${formatSkillActivation(event.payload)}`, "skills", event);
        break;
      default:
        if (event.type.startsWith("tool.")) {
          this.recordActivity(formatToolActivityEvent(event), "tools", event);
        } else if (event.type.startsWith("mcp.")) {
          this.recordActivity(event.type, "mcp", event);
        }
        break;
    }
  }

  private rebuildViewState(events: RunloomEvent[]): void {
    this.clearViewState();
    for (const event of events) {
      this.applyEventToViewState(event);
    }
    this.flushAssistantTranscript();
  }

  private clearViewState(options: { preserveActiveRun?: boolean; preserveLatestModel?: boolean } = {}): void {
    const activeRunId = this.activeRunId;
    const runStatus = this.viewState.runStatus;
    const latestModel = this.viewState.latestModel;
    this.viewState.transcript = [];
    this.viewState.activity = [];
    this.viewState.activityRecords = [];
    this.viewState.todoItems = [];
    this.viewState.runStatus = options.preserveActiveRun ? runStatus : "idle";
    this.viewState.focus = "transcript";
    this.resetScrollOffsets();
    this.viewState.latestModel = options.preserveLatestModel ? latestModel : undefined;
    this.activeRunId = options.preserveActiveRun ? activeRunId : undefined;
    this.assistantBuffer = "";
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

  private recordActivity(line: string, category: ActivityCategory, event?: RunloomEvent): void {
    if (!line.trim()) {
      return;
    }
    this.pushActivityRecord({
      category,
      line,
      eventType: event?.type,
      runId: event?.runId,
      sessionId: event?.sessionId,
      source: event?.source,
      timestamp: event?.timestamp,
      payload: event?.payload
    });
  }

  private recordToolCommandActivity(
    result: ToolExecutionResult,
    line: string,
    category: ActivityCategory
  ): void {
    this.pushActivityRecord({
      category,
      line,
      eventType: `tool.${result.toolName}`,
      runId: result.runId,
      sessionId: result.sessionId,
      source: "tui",
      payload: {
        toolName: result.toolName,
        status: result.status,
        output: result.output,
        error: result.error,
        approvalId: result.approvalId,
        durationMs: result.durationMs
      }
    });
  }

  private pushActivityRecord(record: TuiActivityRecord): void {
    if (!record.line.trim()) {
      return;
    }
    pushCapped(this.viewState.activity, record.line);
    pushCapped(this.viewState.activityRecords, record);
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

function formatTodoView(items: RunloomTodoItem[], limit = DEFAULT_PANEL_LINES, scrollOffset = 0): string {
  if (items.length === 0) {
    return "Todo: (none)\n";
  }
  const visibleItems = visibleSlice(items, limit, scrollOffset);
  const lines = [formatPanelHeader("Todo", items.length, visibleItems.start, visibleItems.items.length, scrollOffset)];
  for (const item of visibleItems.items) {
    const evidence = item.evidence?.length ? ` evidence=${item.evidence.join(",")}` : "";
    lines.push(`  ${item.status} ${item.title}${evidence}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatStatusView(state: TuiViewState, context: TuiViewContext): string {
  const latestActivity = state.activity.at(-1) ?? "(none)";
  return [
    "Status:",
    `  session: ${context.activeSessionId ?? "(none)"}`,
    `  run: ${context.activeRunId ?? "(none)"} status=${state.runStatus}`,
    `  focus: ${state.focus}`,
    `  model: ${formatStatusModel(state, context)}`,
    `  taskType: ${context.activeTaskType ?? "(auto)"}`,
    `  language: ${context.activeLanguage ?? "(auto)"}`,
    `  todo: ${formatTodoCounts(state.todoItems)}`,
    `  latest activity: ${latestActivity}`
  ].join("\n") + "\n";
}

function formatCompositeView(state: TuiViewState, context: TuiViewContext): string {
  return [
    formatStatusView(state, context).trimEnd(),
    formatTodoView(state.todoItems, COMPOSITE_PANEL_LINES, state.todoScrollOffset).trimEnd(),
    formatActivityView(state.activity, COMPOSITE_PANEL_LINES, state.activityScrollOffset).trimEnd(),
    formatTranscriptView(state.transcript, COMPOSITE_PANEL_LINES, state.transcriptScrollOffset).trimEnd()
  ].join("\n") + "\n";
}

function formatTranscriptView(lines: string[], limit = DEFAULT_PANEL_LINES, scrollOffset = 0): string {
  if (lines.length === 0) {
    return "Transcript: (empty)\n";
  }
  const visibleLines = visibleSlice(lines, limit, scrollOffset);
  return `${formatPanelHeader("Transcript", lines.length, visibleLines.start, visibleLines.items.length, scrollOffset)}\n${visibleLines.items
    .map((line) => `  ${line}`)
    .join("\n")}\n`;
}

function formatActivityView(
  lines: string[],
  limit = DEFAULT_PANEL_LINES,
  scrollOffset = 0,
  category?: ActivityCategory
): string {
  const title = category ? `Activity (${category})` : "Activity";
  if (lines.length === 0) {
    return `${title}: (none)\n`;
  }
  const visibleLines = visibleSlice(lines, limit, scrollOffset);
  return `${formatPanelHeader(title, lines.length, visibleLines.start, visibleLines.items.length, scrollOffset)}\n${visibleLines.items
    .map((line) => `  ${line}`)
    .join("\n")}\n`;
}

function formatActivityDetail(
  records: TuiActivityRecord[],
  allRecords: TuiActivityRecord[],
  category?: ActivityCategory,
  targetText?: string
): string {
  const title = category ? `Activity Detail (${category})` : "Activity Detail";
  if (records.length === 0) {
    return `${title}: (none)\n`;
  }

  const resolved = resolveActivityDetailTarget(records, targetText);
  if ("error" in resolved) {
    return `${resolved.error}\n${formatActivityCommandHelp()}`;
  }

  const absoluteIndex = allRecords.indexOf(resolved.record) + 1;
  const lines = [
    `${title}: #${absoluteIndex}`,
    `  category: ${resolved.record.category}`,
    `  filteredIndex: ${resolved.index + 1}`,
    `  event: ${resolved.record.eventType ?? "(none)"}`,
    `  run: ${resolved.record.runId ?? "(none)"}`,
    `  session: ${resolved.record.sessionId ?? "(none)"}`,
    `  source: ${resolved.record.source ?? "(none)"}`,
    `  timestamp: ${resolved.record.timestamp ?? "(none)"}`,
    `  line: ${resolved.record.line}`,
    "  payload:",
    indentBlock(formatUnknownValue(resolved.record.payload), 4)
  ];
  return `${lines.join("\n")}\n`;
}

function resolveActivityDetailTarget(
  records: TuiActivityRecord[],
  targetText?: string
): { record: TuiActivityRecord; index: number } | { error: string } {
  const target = targetText?.toLowerCase() ?? "latest";
  if (target === "latest" || target === "last" || target === "current" || target === ".") {
    const index = records.length - 1;
    return { record: records[index], index };
  }

  const parsed = Number(target);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > records.length) {
    return {
      error: `Invalid activity selection: ${targetText ?? "(missing)"}`
    };
  }

  const index = parsed - 1;
  return { record: records[index], index };
}

function formatStatusModel(state: TuiViewState, context: Pick<TuiViewContext, "activeModel" | "activeProfile">): string {
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

function formatApprovalPolicyPanel(policy: ApprovalPolicyConfig): string {
  const scopeWidth = Math.max("scope".length, ...PERMISSION_SCOPES.map((scope) => scope.length));
  const modeWidth = Math.max("mode".length, ...APPROVAL_MODES.map((mode) => mode.length));
  const lines = [
    "Approval Policy:",
    `  default: ${policy.defaultMode}`,
    `  updated: ${policy.updatedAt} by ${policy.updatedBy}`,
    `  ${"scope".padEnd(scopeWidth)}  ${"mode".padEnd(modeWidth)}  source`
  ];

  for (const scope of PERMISSION_SCOPES) {
    const configuredMode = policy.scopes[scope];
    const mode = configuredMode ?? policy.defaultMode;
    const source = configuredMode ? "override" : "default";
    lines.push(`  ${scope.padEnd(scopeWidth)}  ${mode.padEnd(modeWidth)}  ${source}`);
  }

  lines.push("  commands: /permissions set <scope|default> <full_access|ask|auto_decide>");
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

function formatApprovals(approvals: ApprovalRequest[], focusedApprovalId?: string): string {
  if (approvals.length === 0) {
    return "Approvals: (none pending)\n";
  }
  const focus = focusedApprovalId ? ` focused=${focusedApprovalId}` : "";
  const lines = [`Approval Center: ${approvals.length} pending${focus}`];
  for (const approval of approvals) {
    const expires = approval.expiresAt ? ` expires=${approval.expiresAt}` : "";
    const marker = approval.id === focusedApprovalId ? "*" : " ";
    lines.push(`${marker} ${approval.id} risk=${approval.risk} scope=${approval.scope} mode=${approval.mode}${expires}`);
    lines.push(`    action=${approval.action} run=${approval.runId} session=${approval.sessionId}`);
    lines.push(`    summary: ${approval.summary}`);
    lines.push(
      `    commands: /approve ${approval.id} once | /approve ${approval.id} session | /deny ${approval.id} <reason> | /approvals view ${approval.id}`
    );
  }
  lines.push("  selection: /approvals next | /approvals prev | /approvals view | /approve selected once | /deny selected <reason>");
  return `${lines.join("\n")}\n`;
}

function formatApprovalDetail(approval: ApprovalRequest): string {
  const lines = [
    `Approval: ${approval.id}`,
    `  action: ${approval.action}`,
    `  scope: ${approval.scope}`,
    `  risk: ${approval.risk}`,
    `  mode: ${approval.mode}`,
    `  run: ${approval.runId}`,
    `  session: ${approval.sessionId}`,
    `  summary: ${approval.summary}`
  ];
  if (approval.expiresAt) {
    lines.push(`  expiresAt: ${approval.expiresAt}`);
  }
  lines.push("  details:");
  lines.push(indentBlock(formatUnknownValue(approval.details), 4));
  lines.push(`  commands: /approve ${approval.id} once | /approve ${approval.id} session | /deny ${approval.id} <reason>`);
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

function formatVerificationActivity(payload: unknown): string {
  const result = payload as { command?: string; exitCode?: number; durationMs?: number };
  return `${result.command ?? "verification"} exit=${result.exitCode ?? "unknown"} duration=${result.durationMs ?? 0}ms`;
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

function formatDiffActivity(payload: unknown): string {
  const diff = payload as { filesChanged?: string[]; additions?: number; deletions?: number; patch?: string };
  const files = diff.filesChanged ?? [];
  if (files.length === 0 && !diff.patch?.trim()) {
    return "no tracked changes";
  }
  return `${files.length} file(s), +${diff.additions ?? 0}/-${diff.deletions ?? 0}`;
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

function formatPermissionsCommandHelp(): string {
  return [
    "Usage:",
    "  /permissions",
    "  /permissions set default <full_access|ask|auto_decide>",
    "  /permissions set <scope> <full_access|ask|auto_decide>"
  ].join("\n") + "\n";
}

function formatApprovalsCommandHelp(): string {
  return [
    "Usage:",
    "  /approvals",
    "  /approvals next",
    "  /approvals prev",
    "  /approvals view [approval-id|selected]",
    "  /approvals focus <approval-id>",
    "  /approve <approval-id|selected> [once|session|workspace|global] [mode=<full_access|ask|auto_decide>]",
    "  /deny <approval-id|selected> [reason]"
  ].join("\n") + "\n";
}

function formatApprovalDecisionCommandHelp(): string {
  return [
    "Usage:",
    "  /approve <approval-id|selected> [once|session|workspace|global] [mode=<full_access|ask|auto_decide>]",
    "  /deny <approval-id|selected> [reason]"
  ].join("\n") + "\n";
}

function formatScopeList(): string {
  return `Scopes: ${PERMISSION_SCOPES.join(", ")}\n`;
}

function parsePanel(value: string): TuiPanel | undefined {
  if (value === "status" || value === "transcript" || value === "todo" || value === "activity") {
    return value;
  }
  return undefined;
}

function isScrollAction(value: string): value is ScrollAction {
  return value === "up" || value === "down" || value === "top" || value === "bottom";
}

function parseScrollAmount(value: string | undefined): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_PANEL_LINES;
}

function parseApprovalDecisionCommand(
  action: string,
  args: string[]
): { decision: ApprovalDecision } | { error: string } {
  if (action === "/deny") {
    return {
      decision: {
        decision: "denied",
        reason: args.join(" ").trim() || undefined
      }
    };
  }

  const decision: ApprovalDecision = {
    decision: "approved"
  };

  for (const arg of args) {
    if (arg === "once" || arg === "never") {
      decision.remember = "never";
      continue;
    }
    if (arg === "session" || arg === "workspace" || arg === "global") {
      decision.remember = arg;
      continue;
    }
    if (arg.startsWith("mode=")) {
      const mode = parseApprovalMode(arg.slice("mode=".length));
      if (!mode) {
        return {
          error: `Invalid approval mode: ${arg.slice("mode=".length) || "(missing)"}`
        };
      }
      decision.setModeForScope = mode;
      continue;
    }
    if (arg.startsWith("set=")) {
      const mode = parseApprovalMode(arg.slice("set=".length));
      if (!mode) {
        return {
          error: `Invalid approval mode: ${arg.slice("set=".length) || "(missing)"}`
        };
      }
      decision.setModeForScope = mode;
      continue;
    }
    return {
      error: `Unknown approval option: ${arg}`
    };
  }

  return {
    decision
  };
}

function isSelectedApprovalTarget(value: string): boolean {
  return value === "selected" || value === "current" || value === ".";
}

function formatApprovalDecision(decision: ApprovalDecision): string {
  const parts: string[] = [decision.decision];
  if (decision.remember) {
    parts.push(`remember=${decision.remember}`);
  }
  if (decision.setModeForScope) {
    parts.push(`setModeForScope=${decision.setModeForScope}`);
  }
  if (decision.reason) {
    parts.push(`reason=${decision.reason}`);
  }
  return parts.join(" ");
}

function formatFocusCommandHelp(): string {
  return "Usage: /focus <status|transcript|todo|activity>\n";
}

function formatScrollCommandHelp(): string {
  return "Usage: /scroll <up|down|top|bottom> [lines]\n";
}

function formatActivityCommandHelp(): string {
  return [
    "Usage:",
    "  /activity [all|runs|models|todos|coding|tools|approvals|reviews|skills|mcp] [up|down|top|bottom] [lines]",
    "  /activity view [all|runs|models|todos|coding|tools|approvals|reviews|skills|mcp] [index|latest]",
    "  /activity <filter> view [index|latest]"
  ].join("\n") + "\n";
}

function formatShortcutCommandHelp(): string {
  return "Usage: /key <ctrl+l|pgup|pgdn|alt+1|alt+2|alt+3|n|p|v|a|s|d> [deny-reason]\n";
}

function parseActivityCategory(value: string): ActivityCategory | undefined {
  if (value === "run" || value === "runs") {
    return "runs";
  }
  if (value === "model" || value === "models") {
    return "models";
  }
  if (value === "todo" || value === "todos") {
    return "todos";
  }
  if (value === "coding" || value === "code") {
    return "coding";
  }
  if (value === "tool" || value === "tools") {
    return "tools";
  }
  if (value === "approval" || value === "approvals") {
    return "approvals";
  }
  if (value === "review" || value === "reviews") {
    return "reviews";
  }
  if (value === "skill" || value === "skills") {
    return "skills";
  }
  if (value === "mcp") {
    return "mcp";
  }
  return undefined;
}

function normalizeShortcut(value: string): TuiShortcut | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "ctrl+l" || normalized === "control+l") {
    return "ctrl+l";
  }
  if (normalized === "pgup" || normalized === "pageup") {
    return "pgup";
  }
  if (normalized === "pgdn" || normalized === "pagedown") {
    return "pgdn";
  }
  if (normalized === "alt+1" || normalized === "option+1") {
    return "alt+1";
  }
  if (normalized === "alt+2" || normalized === "option+2") {
    return "alt+2";
  }
  if (normalized === "alt+3" || normalized === "option+3") {
    return "alt+3";
  }
  if (normalized === "n" || normalized === "next") {
    return "n";
  }
  if (normalized === "p" || normalized === "prev" || normalized === "previous") {
    return "p";
  }
  if (normalized === "v" || normalized === "view") {
    return "v";
  }
  if (normalized === "a" || normalized === "approve") {
    return "a";
  }
  if (normalized === "s" || normalized === "session") {
    return "s";
  }
  if (normalized === "d" || normalized === "deny") {
    return "d";
  }
  return undefined;
}

function formatShortcutLabel(shortcut: TuiShortcut): string {
  switch (shortcut) {
    case "ctrl+l":
      return "Ctrl+L";
    case "pgup":
      return "PgUp";
    case "pgdn":
      return "PgDn";
    case "alt+1":
      return "Alt+1";
    case "alt+2":
      return "Alt+2";
    case "alt+3":
      return "Alt+3";
    case "n":
      return "N";
    case "p":
      return "P";
    case "v":
      return "V";
    case "a":
      return "A";
    case "s":
      return "S";
    case "d":
      return "D";
  }
}

function isApprovalShortcut(shortcut: TuiShortcut): shortcut is ApprovalShortcut {
  return shortcut === "n" || shortcut === "p" || shortcut === "v" || shortcut === "a" || shortcut === "s" || shortcut === "d";
}

function panelForShortcut(shortcut: TuiShortcut): TuiPanel | undefined {
  switch (shortcut) {
    case "alt+1":
      return "transcript";
    case "alt+2":
      return "todo";
    case "alt+3":
      return "activity";
    default:
      return undefined;
  }
}

function visibleSlice<TItem>(
  items: TItem[],
  limit: number,
  scrollOffset: number
): { items: TItem[]; start: number; end: number } {
  const safeLimit = Math.max(1, limit);
  const safeOffset = clamp(scrollOffset, 0, Math.max(0, items.length - safeLimit));
  const end = Math.max(0, items.length - safeOffset);
  const start = Math.max(0, end - safeLimit);
  return {
    items: items.slice(start, end),
    start,
    end
  };
}

function formatPanelHeader(name: string, total: number, start: number, count: number, scrollOffset: number): string {
  if (total <= count && scrollOffset === 0) {
    return `${name}:`;
  }
  const first = count > 0 ? start + 1 : 0;
  const last = start + count;
  const offset = scrollOffset > 0 ? ` offset=${scrollOffset}` : "";
  return `${name}: showing ${first}-${last} of ${total}${offset}`;
}

function pushCapped<TItem>(items: TItem[], item: TItem): void {
  items.push(item);
  if (items.length > MAX_VIEW_LINES) {
    items.splice(0, items.length - MAX_VIEW_LINES);
  }
}

function truncateText(value: string, maxLength = 300): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatUnknownValue(value: unknown): string {
  if (value === undefined) {
    return "(none)";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function indentBlock(value: string, spaces: number): string {
  const padding = " ".repeat(spaces);
  return value
    .split(/\r?\n/)
    .map((line) => `${padding}${line}`)
    .join("\n");
}
