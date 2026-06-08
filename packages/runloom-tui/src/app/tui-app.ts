import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import type {
  ApprovalPolicyConfig,
  RunloomAgent,
  RunloomEvent,
  RunloomTodoItem,
  ToolExecutionResult,
  Unsubscribe
} from "runloom-agent";
import { TuiApprovalCommandController } from "./approval-commands.js";
import {
  isApprovalShortcut,
  isScrollAction,
  normalizeShortcut,
  panelForShortcut,
  parseActivityCategory,
  parsePanel,
  parseScrollAmount,
  parseVerificationCommand
} from "./command-parsers.js";
import { TuiModelCommandController } from "./model-commands.js";
import { TuiSessionCommandController } from "./session-commands.js";
import {
  DEFAULT_PANEL_LINES,
  FOCUS_PANELS,
  MAX_VIEW_LINES,
  clamp,
  pushCapped,
  truncateText,
  visibleSlice,
  type ActivityCategory,
  type ScrollAction,
  type TuiActivityRecord,
  type TuiPanel,
  type TuiViewContext,
  type TuiViewState
} from "./view-model.js";
import {
  formatA2APeers,
  formatActivityCommandHelp,
  formatActivityDetail,
  formatActivityView,
  formatApprovalPolicy,
  formatApprovalRequest,
  formatApprovalResolution,
  formatCompositeView,
  formatDiffActivity,
  formatDiffSummary,
  formatErrorPayload,
  formatExternalAgents,
  formatFocusCommandHelp,
  formatGitStatus,
  formatMcpServers,
  formatModelSelection,
  formatReviewFindings,
  formatScrollCommandHelp,
  formatShortcutCommandHelp,
  formatShortcutLabel,
  formatSkillActivation,
  formatSkills,
  formatStatusView,
  formatTodo,
  formatTodoView,
  formatToolActivityEvent,
  formatToolExecutionState,
  formatTools,
  formatTranscriptView,
  formatVerificationActivity,
  formatVerificationResult,
  formatWaitingApproval
} from "./view-formatters.js";

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

class BasicRunloomTuiApp implements RunloomTuiApp {
  private unsubscribe?: Unsubscribe;
  private stopped = false;
  private activeRunId?: string;
  private activeSessionId?: string;
  private assistantBuffer = "";
  private readonly approvalCommands: TuiApprovalCommandController;
  private readonly modelCommands: TuiModelCommandController;
  private readonly sessionCommands: TuiSessionCommandController;
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

