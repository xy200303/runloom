import { randomUUID } from "node:crypto";
import { ApprovalError, RuntimeError } from "../errors.js";
import { cloneSkillProposal, createSkillProposal, SkillProposalStore } from "./skill-proposals.js";
import { loadSkills, validateSkillDefinition } from "./skill-manifest.js";
import { selectSkillActivations } from "./skill-selector.js";
import type {
  ApprovalDecision,
  ApprovalPolicyConfig,
  ApprovalRequest,
  CreateRunloomSkillProposalInput,
  CreateRunloomSkillProposalOptions,
  ListSkillProposalsOptions,
  ModelSelectionResult,
  RunloomAuditRecord,
  RunloomEventEnvelope,
  RunloomSession,
  RunloomSkillActivation,
  RunloomSkillProposal,
  RunloomSkillSummary
} from "../types.js";

export interface SkillRuntimeOptions {
  stateDir?: string;
  getApprovalPolicy(): ApprovalPolicyConfig;
  createSession(sessionId?: string): Promise<RunloomSession>;
  saveApproval(request: ApprovalRequest): void;
  getApproval(approvalId: string): ApprovalRequest | undefined;
  getApprovalDecision(approvalId: string): ApprovalDecision | undefined;
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  getAvailableTools(): string[];
  emit(
    type: string,
    source: RunloomEventEnvelope["source"],
    runId: string,
    sessionId: string,
    payload: unknown
  ): void;
  recordAudit(input: Omit<RunloomAuditRecord, "id" | "timestamp">): void;
}

export class SkillRuntime {
  private readonly skills = new Map<string, RunloomSkillSummary>();
  private readonly skillProposals = new Map<string, RunloomSkillProposal>();
  private readonly skillProposalStore?: SkillProposalStore;

  constructor(private readonly options: SkillRuntimeOptions) {
    this.skillProposalStore = options.stateDir ? new SkillProposalStore(options.stateDir) : undefined;
  }

  loadConfigured(): void {
    this.loadSkillProposals();
    this.loadConfiguredSkills();
  }

