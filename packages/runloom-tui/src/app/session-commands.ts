import type { Writable } from "node:stream";
import type {
  RunloomAgent,
  RunloomEvent
} from "runloom-agent";
import {
  formatCurrentSession,
  formatSessionCommandHelp,
  formatSessions
} from "./view-formatters.js";

export interface TuiSessionCommandControllerOptions {
  agent: RunloomAgent;
  output: Writable;
  getActiveSessionId(): string | undefined;
  getActiveRunId(): string | undefined;
  setActiveSessionId(sessionId: string | undefined): void;
  setActiveRunId(runId: string | undefined): void;
  rebuildFromStoredEvents(sessionId?: string): Promise<RunloomEvent[]>;
  renderCompositeView(): string;
}

export class TuiSessionCommandController {
  constructor(private readonly options: TuiSessionCommandControllerOptions) {}

  async handleSessionCommand(command: string): Promise<void> {
    const output = this.options.output;
    const [, action, sessionId] = command.split(/\s+/);

    if (!action) {
      const activeSessionId = this.options.getActiveSessionId();
      if (!activeSessionId) {
        output.write("Session: (none yet)\n");
        return;
      }
      const session = await this.options.agent.getSession(activeSessionId);
      output.write(formatCurrentSession(session, this.options.getActiveRunId()));
      return;
    }

    if (action === "list") {
      const sessions = await this.options.agent.listSessions();
      output.write(formatSessions(sessions, this.options.getActiveSessionId()));
      return;
    }

    if (action === "switch") {
      if (!sessionId) {
        output.write("Missing session id for /session switch\n");
        return;
      }
      const session = await this.options.agent.getSession(sessionId);
      this.options.setActiveSessionId(session.id);
      this.options.setActiveRunId(undefined);
      const events = await this.options.rebuildFromStoredEvents(session.id);
      output.write(`Session switched to ${session.id}\n`);
      output.write(`[replay] loaded ${events.length} event(s)\n`);
      output.write(this.options.renderCompositeView());
      return;
    }

    output.write(`Unknown /session action: ${action}\n`);
    output.write(formatSessionCommandHelp());
  }

  async handleReplayCommand(): Promise<void> {
    const output = this.options.output;
    const events = await this.options.rebuildFromStoredEvents(this.options.getActiveSessionId());
    output.write(`[replay] loaded ${events.length} event(s)\n`);
    output.write(this.options.renderCompositeView());
  }
}