  constructor(private readonly options: CreateRunloomTuiAppOptions) {
    this.approvalCommands = new TuiApprovalCommandController({
      agent: options.agent,
      output: options.output ?? defaultOutput
    });
    this.modelCommands = new TuiModelCommandController({
      output: options.output ?? defaultOutput
    });
    this.sessionCommands = new TuiSessionCommandController({
      agent: options.agent,
      output: options.output ?? defaultOutput,
      getActiveSessionId: () => this.activeSessionId,
      getActiveRunId: () => this.activeRunId,
      setActiveSessionId: (sessionId) => {
        this.activeSessionId = sessionId;
      },
      setActiveRunId: (runId) => {
        this.activeRunId = runId;
      },
      rebuildFromStoredEvents: (sessionId) => this.rebuildFromStoredEvents(sessionId),
      renderCompositeView: () => formatCompositeView(this.viewState, this.viewContext())
    });
  }

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
      ...this.modelCommands.submitOptions()
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
          "  /a2a           List A2A peers",
          "  /external      List external agent adapters",
          "  /git           Show git status",
          "  /tests         Run verification command",
          "  /quit          Exit"
        ].join("\n") + "\n"
      );
      return;
    }

    if (command === "/status") {
      const policy = await this.options.agent.getApprovalPolicy();
      output.write(formatStatusView(this.viewState, this.viewContext()));
      output.write(formatApprovalPolicy(policy));
      return;
    }

    if (command === "/permissions" || command.startsWith("/permissions ")) {
      await this.approvalCommands.handlePermissionsCommand(command);
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
      output.write(formatCompositeView(this.viewState, this.viewContext()));
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
      await this.sessionCommands.handleReplayCommand();
      return;
    }

    if (command === "/tools") {
      const tools = await this.options.agent.listTools();
      output.write(formatTools(tools));
      return;
    }

    if (command === "/approvals" || command.startsWith("/approvals ")) {
      await this.approvalCommands.handleApprovalsCommand(command);
      return;
    }

    if (command.startsWith("/approve") || command.startsWith("/deny")) {
      await this.approvalCommands.handleApprovalDecisionCommand(command);
      return;
    }

    if (command === "/session" || command.startsWith("/session ")) {
      await this.sessionCommands.handleSessionCommand(command);
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
      this.modelCommands.handleReviewCommand(command);
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

    if (command === "/a2a") {
      const peers = await this.options.agent.listA2APeers();
      output.write(formatA2APeers(peers));
      return;
    }

    if (command === "/external") {
      const agents = await this.options.agent.listExternalAgents();
      output.write(formatExternalAgents(agents));
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
      this.modelCommands.handleModelCommand(command);
      return;
    }

    if (command.startsWith("/approval")) {
      await this.approvalCommands.handleApprovalCommand(command);
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

    if (shortcut === "esc") {
      this.approvalCommands.clearFocus();
      this.viewState.focus = "transcript";
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      output.write("Focus set to transcript\n");
      output.write(this.formatPanel("transcript"));
      return;
    }

    if (shortcut === "enter") {
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      output.write(this.formatFocusedDefaultAction());
      return;
    }

    if (shortcut === "pgup" || shortcut === "pgdn") {
      const panel = this.viewState.focus;
      this.scrollPanel(panel, shortcut === "pgup" ? "up" : "down", DEFAULT_PANEL_LINES);
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      output.write(this.formatPanel(panel));
      return;
    }

    if (shortcut === "home" || shortcut === "end") {
      const panel = this.viewState.focus;
      this.scrollPanel(panel, shortcut === "home" ? "top" : "bottom", DEFAULT_PANEL_LINES);
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      output.write(this.formatPanel(panel));
      return;
    }

    if (shortcut === "tab" || shortcut === "shift+tab") {
      const panel = this.cycleFocus(shortcut === "tab" ? 1 : -1);
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      output.write(`Focus set to ${panel}\n`);
      output.write(this.formatPanel(panel));
      return;
    }

    if (isApprovalShortcut(shortcut)) {
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      await this.approvalCommands.handleShortcut(shortcut, shortcutArgs);
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

  private cycleFocus(direction: 1 | -1): TuiPanel {
    const currentIndex = FOCUS_PANELS.indexOf(this.viewState.focus);
    const nextIndex = currentIndex === -1
      ? 0
      : (currentIndex + direction + FOCUS_PANELS.length) % FOCUS_PANELS.length;
    const panel = FOCUS_PANELS[nextIndex] ?? "transcript";
    this.viewState.focus = panel;
    return panel;
  }

  private formatFocusedDefaultAction(): string {
    if (this.viewState.focus === "activity") {
      return this.formatActivityDetailCommand("current");
    }
    return this.formatPanel(this.viewState.focus);
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
      target,
      this.currentActivityVisibleIndex(category)
    );
  }

  private currentActivityVisibleIndex(category?: ActivityCategory): number | undefined {
    const records = this.activityRecords(category);
    if (records.length === 0) {
      return undefined;
    }
    return visibleSlice(records, DEFAULT_PANEL_LINES, this.viewState.activityScrollOffset).start;
  }

  private viewContext(): TuiViewContext {
    return {
      activeSessionId: this.activeSessionId,
      activeRunId: this.activeRunId,
      ...this.modelCommands.viewContext()
    };
  }

  private trackToolSession(result: ToolExecutionResult): void {
    this.activeRunId = result.runId;
    this.activeSessionId = result.sessionId;
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
        } else if (event.type.startsWith("a2a.")) {
          this.recordActivity(event.type, "a2a", event);
        } else if (event.type.startsWith("external_agent.")) {
          this.recordActivity(event.type, "external", event);
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

function isReadlineClosedError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ERR_USE_AFTER_CLOSE");
}

function isInteractiveInput(input: Readable): boolean {
  return Boolean((input as { isTTY?: boolean }).isTTY);
}
