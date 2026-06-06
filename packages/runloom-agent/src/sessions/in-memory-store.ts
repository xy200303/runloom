import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalRequest,
  RunloomAuditRecord,
  RunloomDeliverySummary,
  RunloomDiffRecord,
  RunloomEditPlan,
  RunloomMessage,
  RunloomReviewFindings,
  RunloomSession
} from "../types.js";

export interface InMemorySessionStoreSnapshot {
  sessions: RunloomSession[];
  approvals: ApprovalRequest[];
  approvalDecisions: Array<{ approvalId: string; decision: ApprovalDecision }>;
  auditRecords: RunloomAuditRecord[];
  messages: RunloomMessage[];
  editPlans: RunloomEditPlan[];
  deliverySummaries: RunloomDeliverySummary[];
  reviewFindings: RunloomReviewFindings[];
  diffRecords: RunloomDiffRecord[];
}

export class InMemorySessionStore {
  private readonly sessions = new Map<string, RunloomSession>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly approvalDecisions = new Map<string, ApprovalDecision>();
  private readonly auditRecords: RunloomAuditRecord[] = [];
  private readonly messages: RunloomMessage[] = [];
  private readonly editPlans: RunloomEditPlan[] = [];
  private readonly deliverySummaries: RunloomDeliverySummary[] = [];
  private readonly reviewFindings: RunloomReviewFindings[] = [];
  private readonly diffRecords: RunloomDiffRecord[] = [];

  constructor(snapshot?: InMemorySessionStoreSnapshot, private readonly onChange?: () => void) {
    for (const session of snapshot?.sessions ?? []) {
      this.sessions.set(session.id, { ...session });
    }
    for (const approval of snapshot?.approvals ?? []) {
      this.approvals.set(approval.id, { ...approval });
    }
    for (const { approvalId, decision } of snapshot?.approvalDecisions ?? []) {
      this.approvalDecisions.set(approvalId, { ...decision });
    }
    this.auditRecords.push(...((snapshot?.auditRecords ?? []).map((record) => ({ ...record }))));
    this.messages.push(...((snapshot?.messages ?? []).map(cloneMessage)));
    this.editPlans.push(...((snapshot?.editPlans ?? []).map(cloneEditPlan)));
    this.deliverySummaries.push(...((snapshot?.deliverySummaries ?? []).map(cloneDeliverySummary)));
    this.reviewFindings.push(...((snapshot?.reviewFindings ?? []).map(cloneReviewFindings)));
    this.diffRecords.push(...((snapshot?.diffRecords ?? []).map(cloneDiffRecord)));
  }

  createSession(workspace: string): RunloomSession {
    const now = new Date().toISOString();
    const session: RunloomSession = {
      id: `ses_${randomUUID()}`,
      workspace,
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.id, session);
    this.persist();
    return session;
  }

