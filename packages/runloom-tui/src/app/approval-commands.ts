import type { Writable } from "node:stream";
import type {
  ApprovalRequest,
  RunloomAgent
} from "runloom-agent";
import {
  isSelectedApprovalTarget,
  parseApprovalDecisionCommand,
  parseApprovalMode,
  parsePermissionScope
} from "./command-parsers.js";
import {
  formatApprovalCommandHelp,
  formatApprovalDecision,
  formatApprovalDecisionCommandHelp,
  formatApprovalDetail,
  formatApprovalPolicyPanel,
  formatApprovals,
  formatApprovalsCommandHelp,
  formatPermissionsCommandHelp,
  formatScopeList
} from "./view-formatters.js";
import type { ApprovalShortcut } from "./view-model.js";

export interface TuiApprovalCommandControllerOptions {
  agent: RunloomAgent;
  output: Writable;
}

export class TuiApprovalCommandController {
  private focusedApprovalId?: string;

  constructor(private readonly options: TuiApprovalCommandControllerOptions) {}

  clearFocus(): void {
    this.focusedApprovalId = undefined;
  }

  async handleApprovalCommand(command: string): Promise<void> {
    const output = this.options.output;
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

  async handlePermissionsCommand(command: string): Promise<void> {
    const output = this.options.output;
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

  async handleApprovalsCommand(command: string): Promise<void> {
    const output = this.options.output;
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

  async handleApprovalDecisionCommand(command: string): Promise<void> {
    const output = this.options.output;
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

  async handleShortcut(shortcut: ApprovalShortcut, args: string[]): Promise<void> {
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
}
