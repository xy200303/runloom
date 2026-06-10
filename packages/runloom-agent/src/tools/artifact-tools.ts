import { randomUUID } from "node:crypto";
import type {
  CodeDeliverySummary,
  CodeEditPlan,
  CodeReviewFinding,
  CodeReviewFindings,
  RunloomDeliverySummary,
  RunloomDeliveryVerificationResult,
  RunloomEditPlan,
  RunloomReviewFindingCategory,
  RunloomReviewFindingSeverity,
  RunloomReviewFindings,
  RunloomReviewLocation,
  ToolDefinition
} from "../types.js";

export function createEditPlanTool(): ToolDefinition<CodeEditPlan, RunloomEditPlan> {
  return {
    name: "edit.plan",
    description: "Record a code edit plan before high-risk code modifications.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        targetFiles: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
        verificationCommands: { type: "array", items: { type: "string" } },
        reason: { type: "string" }
      },
      required: ["goal", "targetFiles", "risks", "verificationCommands"],
      additionalProperties: false
    },
    permissions: [],
    async execute(input, context) {
      // Tool inputs can come directly from a model, so normalize before creating durable trace data.
      const now = new Date().toISOString();
      return {
        id: `editplan_${randomUUID()}`,
        runId: context.runId,
        sessionId: context.sessionId,
        status: "proposed",
        goal: requireNonEmptyString(input.goal, "goal"),
        targetFiles: requireNonEmptyStringArray(input.targetFiles, "targetFiles"),
        risks: requireNonEmptyStringArray(input.risks, "risks"),
        verificationCommands: requireNonEmptyStringArray(input.verificationCommands, "verificationCommands"),
        reason: input.reason === undefined ? undefined : requireNonEmptyString(input.reason, "reason"),
        createdAt: now,
        updatedAt: now
      };
    }
  };
}

export function createDeliverySummaryTool(): ToolDefinition<CodeDeliverySummary, RunloomDeliverySummary> {
  return {
    name: "delivery.summary",
    description: "Record the final delivery summary for a coding task.",
    inputSchema: {
      type: "object",
      properties: {
        modifiedFiles: { type: "array", items: { type: "string" } },
        coreChanges: { type: "array", items: { type: "string" } },
        verificationResults: {
          type: "array",
          items: {
            type: "object",
            properties: {
              command: { type: "string" },
              status: { type: "string", enum: ["passed", "failed", "skipped"] },
              exitCode: { type: "number" },
              durationMs: { type: "number" },
              summary: { type: "string" }
            },
            required: ["command", "status"],
            additionalProperties: false
          }
        },
        failedItems: { type: "array", items: { type: "string" } },
        remainingRisks: { type: "array", items: { type: "string" } },
        notes: { type: "string" }
      },
      required: ["modifiedFiles", "coreChanges", "verificationResults", "failedItems", "remainingRisks"],
      additionalProperties: false
    },
    permissions: [],
    async execute(input, context) {
      const now = new Date().toISOString();
      return {
        id: `delivery_${randomUUID()}`,
        runId: context.runId,
        sessionId: context.sessionId,
        modifiedFiles: requireStringArray(input.modifiedFiles, "modifiedFiles"),
        coreChanges: requireStringArray(input.coreChanges, "coreChanges"),
        verificationResults: requireVerificationResults(input.verificationResults),
        failedItems: requireStringArray(input.failedItems, "failedItems"),
        remainingRisks: requireStringArray(input.remainingRisks, "remainingRisks"),
        notes: input.notes === undefined ? undefined : requireNonEmptyString(input.notes, "notes"),
        createdAt: now
      };
    }
  };
}

export function createReviewFindingsTool(): ToolDefinition<CodeReviewFindings, RunloomReviewFindings> {
  return {
    name: "review.findings",
    description: "Record structured code review findings, including an explicit empty set when no issues are found.",
    inputSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
              title: { type: "string" },
              description: { type: "string" },
              category: {
                type: "string",
                enum: ["bug", "regression", "security", "performance", "maintainability", "test_gap", "api_risk", "other"]
              },
              location: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  line: { type: "number" },
                  column: { type: "number" },
                  endLine: { type: "number" },
                  endColumn: { type: "number" }
                },
                required: ["path"],
                additionalProperties: false
              },
              evidence: { type: "array", items: { type: "string" } },
              recommendation: { type: "string" }
            },
            required: ["severity", "title", "description"],
            additionalProperties: false
          }
        },
        reviewedFiles: { type: "array", items: { type: "string" } },
        summary: { type: "string" }
      },
      required: ["findings", "reviewedFiles"],
      additionalProperties: false
    },
    permissions: [],
    async execute(input, context) {
      return {
        id: `review_${randomUUID()}`,
        runId: context.runId,
        sessionId: context.sessionId,
        findings: requireReviewFindings(input.findings),
        reviewedFiles: requireReviewStringArray(input.reviewedFiles, "reviewedFiles"),
        summary: input.summary === undefined ? undefined : requireReviewNonEmptyString(input.summary, "summary"),
        createdAt: new Date().toISOString()
      };
    }
  };
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`edit.plan requires a non-empty ${fieldName}.`);
  }
  return value.trim();
}

function requireNonEmptyStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`edit.plan requires ${fieldName} to be a string array.`);
  }

  const normalized = value.map((item) => requireNonEmptyString(item, fieldName));
  if (normalized.length === 0) {
    throw new Error(`edit.plan requires at least one ${fieldName} entry.`);
  }
  return normalized;
}

function requireStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`delivery.summary requires ${fieldName} to be a string array.`);
  }
  return value.map((item) => requireNonEmptyString(item, fieldName));
}

function requireVerificationResults(value: unknown): RunloomDeliveryVerificationResult[] {
  if (!Array.isArray(value)) {
    throw new Error("delivery.summary requires verificationResults to be an array.");
  }

  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("delivery.summary requires each verification result to be an object.");
    }
    const result = item as Partial<RunloomDeliveryVerificationResult>;
    if (!isVerificationStatus(result.status)) {
      throw new Error("delivery.summary verification result status must be passed, failed, or skipped.");
    }
    return {
      command: requireNonEmptyString(result.command, "verificationResults.command"),
      status: result.status,
      exitCode: result.exitCode === undefined ? undefined : requireFiniteNumber(result.exitCode, "verificationResults.exitCode"),
      durationMs: result.durationMs === undefined ? undefined : requireFiniteNumber(result.durationMs, "verificationResults.durationMs"),
      summary: result.summary === undefined ? undefined : requireNonEmptyString(result.summary, "verificationResults.summary")
    };
  });
}

function isVerificationStatus(value: unknown): value is RunloomDeliveryVerificationResult["status"] {
  return value === "passed" || value === "failed" || value === "skipped";
}

const REVIEW_FINDING_SEVERITIES = new Set<RunloomReviewFindingSeverity>(["critical", "high", "medium", "low", "info"]);
const REVIEW_FINDING_CATEGORIES = new Set<RunloomReviewFindingCategory>([
  "bug",
  "regression",
  "security",
  "performance",
  "maintainability",
  "test_gap",
  "api_risk",
  "other"
]);

function requireReviewFindings(value: unknown): CodeReviewFinding[] {
  if (!Array.isArray(value)) {
    throw new Error("review.findings requires findings to be an array.");
  }

  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("review.findings requires each finding to be an object.");
    }
    const finding = item as Partial<CodeReviewFinding>;
    if (!isReviewSeverity(finding.severity)) {
      throw new Error("review.findings severity must be critical, high, medium, low, or info.");
    }
    if (finding.category !== undefined && !isReviewCategory(finding.category)) {
      throw new Error(
        "review.findings category must be bug, regression, security, performance, maintainability, test_gap, api_risk, or other."
      );
    }
    return {
      severity: finding.severity,
      title: requireReviewNonEmptyString(finding.title, "title"),
      description: requireReviewNonEmptyString(finding.description, "description"),
      category: finding.category,
      location: finding.location === undefined ? undefined : requireReviewLocation(finding.location),
      evidence: finding.evidence === undefined ? undefined : requireReviewStringArray(finding.evidence, "evidence"),
      recommendation:
        finding.recommendation === undefined
          ? undefined
          : requireReviewNonEmptyString(finding.recommendation, "recommendation")
    };
  });
}

function requireReviewLocation(value: unknown): RunloomReviewLocation {
  if (typeof value !== "object" || value === null) {
    throw new Error("review.findings requires location to be an object.");
  }
  const location = value as Partial<RunloomReviewLocation>;
  return {
    path: requireReviewNonEmptyString(location.path, "location.path"),
    line: location.line === undefined ? undefined : requirePositiveInteger(location.line, "location.line"),
    column: location.column === undefined ? undefined : requirePositiveInteger(location.column, "location.column"),
    endLine: location.endLine === undefined ? undefined : requirePositiveInteger(location.endLine, "location.endLine"),
    endColumn: location.endColumn === undefined ? undefined : requirePositiveInteger(location.endColumn, "location.endColumn")
  };
}

function requireReviewStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`review.findings requires ${fieldName} to be a string array.`);
  }
  return value.map((item) => requireReviewNonEmptyString(item, fieldName));
}

function requireReviewNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`review.findings requires a non-empty ${fieldName}.`);
  }
  return value.trim();
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`review.findings requires ${fieldName} to be a positive integer.`);
  }
  return value;
}

function isReviewSeverity(value: unknown): value is RunloomReviewFindingSeverity {
  return typeof value === "string" && REVIEW_FINDING_SEVERITIES.has(value as RunloomReviewFindingSeverity);
}

function isReviewCategory(value: unknown): value is RunloomReviewFindingCategory {
  return typeof value === "string" && REVIEW_FINDING_CATEGORIES.has(value as RunloomReviewFindingCategory);
}

function requireFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`delivery.summary requires ${fieldName} to be a finite number.`);
  }
  return value;
}