  getSession(sessionId: string): RunloomSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(workspace?: string): RunloomSession[] {
    const sessions = [...this.sessions.values()];
    return workspace ? sessions.filter((session) => session.workspace === workspace) : sessions;
  }

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.updatedAt = new Date().toISOString();
      this.persist();
    }
  }

  saveApproval(request: ApprovalRequest): void {
    this.approvals.set(request.id, request);
    this.persist();
  }

  getApproval(approvalId: string): ApprovalRequest | undefined {
    return this.approvals.get(approvalId);
  }

  getApprovalDecision(approvalId: string): ApprovalDecision | undefined {
    return this.approvalDecisions.get(approvalId);
  }

  listApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()];
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    this.approvalDecisions.set(approvalId, decision);
    this.approvals.delete(approvalId);
    this.persist();
  }

  appendAuditRecord(record: RunloomAuditRecord): void {
    this.auditRecords.push(record);
    this.persist();
  }

  listAuditRecords(action?: string): RunloomAuditRecord[] {
    return this.auditRecords.filter((record) => !action || record.action === action);
  }

  appendMessage(message: RunloomMessage): void {
    this.messages.push(message);
    this.persist();
  }

  listMessages(options: { sessionId?: string; runId?: string } = {}): RunloomMessage[] {
    return this.messages.filter((message) => {
      if (options.sessionId && message.sessionId !== options.sessionId) {
        return false;
      }
      return !options.runId || message.runId === options.runId;
    });
  }

  appendEditPlan(plan: RunloomEditPlan): void {
    this.editPlans.push(plan);
    this.persist();
  }

  listEditPlans(options: { sessionId?: string; runId?: string; status?: RunloomEditPlan["status"] } = {}): RunloomEditPlan[] {
    return this.editPlans.filter((plan) => {
      if (options.sessionId && plan.sessionId !== options.sessionId) {
        return false;
      }
      if (options.runId && plan.runId !== options.runId) {
        return false;
      }
      return !options.status || plan.status === options.status;
    });
  }

  appendDeliverySummary(summary: RunloomDeliverySummary): void {
    this.deliverySummaries.push(summary);
    this.persist();
  }

  listDeliverySummaries(options: { sessionId?: string; runId?: string } = {}): RunloomDeliverySummary[] {
    return this.deliverySummaries.filter((summary) => {
      if (options.sessionId && summary.sessionId !== options.sessionId) {
        return false;
      }
      return !options.runId || summary.runId === options.runId;
    });
  }

  appendReviewFindings(findings: RunloomReviewFindings): void {
    this.reviewFindings.push(findings);
    this.persist();
  }

  listReviewFindings(options: { sessionId?: string; runId?: string } = {}): RunloomReviewFindings[] {
    return this.reviewFindings.filter((findings) => {
      if (options.sessionId && findings.sessionId !== options.sessionId) {
        return false;
      }
      return !options.runId || findings.runId === options.runId;
    });
  }

  appendDiffRecord(record: RunloomDiffRecord): void {
    this.diffRecords.push(record);
    this.persist();
  }

  listDiffRecords(options: { sessionId?: string; runId?: string } = {}): RunloomDiffRecord[] {
    return this.diffRecords.filter((record) => {
      if (options.sessionId && record.sessionId !== options.sessionId) {
        return false;
      }
      return !options.runId || record.runId === options.runId;
    });
  }

  snapshot(): InMemorySessionStoreSnapshot {
    return {
      sessions: [...this.sessions.values()].map((session) => ({ ...session })),
      approvals: [...this.approvals.values()].map((approval) => ({ ...approval })),
      approvalDecisions: [...this.approvalDecisions.entries()].map(([approvalId, decision]) => ({
        approvalId,
        decision: { ...decision }
      })),
      auditRecords: this.auditRecords.map((record) => ({ ...record })),
      messages: this.messages.map(cloneMessage),
      editPlans: this.editPlans.map(cloneEditPlan),
      deliverySummaries: this.deliverySummaries.map(cloneDeliverySummary),
      reviewFindings: this.reviewFindings.map(cloneReviewFindings),
      diffRecords: this.diffRecords.map(cloneDiffRecord)
    };
  }

  private persist(): void {
    this.onChange?.();
  }
}

function cloneMessage(message: RunloomMessage): RunloomMessage {
  return {
    ...message,
    content: message.content.map((part) => ({ ...part })),
    metadata: message.metadata ? { ...message.metadata } : undefined
  };
}

function cloneEditPlan(plan: RunloomEditPlan): RunloomEditPlan {
  return {
    ...plan,
    targetFiles: [...plan.targetFiles],
    risks: [...plan.risks],
    verificationCommands: [...plan.verificationCommands]
  };
}

function cloneDeliverySummary(summary: RunloomDeliverySummary): RunloomDeliverySummary {
  return {
    ...summary,
    modifiedFiles: [...summary.modifiedFiles],
    coreChanges: [...summary.coreChanges],
    verificationResults: summary.verificationResults.map((result) => ({ ...result })),
    failedItems: [...summary.failedItems],
    remainingRisks: [...summary.remainingRisks]
  };
}

function cloneReviewFindings(findings: RunloomReviewFindings): RunloomReviewFindings {
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

function cloneDiffRecord(record: RunloomDiffRecord): RunloomDiffRecord {
  return {
    ...record,
    diff: {
      ...record.diff,
      filesChanged: [...record.diff.filesChanged]
    }
  };
}
