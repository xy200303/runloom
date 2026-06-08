import type { Writable } from "node:stream";
import type { TuiApprovalCommandController } from "./approval-commands.js";
import {
  isApprovalShortcut,
  isScrollAction,
  normalizeShortcut,
  panelForShortcut,
  parseActivityCategory,
  parsePanel,
  parseScrollAmount
} from "./command-parsers.js";
import {
  formatActivityCommandHelp,
  formatActivityDetail,
  formatActivityView,
  formatFocusCommandHelp,
  formatScrollCommandHelp,
  formatShortcutCommandHelp,
  formatShortcutLabel,
  formatStatusView,
  formatTodoView,
  formatTranscriptView
} from "./view-formatters.js";
import {
  DEFAULT_PANEL_LINES,
  FOCUS_PANELS,
  clamp,
  visibleSlice,
  type ActivityCategory,
  type ScrollAction,
  type TuiActivityRecord,
  type TuiPanel,
  type TuiViewContext,
  type TuiViewState
} from "./view-model.js";

export interface TuiViewCommandControllerOptions {
  output: Writable;
  viewState: TuiViewState;
  approvalCommands: TuiApprovalCommandController;
  clearViewState(options?: ClearTuiViewStateOptions): void;
  getViewContext(): TuiViewContext;
}

export interface ClearTuiViewStateOptions {
  preserveActiveRun?: boolean;
  preserveLatestModel?: boolean;
}

export class TuiViewCommandController {
  constructor(private readonly options: TuiViewCommandControllerOptions) {}

  handlePanelCommand(panel: TuiPanel, command: string): void {
    const output = this.options.output;
    const [, action, amountText] = command.split(/\s+/);
    if (action && isScrollAction(action)) {
      this.options.viewState.focus = panel;
      this.scrollPanel(panel, action, parseScrollAmount(amountText));
    }
    output.write(this.formatPanel(panel));
  }

  handleActivityCommand(command: string): void {
    const output = this.options.output;
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
      this.options.viewState.focus = "activity";
      this.scrollActivity(category, actionText, parseScrollAmount(amountText));
    } else if (actionText) {
      output.write(`Invalid activity action: ${actionText}\n`);
      output.write(formatActivityCommandHelp());
      return;
    }

