import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ModelSelectionResult,
  RunloomAuditRecord,
  RunloomDeliverySummary,
  RunloomDiffRecord,
  RunloomEditPlan,
  RunloomEvent,
  RunloomMessage,
  RunloomModelInputItem,
  RunloomModelTool,
  RunloomReviewFindings,
  RunloomRun,
  RunloomSession
} from "../types.js";
import type { InMemorySessionStoreSnapshot } from "./in-memory-store.js";

export interface StoredRunInput {
  text: string;
  model?: string;
  profile?: string;
  taskType?: string;
  language?: string;
}

export interface StoredRunRecord {
  run: RunloomRun;
  input: StoredRunInput;
}

export interface StoredModelToolCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
  raw?: unknown;
}

export interface StoredPendingModelContinuation {
  approvalId: string;
  runId: string;
  sessionId: string;
  modelSelection: ModelSelectionResult;
  input: RunloomModelInputItem[];
  tools: RunloomModelTool[];
  output: string[];
  pendingToolCall: StoredModelToolCall;
  remainingToolCalls: StoredModelToolCall[];
  nextStep: number;
}

export interface RuntimeStateSnapshot {
  store: InMemorySessionStoreSnapshot;
  runs: StoredRunRecord[];
  events: RunloomEvent[];
  sequence: number;
  pendingModelContinuations: StoredPendingModelContinuation[];
}

export class FileRuntimeStateStore {
  private readonly workspace: string;
  private readonly filePath: string;

  constructor(stateDir: string, workspace: string) {
    this.workspace = resolve(workspace);
    const workspaceId = createHash("sha256").update(this.workspace).digest("hex").slice(0, 24);
    this.filePath = join(resolve(stateDir), "workspaces", `${workspaceId}.runtime-state.json`);
  }

  load(): RuntimeStateSnapshot | undefined {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return parseStoredRuntimeState(parsed, this.workspace);
    } catch {
      return undefined;
    }
  }

  save(snapshot: RuntimeStateSnapshot): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(
      tempPath,
      JSON.stringify(
        {
          version: 1,
          workspace: this.workspace,
          ...snapshot
        },
        null,
        2
      ),
      "utf8"
    );
    renameSync(tempPath, this.filePath);
  }
}

function parseStoredRuntimeState(value: unknown, workspace: string): RuntimeStateSnapshot | undefined {
  if (!isRecord(value) || value.version !== 1 || value.workspace !== workspace) {
    return undefined;
  }

  return {
    store: parseSessionStoreSnapshot(value.store),
    runs: parseRunRecords(value.runs),
    events: parseEvents(value.events),
    sequence: parseSequence(value.sequence, value.events),
    pendingModelContinuations: parsePendingContinuations(value.pendingModelContinuations)
  };
}

function parseSessionStoreSnapshot(value: unknown): InMemorySessionStoreSnapshot {
  const store = isRecord(value) ? value : {};
  return {
    sessions: parseArray<RunloomSession>(store.sessions, isSession),
    approvals: parseArray<ApprovalRequest>(store.approvals, isApprovalRequest),
    approvalDecisions: parseArray<{ approvalId: string; decision: ApprovalDecision }>(
      store.approvalDecisions,
      isApprovalDecisionRecord
    ),
    auditRecords: parseArray<RunloomAuditRecord>(store.auditRecords, isAuditRecord),
    messages: parseArray<RunloomMessage>(store.messages, isMessage),
    editPlans: parseArray<RunloomEditPlan>(store.editPlans, isEditPlan),
    deliverySummaries: parseArray<RunloomDeliverySummary>(store.deliverySummaries, isDeliverySummary),
    reviewFindings: parseArray<RunloomReviewFindings>(store.reviewFindings, isReviewFindings),
    diffRecords: parseArray<RunloomDiffRecord>(store.diffRecords, isDiffRecord)
  };
}

