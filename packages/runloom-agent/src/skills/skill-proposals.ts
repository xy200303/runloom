import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getApprovalMode } from "../approvals/policy.js";
import type {
  ApprovalPolicyConfig,
  ApprovalRequest,
  CreateRunloomSkillProposalInput,
  RunloomSkillManifestDraft,
  RunloomSkillPermissions,
  RunloomSkillProposal,
  RunloomSkillProposalChangeType,
  RunloomSkillProposalValidationResult,
  RunloomSkillRiskAssessment
} from "../types.js";
import { validateSkillDefinition } from "./skill-manifest.js";

export interface SkillProposalContext {
  runId: string;
  sessionId: string;
}

export interface CreatedSkillProposal {
  proposal: RunloomSkillProposal;
  approval?: ApprovalRequest;
}

export class SkillProposalStore {
  private readonly skillsRoot: string;
  private readonly proposalsRoot: string;

  constructor(stateDir: string) {
    this.skillsRoot = resolve(stateDir, "skills");
    this.proposalsRoot = resolve(this.skillsRoot, "proposals");
  }

  list(): RunloomSkillProposal[] {
    if (!existsSync(this.proposalsRoot)) {
      return [];
    }
    try {
      const stat = lstatSync(this.proposalsRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return [];
      }
      return readdirSync(this.proposalsRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
        .map((entry) => this.readProposal(resolve(this.proposalsRoot, entry.name)))
        .filter((proposal): proposal is RunloomSkillProposal => Boolean(proposal))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch {
      return [];
    }
  }

  save(proposal: RunloomSkillProposal): void {
    const path = resolve(this.proposalsRoot, `${proposal.id}.json`);
    if (!isPathInside(path, this.proposalsRoot)) {
      throw new Error("Skill proposal path must stay inside the proposals directory.");
    }
    writeJsonAtomic(path, {
      version: 1,
      proposal: cloneSkillProposal(proposal)
    });
  }

  installGeneratedSkill(proposal: RunloomSkillProposal): void {
    if (!proposal.manifest || proposal.instructions === undefined) {
      throw new Error(`Skill proposal is missing generated skill content: ${proposal.id}`);
    }
    const skillDir = resolve(this.skillsRoot, "generated", proposal.skillName);
    if (!isPathInside(skillDir, resolve(this.skillsRoot, "generated"))) {
      throw new Error("Generated skill path must stay inside the generated skills directory.");
    }
    writeJsonAtomic(resolve(skillDir, "skill.json"), proposal.manifest);
    writeTextAtomic(resolve(skillDir, "SKILL.md"), proposal.instructions);
  }

  private readProposal(path: string): RunloomSkillProposal | undefined {
    if (!isPathInside(path, this.proposalsRoot)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1 || !isSkillProposal(parsed.proposal)) {
        return undefined;
      }
      return cloneSkillProposal(parsed.proposal);
    } catch {
      return undefined;
    }
  }
}

export function createSkillProposal(
  input: CreateRunloomSkillProposalInput,
  context: SkillProposalContext,
  approvalPolicy: ApprovalPolicyConfig
): CreatedSkillProposal {
  const id = `skillprop_${randomUUID()}`;
  const now = new Date().toISOString();
  const changeType = normalizeChangeType(input.changeType);
  const manifest = input.manifest ? cloneManifestDraft(input.manifest) : undefined;
  const instructions = typeof input.instructions === "string" ? input.instructions : undefined;
  const skillName = sanitizeSkillName(manifest?.name ?? input.skillName ?? "generated-skill");
  const validation = validateProposal(changeType, manifest, instructions);
  const risk = assessSkillRisk(changeType, manifest);
  const mode = getApprovalMode(approvalPolicy, "skills.register");
  const approvalRequired = validation.valid && requiresApproval(mode, risk.level);
  const approvalId = approvalRequired ? `approval_${randomUUID()}` : undefined;
  const proposal: RunloomSkillProposal = {
    id,
    skillName,
    changeType,
    reason: normalizeNonEmptyText(input.reason, "Skill proposal reason is required."),
    evidence: normalizeEvidence(input.evidence),
    diff: input.diff ?? buildProposalDiff(manifest, instructions),
    validation,
    risk,
    status: validation.valid ? (approvalRequired ? "waiting_approval" : "approved") : "invalid",
    createdAt: now,
    updatedAt: now,
    runId: context.runId,
    sessionId: context.sessionId,
    manifest,
    instructions,
    approvalId,
    diagnostics: validation.valid ? undefined : [...validation.diagnostics]
  };

  const approval: ApprovalRequest | undefined = approvalRequired && approvalId
    ? {
        id: approvalId,
        runId: context.runId,
        sessionId: context.sessionId,
        scope: "skills.register",
        action: `skill.proposal:${id}`,
        risk: risk.level,
        mode,
        summary: `Runloom wants to ${changeType} skill ${skillName}.`,
        details: {
          proposalId: id,
          skillName,
          changeType,
          reason: proposal.reason,
          evidence: proposal.evidence,
          validation,
          risk,
          diff: proposal.diff
        }
      }
    : undefined;

  return { proposal, approval };
}

export function validateProposal(
  changeType: RunloomSkillProposalChangeType,
  manifest?: RunloomSkillManifestDraft,
  instructions?: string
): RunloomSkillProposalValidationResult {
  const diagnostics: string[] = [];
  if (changeType !== "create" && changeType !== "update") {
    diagnostics.push(`Skill proposal change type is not implemented yet: ${changeType}`);
    return { valid: false, diagnostics };
  }
  if (!manifest) {
    diagnostics.push("Skill proposal manifest is required.");
  }
  if (!instructions?.trim()) {
    diagnostics.push("Skill proposal SKILL.md instructions are required.");
  }
  if (manifest && instructions !== undefined) {
    const result = validateSkillDefinition({
      manifest,
      instructions,
      source: "generated"
    });
    diagnostics.push(...result.diagnostics);
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    tests: manifest?.validation.tests ? [...manifest.validation.tests] : undefined
  };
}

export function assessSkillRisk(
  changeType: RunloomSkillProposalChangeType,
  manifest?: RunloomSkillManifestDraft
): RunloomSkillRiskAssessment {
  let level: RunloomSkillRiskAssessment["level"] = changeType === "delete" ? "critical" : "high";
  const reasons = [`${changeType} changes the local skill registry`];
  const permissions = manifest?.permissions;
  if (permissions?.writeWorkspace === true) {
    level = "critical";
    reasons.push("skill requests workspace write permission");
  }
  if (permissions?.shell === true || permissions?.shell === "full_access") {
    level = "critical";
    reasons.push("skill requests unrestricted shell access");
  } else if (permissions?.shell) {
    reasons.push(`skill requests shell permission mode: ${permissions.shell}`);
  }
  if (manifest?.requiredTools?.some((tool) => tool.startsWith("mcp.") || tool.startsWith("shell."))) {
    reasons.push("skill depends on high-impact tools");
  }
  return {
    level,
    reasons
  };
}

export function cloneSkillProposal(proposal: RunloomSkillProposal): RunloomSkillProposal {
  return {
    ...proposal,
    evidence: [...proposal.evidence],
    validation: {
      ...proposal.validation,
      diagnostics: [...proposal.validation.diagnostics],
      tests: proposal.validation.tests ? [...proposal.validation.tests] : undefined
    },
    risk: {
      ...proposal.risk,
      reasons: [...proposal.risk.reasons]
    },
    manifest: proposal.manifest ? cloneManifestDraft(proposal.manifest) : undefined,
    diagnostics: proposal.diagnostics ? [...proposal.diagnostics] : undefined
  };
}

function normalizeChangeType(value: RunloomSkillProposalChangeType): RunloomSkillProposalChangeType {
  if (value === "create" || value === "update" || value === "disable" || value === "delete") {
    return value;
  }
  return "create";
}

function normalizeNonEmptyText(value: string, message: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(message);
}

function normalizeEvidence(value: string[] | undefined): string[] {
  return (value ?? []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function cloneManifestDraft(manifest: RunloomSkillManifestDraft): RunloomSkillManifestDraft {
  return {
    ...manifest,
    triggers: manifest.triggers ? [...manifest.triggers] : undefined,
    requiredTools: manifest.requiredTools ? [...manifest.requiredTools] : undefined,
    permissions: manifest.permissions ? cloneSkillPermissions(manifest.permissions) : undefined,
    validation: {
      ...manifest.validation,
      tests: manifest.validation.tests ? [...manifest.validation.tests] : undefined
    }
  };
}

function cloneSkillPermissions(permissions: RunloomSkillPermissions): RunloomSkillPermissions {
  return {
    ...permissions
  };
}

function buildProposalDiff(manifest?: RunloomSkillManifestDraft, instructions?: string): string {
  const chunks = ["--- /dev/null", "+++ skill.json", JSON.stringify(manifest ?? {}, null, 2)];
  chunks.push("--- /dev/null", "+++ SKILL.md", instructions ?? "");
  return chunks.join("\n");
}

function requiresApproval(mode: ApprovalRequest["mode"], risk: ApprovalRequest["risk"]): boolean {
  if (mode === "full_access") {
    return false;
  }
  if (mode === "ask") {
    return true;
  }
  return risk === "high" || risk === "critical";
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, JSON.stringify(value, null, 2));
}

function writeTextAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, value, "utf8");
  renameSync(tempPath, path);
}

function isSkillProposal(value: unknown): value is RunloomSkillProposal {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.skillName === "string" &&
    typeof value.changeType === "string" &&
    typeof value.reason === "string" &&
    isStringArray(value.evidence) &&
    typeof value.diff === "string" &&
    isRecord(value.validation) &&
    typeof value.validation.valid === "boolean" &&
    isStringArray(value.validation.diagnostics) &&
    isRecord(value.risk) &&
    typeof value.risk.level === "string" &&
    isStringArray(value.risk.reasons) &&
    typeof value.status === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string"
  );
}

function sanitizeSkillName(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]/gi, "-") || "generated-skill";
}

function isPathInside(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`) || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
