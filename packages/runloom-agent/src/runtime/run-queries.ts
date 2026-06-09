import { RuntimeError } from "../errors.js";
import { RunloomEventBus } from "../events/event-bus.js";
import { InMemorySessionStore } from "../sessions/in-memory-store.js";
import {
  cloneDeliverySummary,
  cloneDiffRecord,
  cloneEditPlan,
  cloneReviewFindings
} from "./run-artifacts.js";
import type {
  ListAuditRecordsOptions,
  ListDeliverySummariesOptions,
  ListDiffRecordsOptions,
  ListEditPlansOptions,
  ListEventsOptions,
  ListMessagesOptions,
  ListReviewFindingsOptions,
  ListRunsOptions,
  RunloomAuditRecord,
  RunloomDeliverySummary,
  RunloomDiffRecord,
  RunloomEditPlan,
  RunloomEvent,
  RunloomMessage,
  RunloomReviewFindings,
  RunloomRun,
  RunloomSession
} from "../types.js";

export interface RunQueryRecord {
  run: RunloomRun;
}

export interface RunQueryRuntimeOptions {
  workspace: string;
  store: InMemorySessionStore;
  bus: RunloomEventBus;
  runs: Map<string, RunQueryRecord>;
}

export class RunQueryRuntime {
  constructor(private readonly options: RunQueryRuntimeOptions) {}

  async listSessions(): Promise<RunloomSession[]> {
    return this.options.store.listSessions(this.options.workspace);
  }

  async listAuditRecords(options: ListAuditRecordsOptions = {}): Promise<RunloomAuditRecord[]> {
    const records = this.options.store.listAuditRecords(options.action);
    return takeLast(records, options.limit).map((record) => ({ ...record }));
  }

  async getSession(sessionId: string): Promise<RunloomSession> {
    const session = this.options.store.getSession(sessionId);
    if (!session) {
      throw new RuntimeError(`Session not found: ${sessionId}`, {
        code: "runtime.session_not_found",
        details: { sessionId }
      });
    }
    return session;
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunloomRun[]> {
    return [...this.options.runs.values()]
      .map((storedRun) => cloneRun(storedRun.run))
      .filter((run) => !options.sessionId || run.sessionId === options.sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getRun(runId: string): Promise<RunloomRun> {
    const storedRun = this.options.runs.get(runId);
    if (!storedRun) {
      throw new RuntimeError(`Run not found: ${runId}`, {
        code: "runtime.run_not_found",
        details: { runId }
      });
    }
    return cloneRun(storedRun.run);
  }

  async listEvents(options: ListEventsOptions = {}): Promise<RunloomEvent[]> {
    const events = this.options.bus
      .listEvents(options.sessionId)
      .filter((event) => !options.runId || event.runId === options.runId);
    return takeLast(events, options.limit).map((event) => ({ ...event }));
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<RunloomMessage[]> {
    const messages = this.options.store.listMessages({
      sessionId: options.sessionId,
      runId: options.runId
    });
    return takeLast(messages, options.limit).map(cloneMessage);
  }

  async listEditPlans(options: ListEditPlansOptions = {}): Promise<RunloomEditPlan[]> {
    const plans = this.options.store.listEditPlans({
      sessionId: options.sessionId,
      runId: options.runId,
      status: options.status
    });
    return takeLast(plans, options.limit).map(cloneEditPlan);
  }

  async listDeliverySummaries(options: ListDeliverySummariesOptions = {}): Promise<RunloomDeliverySummary[]> {
    const summaries = this.options.store.listDeliverySummaries({
      sessionId: options.sessionId,
      runId: options.runId
    });
    return takeLast(summaries, options.limit).map(cloneDeliverySummary);
  }

  async listReviewFindings(options: ListReviewFindingsOptions = {}): Promise<RunloomReviewFindings[]> {
    const findings = this.options.store.listReviewFindings({
      sessionId: options.sessionId,
      runId: options.runId
    });
    return takeLast(findings, options.limit).map(cloneReviewFindings);
  }

  async listDiffRecords(options: ListDiffRecordsOptions = {}): Promise<RunloomDiffRecord[]> {
    const records = this.options.store.listDiffRecords({
      sessionId: options.sessionId,
      runId: options.runId
    });
    return takeLast(records, options.limit).map(cloneDiffRecord);
  }
}

function cloneRun(run: RunloomRun): RunloomRun {
  return {
    ...run
  };
}

function cloneMessage(message: RunloomMessage): RunloomMessage {
  return {
    ...message,
    content: message.content.map((part) => ({ ...part })),
    metadata: message.metadata ? { ...message.metadata } : undefined
  };
}

function takeLast<TItem>(items: TItem[], limit?: number): TItem[] {
  if (typeof limit !== "number" || limit < 0) {
    return items;
  }
  if (limit === 0) {
    return [];
  }
  return items.slice(-limit);
}
