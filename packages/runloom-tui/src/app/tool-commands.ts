import type { Writable } from "node:stream";
import type {
  RunloomAgent,
  ToolExecutionResult
} from "runloom-agent";
import { parseVerificationCommand } from "./command-parsers.js";
import {
  formatDiffActivity,
  formatDiffSummary,
  formatGitStatus,
  formatToolExecutionState,
  formatVerificationActivity,
  formatVerificationResult
} from "./view-formatters.js";
import type { ActivityCategory } from "./view-model.js";

export interface TuiToolCommandControllerOptions {
  agent: RunloomAgent;
  output: Writable;
  getActiveSessionId(): string | undefined;
  trackToolSession(result: ToolExecutionResult): void;
  recordToolCommandActivity(result: ToolExecutionResult, line: string, category: ActivityCategory): void;
}

export class TuiToolCommandController {
  constructor(private readonly options: TuiToolCommandControllerOptions) {}

  async handleGitCommand(): Promise<void> {
    const output = this.options.output;
    const result = await this.options.agent.executeTool("git.status", {}, { sessionId: this.options.getActiveSessionId() });
    this.options.trackToolSession(result);
    if (result.status !== "completed") {
      this.recordToolState(result);
      return;
    }
    this.options.recordToolCommandActivity(result, `git ${formatGitStatus(result.output)}`, "coding");
    output.write(`[git] ${formatGitStatus(result.output)}\n`);
  }

  async handleTestsCommand(command: string): Promise<void> {
    const output = this.options.output;
    const verification = parseVerificationCommand(command);
    const result = await this.options.agent.executeTool("shell.verify", verification, { sessionId: this.options.getActiveSessionId() });
    this.options.trackToolSession(result);
    if (result.status !== "completed") {
      this.recordToolState(result);
      return;
    }
    this.options.recordToolCommandActivity(result, `tests ${formatVerificationActivity(result.output)}`, "coding");
    output.write(formatVerificationResult(result.output));
  }

  async handleDiffCommand(): Promise<void> {
    const output = this.options.output;
    const result = await this.options.agent.executeTool("git.diff", {}, { sessionId: this.options.getActiveSessionId() });
    this.options.trackToolSession(result);
    if (result.status !== "completed") {
      this.recordToolState(result);
      return;
    }
    this.options.recordToolCommandActivity(result, `diff ${formatDiffActivity(result.output)}`, "coding");
    output.write(formatDiffSummary(result.output));
  }

  private recordToolState(result: ToolExecutionResult): void {
    const line = formatToolExecutionState(result);
    this.options.recordToolCommandActivity(result, line.trim(), "tools");
    this.options.output.write(line);
  }
}