function parseRunRecords(value: unknown): StoredRunRecord[] {
  return parseArray<StoredRunRecord>(value, (item): item is StoredRunRecord => {
    if (!isRecord(item) || !isRun(item.run) || !isRecord(item.input) || typeof item.input.text !== "string") {
      return false;
    }
    return true;
  }).map((record) => ({
    run: record.run,
    input: {
      text: record.input.text,
      model: typeof record.input.model === "string" ? record.input.model : undefined,
      profile: typeof record.input.profile === "string" ? record.input.profile : undefined,
      taskType: typeof record.input.taskType === "string" ? record.input.taskType : undefined,
      language: typeof record.input.language === "string" ? record.input.language : undefined
    }
  }));
}

function parseEvents(value: unknown): RunloomEvent[] {
  return parseArray<RunloomEvent>(value, isEvent);
}

function parseSequence(value: unknown, events: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  const parsedEvents = parseEvents(events);
  return parsedEvents.reduce((max, event) => Math.max(max, event.sequence), 0);
}

function parsePendingContinuations(value: unknown): StoredPendingModelContinuation[] {
  return parseArray<StoredPendingModelContinuation>(value, (item): item is StoredPendingModelContinuation => {
    return (
      isRecord(item) &&
      typeof item.approvalId === "string" &&
      typeof item.runId === "string" &&
      typeof item.sessionId === "string" &&
      isRecord(item.modelSelection) &&
      Array.isArray(item.input) &&
      Array.isArray(item.tools) &&
      isStringArray(item.output) &&
      isModelToolCall(item.pendingToolCall) &&
      parseArray<StoredModelToolCall>(item.remainingToolCalls, isModelToolCall).length ===
        (Array.isArray(item.remainingToolCalls) ? item.remainingToolCalls.length : -1) &&
      typeof item.nextStep === "number" &&
      Number.isInteger(item.nextStep) &&
      item.nextStep >= 0
    );
  });
}

function parseArray<TItem>(value: unknown, guard: (item: unknown) => item is TItem): TItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(guard);
}

function isSession(value: unknown): value is RunloomSession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.workspace === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRun(value: unknown): value is RunloomRun {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.status === "string" &&
    typeof value.inputText === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isApprovalRequest(value: unknown): value is ApprovalRequest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.scope === "string" &&
    typeof value.action === "string" &&
    typeof value.risk === "string" &&
    typeof value.mode === "string" &&
    typeof value.summary === "string"
  );
}

function isApprovalDecisionRecord(value: unknown): value is { approvalId: string; decision: ApprovalDecision } {
  return isRecord(value) && typeof value.approvalId === "string" && isRecord(value.decision);
}

function isAuditRecord(value: unknown): value is RunloomAuditRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.action === "string" &&
    typeof value.actor === "string" &&
    typeof value.summary === "string"
  );
}

function isMessage(value: unknown): value is RunloomMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.role === "string" &&
    Array.isArray(value.content) &&
    typeof value.createdAt === "string"
  );
}

function isEditPlan(value: unknown): value is RunloomEditPlan {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.status === "string" &&
    typeof value.goal === "string" &&
    isStringArray(value.targetFiles) &&
    isStringArray(value.risks) &&
    isStringArray(value.verificationCommands) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isDeliverySummary(value: unknown): value is RunloomDeliverySummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.createdAt === "string" &&
    isStringArray(value.modifiedFiles) &&
    isStringArray(value.coreChanges) &&
    Array.isArray(value.verificationResults) &&
    isStringArray(value.failedItems) &&
    isStringArray(value.remainingRisks)
  );
}

function isReviewFindings(value: unknown): value is RunloomReviewFindings {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.findings) &&
    isStringArray(value.reviewedFiles)
  );
}

function isDiffRecord(value: unknown): value is RunloomDiffRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.toolName === "string" &&
    typeof value.displayed === "boolean" &&
    isRecord(value.diff) &&
    isStringArray(value.diff.filesChanged)
  );
}

function isEvent(value: unknown): value is RunloomEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.runId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.sequence === "number" &&
    typeof value.timestamp === "string" &&
    typeof value.source === "string"
  );
}

function isModelToolCall(value: unknown): value is StoredModelToolCall {
  return (
    isRecord(value) &&
    typeof value.toolCallId === "string" &&
    typeof value.name === "string" &&
    "arguments" in value
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
