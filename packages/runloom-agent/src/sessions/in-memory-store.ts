import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalRequest,
  RunloomAuditRecord,
  RunloomDiffRecord,
  RunloomEditPlan,
  RunloomMessage,
  RunloomSession
} from "../types.js";

export class InMemorySessionStore {
  private readonly sessions = new Map<string, RunloomSession>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly approvalDecisions = new Map<string, ApprovalDecision>();
  private readonly auditRecords: RunloomAuditRecord[] = [];
  private readonly messages: RunloomMessage[] = [];
  private readonly editPlans: RunloomEditPlan[] = [];
  private readonly diffRecords: RunloomDiffRecord[] = [];

  createSession(workspace: string): RunloomSession {
    const now = new Date().toISOString();
    const session: RunloomSession = {
      id: `ses_${randomUUID()}`,
      workspace,
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.id, session);
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
    }
  }

  saveApproval(request: ApprovalRequest): void {
    this.approvals.set(request.id, request);
  }

  getApproval(approvalId: string): ApprovalRequest | undefined {
    return this.approvals.get(approvalId);
  }

  listApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()];
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    this.approvalDecisions.set(approvalId, decision);
    this.approvals.delete(approvalId);
  }

  appendAuditRecord(record: RunloomAuditRecord): void {
    this.auditRecords.push(record);
  }

  listAuditRecords(action?: string): RunloomAuditRecord[] {
    return this.auditRecords.filter((record) => !action || record.action === action);
  }

  appendMessage(message: RunloomMessage): void {
    this.messages.push(message);
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

  appendDiffRecord(record: RunloomDiffRecord): void {
    this.diffRecords.push(record);
  }

  listDiffRecords(options: { sessionId?: string; runId?: string } = {}): RunloomDiffRecord[] {
    return this.diffRecords.filter((record) => {
      if (options.sessionId && record.sessionId !== options.sessionId) {
        return false;
      }
      return !options.runId || record.runId === options.runId;
    });
  }
}
