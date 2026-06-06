import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest, RunloomSession } from "../types.js";

export class InMemorySessionStore {
  private readonly sessions = new Map<string, RunloomSession>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly approvalDecisions = new Map<string, ApprovalDecision>();

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
}
