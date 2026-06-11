import type { RunloomSession, RunloomTodoItem } from "runloom-agent";
import { formatActivityView } from "./activity-formatters.js";
import { formatPanelHeader } from "./panel-formatters.js";
export {
  formatActivityDetail,
  formatActivityView,
  resolveActivityDetailTarget
} from "./activity-formatters.js";
export {
  formatApprovalDetail,
  formatApprovalPolicy,
  formatApprovalPolicyPanel,
  formatApprovalRequest,
  formatApprovalResolution,
  formatApprovals,
  formatWaitingApproval
} from "./approval-formatters.js";
export {
  formatDiffActivity,
  formatDiffSummary,
  formatErrorPayload,
  formatGitStatus,
  formatModelSelection,
  formatReviewFindings,
  formatSkillActivation,
  formatTodo,
  formatToolActivityEvent,
  formatToolExecutionState,
  formatVerificationActivity,
  formatVerificationResult
} from "./event-formatters.js";
export {
  formatActivityCommandHelp,
  formatApprovalCommandHelp,
  formatApprovalDecision,
  formatApprovalDecisionCommandHelp,
  formatApprovalsCommandHelp,
  formatFocusCommandHelp,
  formatModelCommandHelp,
  formatPermissionsCommandHelp,
  formatScopeList,
  formatScrollCommandHelp,
  formatSessionCommandHelp,
  formatShortcutCommandHelp,
  formatShortcutLabel
} from "./command-formatters.js";
export {
  formatA2APeers,
  formatExternalAgents,
  formatMcpServers,
  formatSkillPermissions,
  formatSkills,
  formatTools
} from "./resource-formatters.js";
export { formatPanelHeader } from "./panel-formatters.js";
export { formatUnknownValue, indentBlock } from "./value-formatters.js";
import {
  COMPOSITE_PANEL_LINES,
  DEFAULT_PANEL_LINES,
  visibleSlice,
  type TuiViewContext,
  type TuiViewState
} from "./view-model.js";

export function formatTodoView(items: RunloomTodoItem[], limit = DEFAULT_PANEL_LINES, scrollOffset = 0): string {
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

export function formatStatusView(state: TuiViewState, context: TuiViewContext): string {
  const latestActivity = state.activity.at(-1) ?? "(none)";
  return [
    "Status:",
    `  session: ${context.activeSessionId ?? "(none)"}`,
    `  run: ${context.activeRunId ?? "(none)"} status=${state.runStatus}`,
    `  focus: ${state.focus}`,
    `  scroll: transcript=${state.transcriptScrollOffset}, todo=${state.todoScrollOffset}, activity=${state.activityScrollOffset}`,
    `  model: ${formatStatusModel(state, context)}`,
    `  taskType: ${context.activeTaskType ?? "(auto)"}`,
    `  language: ${context.activeLanguage ?? "(auto)"}`,
    `  todo: ${formatTodoCounts(state.todoItems)}`,
    `  latest activity: ${latestActivity}`
  ].join("\n") + "\n";
}

export function formatCompositeView(state: TuiViewState, context: TuiViewContext): string {
  return [
    formatStatusView(state, context).trimEnd(),
    formatTodoView(state.todoItems, COMPOSITE_PANEL_LINES, state.todoScrollOffset).trimEnd(),
    formatActivityView(state.activity, COMPOSITE_PANEL_LINES, state.activityScrollOffset).trimEnd(),
    formatTranscriptView(state.transcript, COMPOSITE_PANEL_LINES, state.transcriptScrollOffset).trimEnd()
  ].join("\n") + "\n";
}

export function formatTranscriptView(lines: string[], limit = DEFAULT_PANEL_LINES, scrollOffset = 0): string {
  if (lines.length === 0) {
    return "Transcript: (empty)\n";
  }
  const visibleLines = visibleSlice(lines, limit, scrollOffset);
  return `${formatPanelHeader("Transcript", lines.length, visibleLines.start, visibleLines.items.length, scrollOffset)}\n${visibleLines.items
    .map((line) => `  ${line}`)
    .join("\n")}\n`;
}

export function formatStatusModel(state: TuiViewState, context: Pick<TuiViewContext, "activeModel" | "activeProfile">): string {
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

export function formatTodoCounts(items: RunloomTodoItem[]): string {
  if (items.length === 0) {
    return "none";
  }

  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ");
}

export function formatCurrentSession(session: RunloomSession, activeRunId?: string): string {
  return [
    `Session: ${session.id}`,
    `  workspace: ${session.workspace}`,
    `  createdAt: ${session.createdAt}`,
    `  updatedAt: ${session.updatedAt}`,
    `  activeRun: ${activeRunId ?? "(none)"}`
  ].join("\n") + "\n";
}

export function formatSessions(sessions: RunloomSession[], activeSessionId?: string): string {
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

export function formatActiveModelState(model?: string, profile?: string, taskType?: string, language?: string): string {
  return [
    "Model overrides:",
    `  model: ${model ?? "(auto)"}`,
    `  profile: ${profile ?? "(auto)"}`,
    `  taskType: ${taskType ?? "(auto)"}`,
    `  language: ${language ?? "(auto)"}`
  ].join("\n") + "\n";
}
