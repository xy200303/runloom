import type { RunloomTodoItem } from "runloom-agent";

export const MAX_VIEW_LINES = 200;
export const DEFAULT_PANEL_LINES = 20;
export const COMPOSITE_PANEL_LINES = 8;
export const FOCUS_PANELS: TuiPanel[] = ["status", "transcript", "todo", "activity"];

export type TuiPanel = "status" | "transcript" | "todo" | "activity";
export type ScrollAction = "up" | "down" | "top" | "bottom";
export type TuiShortcut =
  | "ctrl+l"
  | "esc"
  | "enter"
  | "tab"
  | "shift+tab"
  | "pgup"
  | "pgdn"
  | "home"
  | "end"
  | "alt+1"
  | "alt+2"
  | "alt+3"
  | "alt+4"
  | "n"
  | "p"
  | "v"
  | "a"
  | "s"
  | "d";
export type ApprovalShortcut = Extract<TuiShortcut, "n" | "p" | "v" | "a" | "s" | "d">;
export type ActivityCategory =
  | "runs"
  | "models"
  | "todos"
  | "coding"
  | "tools"
  | "approvals"
  | "reviews"
  | "skills"
  | "mcp"
  | "a2a"
  | "external";

export interface TuiViewContext {
  activeSessionId?: string;
  activeRunId?: string;
  activeModel?: string;
  activeProfile?: string;
  activeTaskType?: string;
  activeLanguage?: string;
}

export interface TuiViewState {
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

export interface TuiActivityRecord {
  category: ActivityCategory;
  line: string;
  eventType?: string;
  runId?: string;
  sessionId?: string;
  source?: string;
  timestamp?: string;
  payload?: unknown;
}

export function visibleSlice<TItem>(
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

export function pushCapped<TItem>(items: TItem[], item: TItem): void {
  items.push(item);
  if (items.length > MAX_VIEW_LINES) {
    items.splice(0, items.length - MAX_VIEW_LINES);
  }
}

export function truncateText(value: string, maxLength = 300): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
