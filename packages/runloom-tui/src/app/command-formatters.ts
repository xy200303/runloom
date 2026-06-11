import { PERMISSION_SCOPES } from "runloom-agent";
import type { ApprovalDecision } from "runloom-agent";
import type { TuiShortcut } from "./view-model.js";

export function formatSessionCommandHelp(): string {
  return [
    "Usage:",
    "  /session",
    "  /session list",
    "  /session switch <session-id>"
  ].join("\n") + "\n";
}

export function formatModelCommandHelp(): string {
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

export function formatApprovalCommandHelp(): string {
  return [
    "Usage:",
    "  /approval",
    "  /approval default <full_access|ask|auto_decide>",
    "  /approval <scope> <full_access|ask|auto_decide>",
    formatScopeList().trimEnd()
  ].join("\n") + "\n";
}

export function formatPermissionsCommandHelp(): string {
  return [
    "Usage:",
    "  /permissions",
    "  /permissions set default <full_access|ask|auto_decide>",
    "  /permissions set <scope> <full_access|ask|auto_decide>"
  ].join("\n") + "\n";
}

export function formatApprovalsCommandHelp(): string {
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

export function formatApprovalDecisionCommandHelp(): string {
  return [
    "Usage:",
    "  /approve <approval-id|selected> [once|session|workspace|global] [mode=<full_access|ask|auto_decide>]",
    "  /deny <approval-id|selected> [reason]"
  ].join("\n") + "\n";
}

export function formatScopeList(): string {
  return `Scopes: ${PERMISSION_SCOPES.join(", ")}\n`;
}

export function formatApprovalDecision(decision: ApprovalDecision): string {
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

export function formatFocusCommandHelp(): string {
  return "Usage: /focus <status|transcript|todo|activity>\n";
}

export function formatScrollCommandHelp(): string {
  return "Usage: /scroll <up|down|top|bottom> [lines]\n";
}

export function formatActivityCommandHelp(): string {
  return [
    "Usage:",
    "  /activity [all|runs|models|todos|coding|tools|approvals|reviews|skills|mcp|a2a|external] [up|down|top|bottom] [lines]",
    "  /activity view [all|runs|models|todos|coding|tools|approvals|reviews|skills|mcp|a2a|external] [index|latest|current]",
    "  /activity <filter> view [index|latest|current]"
  ].join("\n") + "\n";
}

export function formatShortcutCommandHelp(): string {
  return "Usage: /key <ctrl+l|esc|enter|tab|shift+tab|pgup|pgdn|home|end|alt+1|alt+2|alt+3|alt+4|n|p|v|a|s|d> [deny-reason]\n";
}

export function formatShortcutLabel(shortcut: TuiShortcut): string {
  switch (shortcut) {
    case "ctrl+l":
      return "Ctrl+L";
    case "esc":
      return "Esc";
    case "enter":
      return "Enter";
    case "tab":
      return "Tab";
    case "shift+tab":
      return "Shift+Tab";
    case "pgup":
      return "PgUp";
    case "pgdn":
      return "PgDn";
    case "home":
      return "Home";
    case "end":
      return "End";
    case "alt+1":
      return "Alt+1";
    case "alt+2":
      return "Alt+2";
    case "alt+3":
      return "Alt+3";
    case "alt+4":
      return "Alt+4";
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
