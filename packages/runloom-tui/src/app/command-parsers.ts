import { APPROVAL_MODES, PERMISSION_SCOPES } from "runloom-agent";
import type {
  ApprovalDecision,
  ApprovalMode,
  PermissionScope
} from "runloom-agent";
import {
  DEFAULT_PANEL_LINES,
  type ActivityCategory,
  type ApprovalShortcut,
  type ScrollAction,
  type TuiPanel,
  type TuiShortcut
} from "./view-model.js";

export function parseVerificationCommand(command: string): { command: string; args: string[] } {
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

export function parseApprovalMode(value: string | undefined): ApprovalMode | undefined {
  return APPROVAL_MODES.includes(value as ApprovalMode) ? (value as ApprovalMode) : undefined;
}

export function parsePermissionScope(value: string): PermissionScope | undefined {
  return PERMISSION_SCOPES.includes(value as PermissionScope) ? (value as PermissionScope) : undefined;
}

export function parsePanel(value: string): TuiPanel | undefined {
  if (value === "status" || value === "transcript" || value === "todo" || value === "activity") {
    return value;
  }
  return undefined;
}

export function isScrollAction(value: string): value is ScrollAction {
  return value === "up" || value === "down" || value === "top" || value === "bottom";
}

export function parseScrollAmount(value: string | undefined): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_PANEL_LINES;
}

export function parseApprovalDecisionCommand(
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

export function isSelectedApprovalTarget(value: string): boolean {
  return value === "selected" || value === "current" || value === ".";
}

export function parseActivityCategory(value: string): ActivityCategory | undefined {
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
  if (value === "a2a") {
    return "a2a";
  }
  if (value === "external" || value === "externals" || value === "external_agent" || value === "external_agents") {
    return "external";
  }
  return undefined;
}

export function normalizeShortcut(value: string): TuiShortcut | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "ctrl+l" || normalized === "control+l") {
    return "ctrl+l";
  }
  if (normalized === "esc" || normalized === "escape") {
    return "esc";
  }
  if (normalized === "enter" || normalized === "return") {
    return "enter";
  }
  if (normalized === "tab") {
    return "tab";
  }
  if (normalized === "shift+tab" || normalized === "shift-tab" || normalized === "backtab") {
    return "shift+tab";
  }
  if (normalized === "pgup" || normalized === "pageup") {
    return "pgup";
  }
  if (normalized === "pgdn" || normalized === "pagedown") {
    return "pgdn";
  }
  if (normalized === "home") {
    return "home";
  }
  if (normalized === "end") {
    return "end";
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
  if (normalized === "alt+4" || normalized === "option+4") {
    return "alt+4";
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

export function isApprovalShortcut(shortcut: TuiShortcut): shortcut is ApprovalShortcut {
  return shortcut === "n" || shortcut === "p" || shortcut === "v" || shortcut === "a" || shortcut === "s" || shortcut === "d";
}

export function panelForShortcut(shortcut: TuiShortcut): TuiPanel | undefined {
  switch (shortcut) {
    case "alt+1":
      return "transcript";
    case "alt+2":
      return "todo";
    case "alt+3":
      return "activity";
    case "alt+4":
      return "status";
    default:
      return undefined;
  }
}
