import { randomUUID } from "node:crypto";
import { errorToLogDetails, type RunloomLogInput } from "../observability/logger.js";
import { redactValue } from "../security/redaction.js";
import type {
  RunloomDeliverySummary,
  RunloomDiffRecord,
  RunloomDiffSummary,
  RunloomEditPlan,
  RunloomEventEnvelope,
  RunloomReviewFindings,
  ToolExecutionResult
} from "../types.js";

export interface RunArtifactRecorderOptions {
  workspace: string;
  showDiff?(diff: RunloomDiffSummary): Promise<void> | void;
  appendDiffRecord(record: RunloomDiffRecord): void;
  appendEditPlan(plan: RunloomEditPlan): void;
  appendDeliverySummary(summary: RunloomDeliverySummary): void;
  appendReviewFindings(findings: RunloomReviewFindings): void;
  emit(
    type: string,
    source: RunloomEventEnvelope["source"],
    runId: string,
    sessionId: string,
    payload: unknown
  ): void;
  log(input: RunloomLogInput): void;
}

export class RunArtifactRecorder {
  constructor(private readonly options: RunArtifactRecorderOptions) {}

  async recordToolResult(toolName: string, result: ToolExecutionResult): Promise<void> {
    await this.recordDiffResult(toolName, result);
    this.recordEditPlanResult(toolName, result);
    this.recordDeliverySummaryResult(toolName, result);
    this.recordReviewFindingsResult(toolName, result);
  }

