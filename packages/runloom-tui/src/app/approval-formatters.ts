import { APPROVAL_MODES, PERMISSION_SCOPES } from "runloom-agent";
import type { ApprovalPolicyConfig, ApprovalRequest } from "runloom-agent";
import { formatUnknownValue, indentBlock } from "./value-formatters.js";

export function formatApprovalRequest(payload: unknown): string {
  const request = payload as { id?: string; scope?: string; mode?: string; summary?: string };
  return `${request.id ?? "unknown"} scope=${request.scope ?? "unknown"} mode=${request.mode ?? "unknown"} ${request.summary ?? ""}`;
}

export function formatApprovalResolution(payload: unknown): string {
  const resolution = payload as { approvalId?: string; decision?: { decision?: string } };
  return `${resolution.approvalId ?? "unknown"} decision=${resolution.decision?.decision ?? "unknown"}`;
}

export function formatWaitingApproval(payload: unknown): string {
  const waiting = payload as { approvalId?: string };
  return waiting.approvalId ? `approval=${waiting.approvalId}` : "";
}

export function formatApprovalPolicy(policy: ApprovalPolicyConfig): string {
  const lines = [`Approval policy: default=${policy.defaultMode}`];
  for (const [scope, mode] of Object.entries(policy.scopes)) {
    lines.push(`  ${scope}: ${mode}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatApprovalPolicyPanel(policy: ApprovalPolicyConfig): string {
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

export function formatApprovals(approvals: ApprovalRequest[], focusedApprovalId?: string): string {
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

export function formatApprovalDetail(approval: ApprovalRequest): string {
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
