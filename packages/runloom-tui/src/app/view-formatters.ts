import type { RunloomSession, RunloomTodoItem } from "runloom-agent";
import { formatActivityCommandHelp } from "./command-formatters.js";
import { formatUnknownValue, indentBlock } from "./value-formatters.js";
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
export { formatUnknownValue, indentBlock } from "./value-formatters.js";
import {
  COMPOSITE_PANEL_LINES,
  DEFAULT_PANEL_LINES,
  clamp,
  visibleSlice,
  type ActivityCategory,
  type TuiActivityRecord,
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

export function formatActivityView(
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

export function formatActivityDetail(
  records: TuiActivityRecord[],
  allRecords: TuiActivityRecord[],
  category?: ActivityCategory,
  targetText?: string,
  currentIndex?: number
): string {
  const title = category ? `Activity Detail (${category})` : "Activity Detail";
  if (records.length === 0) {
    return `${title}: (none)\n`;
  }

  const resolved = resolveActivityDetailTarget(records, targetText, currentIndex);
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

export function resolveActivityDetailTarget(
  records: TuiActivityRecord[],
  targetText?: string,
  currentIndex?: number
): { record: TuiActivityRecord; index: number } | { error: string } {
  const target = targetText?.trim().toLowerCase();
  if (!target || target === "latest" || target === "last") {
    const index = records.length - 1;
    return { record: records[index], index };
  }

  if (target === "current" || target === "selected" || target === "." || target === "visible") {
    const index = clamp(currentIndex ?? records.length - 1, 0, records.length - 1);
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

export function formatPanelHeader(name: string, total: number, start: number, count: number, scrollOffset: number): string {
  if (total <= count && scrollOffset === 0) {
    return `${name}:`;
  }
  const first = count > 0 ? start + 1 : 0;
  const last = start + count;
  const offset = scrollOffset > 0 ? ` offset=${scrollOffset}` : "";
  return `${name}: showing ${first}-${last} of ${total}${offset}`;
}