  private async recordDiffResult(toolName: string, result: ToolExecutionResult): Promise<void> {
    if (result.status !== "completed" || !isRunloomDiffSummary(result.output)) {
      return;
    }

    const diff = redactValue(cloneDiffSummary(result.output), { workspace: this.options.workspace });
    const record: RunloomDiffRecord = {
      id: `diff_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      runId: result.runId,
      sessionId: result.sessionId,
      toolName,
      diff,
      displayed: false
    };

    if (this.options.showDiff) {
      try {
        await this.options.showDiff(cloneDiffSummary(diff));
        record.displayed = true;
      } catch (error) {
        record.displayError = error instanceof Error ? error.message : String(error);
        this.options.log({
          level: "warn",
          source: "diff",
          code: "diff.display_failed",
          message: "Diff adapter failed to display a diff record.",
          runId: result.runId,
          sessionId: result.sessionId,
          details: {
            toolName,
            error: errorToLogDetails(error)
          }
        });
      }
    }

    const safeRecord = redactValue(record, { workspace: this.options.workspace });
    this.options.appendDiffRecord(safeRecord);
    this.options.emit("diff.recorded", "diff", result.runId, result.sessionId, safeRecord);
  }

  private recordEditPlanResult(toolName: string, result: ToolExecutionResult): void {
    if (toolName !== "edit.plan" || result.status !== "completed" || !isRunloomEditPlan(result.output)) {
      return;
    }

    const plan = redactValue(cloneEditPlan(result.output), { workspace: this.options.workspace });
    this.options.appendEditPlan(plan);
    this.options.emit("edit.plan.created", "coding", result.runId, result.sessionId, plan);
  }

  private recordDeliverySummaryResult(toolName: string, result: ToolExecutionResult): void {
    if (toolName !== "delivery.summary" || result.status !== "completed" || !isRunloomDeliverySummary(result.output)) {
      return;
    }

    const summary = redactValue(cloneDeliverySummary(result.output), { workspace: this.options.workspace });
    this.options.appendDeliverySummary(summary);
    this.options.emit("delivery.summary.created", "coding", result.runId, result.sessionId, summary);
  }

  private recordReviewFindingsResult(toolName: string, result: ToolExecutionResult): void {
    if (toolName !== "review.findings" || result.status !== "completed" || !isRunloomReviewFindings(result.output)) {
      return;
    }

    const findings = redactValue(cloneReviewFindings(result.output), { workspace: this.options.workspace });
    this.options.appendReviewFindings(findings);
    this.options.emit("review.findings.created", "coding", result.runId, result.sessionId, findings);
  }
}

export function cloneDiffRecord(record: RunloomDiffRecord): RunloomDiffRecord {
  return {
    ...record,
    diff: cloneDiffSummary(record.diff)
  };
}

export function cloneEditPlan(plan: RunloomEditPlan): RunloomEditPlan {
  return {
    ...plan,
    targetFiles: [...plan.targetFiles],
    risks: [...plan.risks],
    verificationCommands: [...plan.verificationCommands]
  };
}

export function cloneDeliverySummary(summary: RunloomDeliverySummary): RunloomDeliverySummary {
  return {
    ...summary,
    modifiedFiles: [...summary.modifiedFiles],
    coreChanges: [...summary.coreChanges],
    verificationResults: summary.verificationResults.map((result) => ({ ...result })),
    failedItems: [...summary.failedItems],
    remainingRisks: [...summary.remainingRisks]
  };
}

export function cloneReviewFindings(findings: RunloomReviewFindings): RunloomReviewFindings {
  return {
    ...findings,
    reviewedFiles: [...findings.reviewedFiles],
    findings: findings.findings.map((finding) => ({
      ...finding,
      location: finding.location ? { ...finding.location } : undefined,
      evidence: finding.evidence ? [...finding.evidence] : undefined
    }))
  };
}

function cloneDiffSummary(diff: RunloomDiffSummary): RunloomDiffSummary {
  return {
    filesChanged: [...diff.filesChanged],
    additions: diff.additions,
    deletions: diff.deletions,
    patch: diff.patch
  };
}

function isRunloomDiffSummary(value: unknown): value is RunloomDiffSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { filesChanged?: unknown }).filesChanged) &&
    (value as { filesChanged: unknown[] }).filesChanged.every((item) => typeof item === "string")
  );
}

function isRunloomEditPlan(value: unknown): value is RunloomEditPlan {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const plan = value as Partial<RunloomEditPlan>;
  return (
    typeof plan.id === "string" &&
    typeof plan.runId === "string" &&
    typeof plan.sessionId === "string" &&
    plan.status === "proposed" &&
    typeof plan.goal === "string" &&
    isStringArray(plan.targetFiles) &&
    isStringArray(plan.risks) &&
    isStringArray(plan.verificationCommands) &&
    typeof plan.createdAt === "string" &&
    typeof plan.updatedAt === "string"
  );
}

function isRunloomDeliverySummary(value: unknown): value is RunloomDeliverySummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const summary = value as Partial<RunloomDeliverySummary>;
  return (
    typeof summary.id === "string" &&
    typeof summary.runId === "string" &&
    typeof summary.sessionId === "string" &&
    typeof summary.createdAt === "string" &&
    isStringArray(summary.modifiedFiles) &&
    isStringArray(summary.coreChanges) &&
    isVerificationResultArray(summary.verificationResults) &&
    isStringArray(summary.failedItems) &&
    isStringArray(summary.remainingRisks)
  );
}

function isRunloomReviewFindings(value: unknown): value is RunloomReviewFindings {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const findings = value as Partial<RunloomReviewFindings>;
  return (
    typeof findings.id === "string" &&
    typeof findings.runId === "string" &&
    typeof findings.sessionId === "string" &&
    typeof findings.createdAt === "string" &&
    isReviewFindingArray(findings.findings) &&
    isStringArray(findings.reviewedFiles) &&
    (findings.summary === undefined || typeof findings.summary === "string")
  );
}

function isVerificationResultArray(value: unknown): value is RunloomDeliverySummary["verificationResults"] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== "object" || item === null) {
        return false;
      }
      const result = item as Partial<RunloomDeliverySummary["verificationResults"][number]>;
      return (
        typeof result.command === "string" &&
        (result.status === "passed" || result.status === "failed" || result.status === "skipped") &&
        (result.exitCode === undefined || typeof result.exitCode === "number") &&
        (result.durationMs === undefined || typeof result.durationMs === "number") &&
        (result.summary === undefined || typeof result.summary === "string")
      );
    })
  );
}

const REVIEW_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const REVIEW_CATEGORIES = new Set([
  "bug",
  "regression",
  "security",
  "performance",
  "maintainability",
  "test_gap",
  "api_risk",
  "other"
]);

function isReviewFindingArray(value: unknown): value is RunloomReviewFindings["findings"] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== "object" || item === null) {
        return false;
      }
      const finding = item as Partial<RunloomReviewFindings["findings"][number]>;
      return (
        typeof finding.severity === "string" &&
        REVIEW_SEVERITIES.has(finding.severity) &&
        typeof finding.title === "string" &&
        typeof finding.description === "string" &&
        (finding.category === undefined ||
          (typeof finding.category === "string" && REVIEW_CATEGORIES.has(finding.category))) &&
        (finding.location === undefined || isReviewLocation(finding.location)) &&
        (finding.evidence === undefined || isStringArray(finding.evidence)) &&
        (finding.recommendation === undefined || typeof finding.recommendation === "string")
      );
    })
  );
}

function isReviewLocation(value: unknown): value is RunloomReviewFindings["findings"][number]["location"] {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const location = value as NonNullable<RunloomReviewFindings["findings"][number]["location"]>;
  return (
    typeof location.path === "string" &&
    (location.line === undefined || typeof location.line === "number") &&
    (location.column === undefined || typeof location.column === "number") &&
    (location.endLine === undefined || typeof location.endLine === "number") &&
    (location.endColumn === undefined || typeof location.endColumn === "number")
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
