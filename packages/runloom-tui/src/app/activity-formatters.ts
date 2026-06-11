import { formatActivityCommandHelp } from "./command-formatters.js";
import { formatPanelHeader } from "./panel-formatters.js";
import { formatUnknownValue, indentBlock } from "./value-formatters.js";
import { DEFAULT_PANEL_LINES, clamp, visibleSlice, type ActivityCategory, type TuiActivityRecord } from "./view-model.js";

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