    output.write(this.formatActivity(category));
  }

  handleFocusCommand(command: string): void {
    const output = this.options.output;
    const [, panelText] = command.split(/\s+/);
    if (!panelText) {
      output.write(`Focus: ${this.options.viewState.focus}\n`);
      output.write(formatFocusCommandHelp());
      return;
    }

    const panel = parsePanel(panelText);
    if (!panel) {
      output.write(`Invalid panel: ${panelText}\n`);
      output.write(formatFocusCommandHelp());
      return;
    }

    this.options.viewState.focus = panel;
    output.write(`Focus set to ${panel}\n`);
    output.write(this.formatPanel(panel));
  }

  handleScrollCommand(command: string): void {
    const output = this.options.output;
    const [, actionText, amountText] = command.split(/\s+/);
    const action = actionText ?? "down";
    if (!isScrollAction(action)) {
      output.write(`Invalid scroll direction: ${action}\n`);
      output.write(formatScrollCommandHelp());
      return;
    }

    this.scrollPanel(this.options.viewState.focus, action, parseScrollAmount(amountText));
    output.write(this.formatPanel(this.options.viewState.focus));
  }

  async handleShortcutCommand(command: string): Promise<void> {
    const output = this.options.output;
    const [, shortcutText, ...shortcutArgs] = command.split(/\s+/);
    const shortcut = normalizeShortcut(shortcutText ?? "");

    if (!shortcut) {
      output.write("Invalid keyboard shortcut\n");
      output.write(formatShortcutCommandHelp());
      return;
    }

    if (shortcut === "ctrl+l") {
      this.options.clearViewState({ preserveActiveRun: true, preserveLatestModel: true });
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      output.write("View cleared\n");
      return;
    }

    if (shortcut === "esc") {
      this.options.approvalCommands.clearFocus();
      this.options.viewState.focus = "transcript";
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
      const panel = this.options.viewState.focus;
      this.scrollPanel(panel, shortcut === "pgup" ? "up" : "down", DEFAULT_PANEL_LINES);
      output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
      output.write(this.formatPanel(panel));
      return;
    }

    if (shortcut === "home" || shortcut === "end") {
      const panel = this.options.viewState.focus;
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
      await this.options.approvalCommands.handleShortcut(shortcut, shortcutArgs);
      return;
    }

    const panel = panelForShortcut(shortcut);
    if (!panel) {
      output.write("Invalid keyboard shortcut\n");
      output.write(formatShortcutCommandHelp());
      return;
    }
    this.options.viewState.focus = panel;
    output.write(`Shortcut ${formatShortcutLabel(shortcut)}\n`);
    output.write(`Focus set to ${panel}\n`);
    output.write(this.formatPanel(panel));
  }

  resetScrollOffsets(): void {
    this.options.viewState.transcriptScrollOffset = 0;
    this.options.viewState.activityScrollOffset = 0;
    this.options.viewState.todoScrollOffset = 0;
  }

  private cycleFocus(direction: 1 | -1): TuiPanel {
    const currentIndex = FOCUS_PANELS.indexOf(this.options.viewState.focus);
    const nextIndex = currentIndex === -1
      ? 0
      : (currentIndex + direction + FOCUS_PANELS.length) % FOCUS_PANELS.length;
    const panel = FOCUS_PANELS[nextIndex] ?? "transcript";
    this.options.viewState.focus = panel;
    return panel;
  }

  private formatFocusedDefaultAction(): string {
    if (this.options.viewState.focus === "activity") {
      return this.formatActivityDetailCommand("current");
    }
    return this.formatPanel(this.options.viewState.focus);
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
    const current = this.options.viewState.activityScrollOffset;
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

    this.options.viewState.activityScrollOffset = clamp(next, 0, maxOffset);
  }

  private maxScrollOffset(panel: TuiPanel): number {
    if (panel === "transcript") {
      return Math.max(0, this.options.viewState.transcript.length - DEFAULT_PANEL_LINES);
    }
    if (panel === "activity") {
      return Math.max(0, this.options.viewState.activity.length - DEFAULT_PANEL_LINES);
    }
    if (panel === "todo") {
      return Math.max(0, this.options.viewState.todoItems.length - DEFAULT_PANEL_LINES);
    }
    return 0;
  }

  private getScrollOffset(panel: TuiPanel): number {
    if (panel === "transcript") {
      return this.options.viewState.transcriptScrollOffset;
    }
    if (panel === "activity") {
      return this.options.viewState.activityScrollOffset;
    }
    if (panel === "todo") {
      return this.options.viewState.todoScrollOffset;
    }
    return 0;
  }

  private setScrollOffset(panel: TuiPanel, offset: number): void {
    if (panel === "transcript") {
      this.options.viewState.transcriptScrollOffset = offset;
    } else if (panel === "activity") {
      this.options.viewState.activityScrollOffset = offset;
    } else if (panel === "todo") {
      this.options.viewState.todoScrollOffset = offset;
    }
  }

  private formatPanel(panel: TuiPanel): string {
    if (panel === "status") {
      return formatStatusView(this.options.viewState, this.options.getViewContext());
    }
    if (panel === "todo") {
      return formatTodoView(this.options.viewState.todoItems, DEFAULT_PANEL_LINES, this.options.viewState.todoScrollOffset);
    }
    if (panel === "activity") {
      return this.formatActivity();
    }
    return formatTranscriptView(this.options.viewState.transcript, DEFAULT_PANEL_LINES, this.options.viewState.transcriptScrollOffset);
  }

  private formatActivity(category?: ActivityCategory): string {
    const lines = this.activityLines(category);
    const scrollOffset = clamp(this.options.viewState.activityScrollOffset, 0, Math.max(0, lines.length - DEFAULT_PANEL_LINES));
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
      return this.options.viewState.activityRecords;
    }
    return this.options.viewState.activityRecords.filter((record) => record.category === category);
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
      this.options.viewState.activityRecords,
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
    return visibleSlice(records, DEFAULT_PANEL_LINES, this.options.viewState.activityScrollOffset).start;
  }
}