  listSkills(): RunloomSkillSummary[] {
    return [...this.skills.values()]
      .map(cloneSkill)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  registerSkill(skill: RunloomSkillSummary): void {
    this.skills.set(skill.name, cloneSkill(skill));
  }

  async proposeSkill(
    input: CreateRunloomSkillProposalInput,
    options: CreateRunloomSkillProposalOptions = {}
  ): Promise<RunloomSkillProposal> {
    const session = await this.options.createSession(options.sessionId);
    const runId = options.runId ?? `skill_${randomUUID()}`;
    const created = createSkillProposal(
      input,
      {
        runId,
        sessionId: session.id
      },
      this.options.getApprovalPolicy()
    );
    this.saveSkillProposal(created.proposal);
    this.options.emit("skill.proposal.created", "runtime", runId, session.id, created.proposal);
    this.options.recordAudit({
      action: "skill.proposal.created",
      actor: "runtime",
      runId,
      sessionId: session.id,
      summary: `Skill proposal created: ${created.proposal.skillName}.`,
      details: {
        proposalId: created.proposal.id,
        skillName: created.proposal.skillName,
        changeType: created.proposal.changeType,
        status: created.proposal.status,
        validation: created.proposal.validation,
        risk: created.proposal.risk
      }
    });

    if (!created.proposal.validation.valid) {
      this.options.emit("skill.proposal.validation_failed", "runtime", runId, session.id, created.proposal);
      return cloneSkillProposal(created.proposal);
    }

    if (created.approval) {
      this.options.saveApproval(created.approval);
      this.options.emit("approval.requested", "approval", runId, session.id, created.approval);
      this.options.emit("skill.proposal.approval_requested", "runtime", runId, session.id, created.proposal);
      return cloneSkillProposal(created.proposal);
    }

    return this.installApprovedSkillProposal(created.proposal.id, "policy");
  }

  listSkillProposals(options: ListSkillProposalsOptions = {}): RunloomSkillProposal[] {
    const proposals = [...this.skillProposals.values()]
      .filter((proposal) => !options.status || proposal.status === options.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return takeLast(proposals, options.limit).map(cloneSkillProposal);
  }

  async approveSkillProposal(
    proposalId: string,
    decision: ApprovalDecision = { decision: "approved" }
  ): Promise<RunloomSkillProposal> {
    const proposal = this.skillProposals.get(proposalId);
    if (!proposal) {
      throw new RuntimeError(`Skill proposal not found: ${proposalId}`, {
        code: "runtime.skill_proposal_not_found",
        details: { proposalId }
      });
    }
    if (proposal.status === "installed" || proposal.status === "denied" || proposal.status === "invalid") {
      return cloneSkillProposal(proposal);
    }
    if (!proposal.approvalId) {
      return this.installApprovedSkillProposal(proposalId, "policy");
    }
    const pendingApproval = this.options.getApproval(proposal.approvalId);
    if (pendingApproval) {
      await this.options.resolveApproval(proposal.approvalId, decision);
      const updated = this.skillProposals.get(proposalId);
      return cloneSkillProposal(updated ?? proposal);
    }
    const resolvedDecision = this.options.getApprovalDecision(proposal.approvalId);
    if (!resolvedDecision) {
      throw new ApprovalError(`Skill proposal approval has not been resolved: ${proposal.approvalId}`, {
        code: "approval.not_resolved",
        details: {
          approvalId: proposal.approvalId,
          proposalId
        }
      });
    }
    await this.applyApproval(proposal.approvalId, resolvedDecision);
    const updated = this.skillProposals.get(proposalId);
    return cloneSkillProposal(updated ?? proposal);
  }

  async applyApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const proposal = [...this.skillProposals.values()].find((item) => item.approvalId === approvalId);
    if (!proposal) {
      return;
    }

    if (decision.decision === "denied") {
      const now = new Date().toISOString();
      const denied: RunloomSkillProposal = {
        ...proposal,
        status: "denied",
        deniedAt: now,
        updatedAt: now,
        diagnostics: decision.reason ? [decision.reason] : proposal.diagnostics
      };
      this.saveSkillProposal(denied);
      this.options.emit("skill.proposal.denied", "runtime", denied.runId, denied.sessionId, denied);
      this.options.recordAudit({
        action: "skill.proposal.denied",
        actor: "user",
        runId: denied.runId,
        sessionId: denied.sessionId,
        summary: `Skill proposal denied: ${denied.skillName}.`,
        details: {
          proposalId: denied.id,
          skillName: denied.skillName,
          reason: decision.reason
        }
      });
      return;
    }

    await this.installApprovedSkillProposal(proposal.id, "approval");
  }

  selectForRun(text: string, modelSelection: ModelSelectionResult): {
    activations: RunloomSkillActivation[];
    diagnostics: Array<{ skillName: string; reason: string }>;
  } {
    return selectSkillActivations({
      text,
      taskType: modelSelection.taskType,
      language: modelSelection.language,
      availableTools: this.options.getAvailableTools(),
      skills: [...this.skills.values()]
    });
  }

  buildContext(activations: RunloomSkillActivation[]): string {
    if (activations.length === 0) {
      return "";
    }

    const lines = ["Activated skills:"];
    for (const activation of activations) {
      const skill = this.skills.get(activation.skillName);
      if (!skill) {
        continue;
      }
      const version = activation.version ? `@${activation.version}` : "";
      lines.push(`- ${skill.name}${version}: ${skill.description}`);
      lines.push(`  reason: ${activation.reason}`);
      if (skill.requiredTools?.length) {
        lines.push(`  required tools: ${skill.requiredTools.join(", ")}`);
      }
      const instructions = truncateForBudget(skill.instructions ?? "", activation.contextBudgetTokens);
      if (instructions) {
        lines.push("  instructions:");
        for (const line of instructions.split(/\r?\n/)) {
          if (line.trim()) {
            lines.push(`    ${line}`);
          }
        }
      }
    }
    return lines.join("\n");
  }

  private loadSkillProposals(): void {
    const proposals = this.skillProposalStore?.list() ?? [];
    for (const proposal of proposals) {
      this.skillProposals.set(proposal.id, cloneSkillProposal(proposal));
    }
    if (proposals.length > 0) {
      this.options.emit("skill.proposals.loaded", "runtime", "skills", "global", {
        count: proposals.length,
        waitingApproval: proposals.filter((proposal) => proposal.status === "waiting_approval").length,
        installed: proposals.filter((proposal) => proposal.status === "installed").length,
        invalid: proposals.filter((proposal) => proposal.status === "invalid").length
      });
    }
  }

  private saveSkillProposal(proposal: RunloomSkillProposal): void {
    const cloned = cloneSkillProposal(proposal);
    this.skillProposals.set(cloned.id, cloned);
    this.skillProposalStore?.save(cloned);
  }

  private async installApprovedSkillProposal(proposalId: string, actor: "approval" | "policy"): Promise<RunloomSkillProposal> {
    const proposal = this.skillProposals.get(proposalId);
    if (!proposal) {
      throw new RuntimeError(`Skill proposal not found: ${proposalId}`, {
        code: "runtime.skill_proposal_not_found",
        details: { proposalId }
      });
    }
    if (!proposal.validation.valid || !proposal.manifest || proposal.instructions === undefined) {
      throw new RuntimeError(`Skill proposal is not valid for installation: ${proposalId}`, {
        code: "runtime.skill_proposal_invalid",
        details: {
          proposalId,
          validation: proposal.validation
        }
      });
    }

    const validation = validateSkillDefinition({
      manifest: proposal.manifest,
      instructions: proposal.instructions,
      source: "generated"
    });
    if (!validation.skill) {
      const now = new Date().toISOString();
      const invalid: RunloomSkillProposal = {
        ...proposal,
        status: "invalid",
        updatedAt: now,
        validation: {
          ...proposal.validation,
          valid: false,
          diagnostics: validation.diagnostics
        },
        diagnostics: validation.diagnostics
      };
      this.saveSkillProposal(invalid);
      this.options.emit("skill.proposal.validation_failed", "runtime", invalid.runId, invalid.sessionId, invalid);
      throw new RuntimeError(`Skill proposal failed validation: ${proposalId}`, {
        code: "runtime.skill_proposal_invalid",
        details: {
          proposalId,
          diagnostics: validation.diagnostics
        }
      });
    }

    this.skillProposalStore?.installGeneratedSkill(proposal);
    const generatedSkill = cloneSkill(validation.skill);
    this.skills.set(generatedSkill.name, generatedSkill);
    const now = new Date().toISOString();
    const installed: RunloomSkillProposal = {
      ...proposal,
      skillName: generatedSkill.name,
      status: "installed",
      validation: {
        ...proposal.validation,
        valid: true,
        diagnostics: []
      },
      approvedAt: proposal.approvedAt ?? now,
      installedAt: now,
      updatedAt: now,
      diagnostics: undefined
    };
    this.saveSkillProposal(installed);
    this.options.emit("skill.proposal.approved", "runtime", installed.runId, installed.sessionId, installed);
    this.options.emit("skill.generated", "runtime", installed.runId, installed.sessionId, {
      proposalId: installed.id,
      skill: generatedSkill,
      persisted: Boolean(this.skillProposalStore),
      actor
    });
    this.options.emit("skill.installed", "runtime", installed.runId, installed.sessionId, {
      proposalId: installed.id,
      skill: generatedSkill,
      source: "generated",
      actor
    });
    this.options.recordAudit({
      action: "skill.generated",
      actor: actor === "approval" ? "user" : "runtime",
      runId: installed.runId,
      sessionId: installed.sessionId,
      summary: `Generated skill installed: ${generatedSkill.name}.`,
      details: {
        proposalId: installed.id,
        skillName: generatedSkill.name,
        version: generatedSkill.version,
        persisted: Boolean(this.skillProposalStore),
        contentHash: generatedSkill.contentHash
      }
    });
    return cloneSkillProposal(installed);
  }

  private loadConfiguredSkills(): void {
    if (!this.options.stateDir) {
      return;
    }
    const loaded = loadSkills({ stateDir: this.options.stateDir });
    for (const skill of loaded.skills) {
      this.skills.set(skill.name, cloneSkill(skill));
    }
    if (loaded.skills.length > 0 || loaded.diagnostics.length > 0) {
      this.options.emit("skills.loaded", "runtime", "skills", "global", {
        count: loaded.skills.length,
        enabled: loaded.skills.filter((skill) => skill.enabled).length,
        disabled: loaded.skills.filter((skill) => !skill.enabled).length,
        diagnostics: loaded.diagnostics
      });
    }
    for (const diagnostic of loaded.diagnostics) {
      this.options.emit("skills.diagnostic", "runtime", "skills", "global", diagnostic);
    }
  }
}

function cloneSkill(skill: RunloomSkillSummary): RunloomSkillSummary {
  return {
    ...skill,
    triggers: skill.triggers ? [...skill.triggers] : undefined,
    requiredTools: skill.requiredTools ? [...skill.requiredTools] : undefined,
    permissions: skill.permissions ? { ...skill.permissions } : undefined,
    validation: skill.validation
      ? {
          ...skill.validation,
          tests: skill.validation.tests ? [...skill.validation.tests] : undefined
        }
      : undefined,
    diagnostics: skill.diagnostics ? [...skill.diagnostics] : undefined
  };
}

function takeLast<TItem>(items: TItem[], limit?: number): TItem[] {
  if (!limit || limit >= items.length) {
    return items;
  }
  return items.slice(items.length - limit);
}

function truncateForBudget(value: string, budgetTokens: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const maxChars = Math.max(500, budgetTokens * 4);
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...[truncated]` : trimmed;
}
