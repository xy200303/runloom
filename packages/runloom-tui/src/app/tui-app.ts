import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { ApprovalPolicyConfig, RunloomAgent, RunloomEvent, Unsubscribe } from "runloom-agent";

export interface CreateRunloomTuiAppOptions {
  agent: RunloomAgent;
  input?: Readable;
  output?: Writable;
}

export interface RunloomTuiApp {
  start(): Promise<void>;
  stop(): Promise<void>;
  render(event: RunloomEvent): void;
}

export function createRunloomTuiApp(options: CreateRunloomTuiAppOptions): RunloomTuiApp {
  return new BasicRunloomTuiApp(options);
}

class BasicRunloomTuiApp implements RunloomTuiApp {
  private unsubscribe?: Unsubscribe;
  private stopped = false;

  constructor(private readonly options: CreateRunloomTuiAppOptions) {}

  async start(): Promise<void> {
    const input = this.options.input ?? defaultInput;
    const output = this.options.output ?? defaultOutput;
    const rl = createInterface({ input, output });

    this.unsubscribe = this.options.agent.subscribe((event) => this.render(event));
    output.write("Runloom Code\n");
    output.write("Type /help for commands. Type /quit to exit.\n\n");

    while (!this.stopped) {
      const line = (await rl.question("runloom> ")).trim();
      if (!line) {
        continue;
      }
      if (line.startsWith("/")) {
        await this.handleCommand(line);
        continue;
      }
      await this.options.agent.submit(line);
    }

    rl.close();
    this.unsubscribe?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    await this.options.agent.close();
  }

  render(event: RunloomEvent): void {
    const output = this.options.output ?? defaultOutput;

    switch (event.type) {
      case "run.started":
        output.write(`\n[run] started ${event.runId}\n`);
        break;
      case "coding.workspace.inspected":
        output.write("[coding] workspace inspected\n");
        break;
      case "coding.git.status":
        output.write(`[git] ${formatGitStatus(event.payload)}\n`);
        break;
      case "todo.updated":
        output.write(`[todo] ${formatTodo(event.payload)}\n`);
        break;
      case "response.output_text.delta":
        output.write(String((event.payload as { delta?: string }).delta ?? ""));
        break;
      case "response.completed":
        output.write("\n[model] completed\n");
        break;
      case "response.failed":
        output.write(`\n[model] failed: ${formatErrorPayload(event.payload)}\n`);
        break;
      case "approval.policy.updated":
        output.write(`[approval] policy updated\n${formatApprovalPolicy(event.payload as ApprovalPolicyConfig)}\n`);
        break;
      case "run.completed":
        output.write("[run] completed\n\n");
        break;
      case "run.failed":
        output.write(`[run] failed: ${formatErrorPayload(event.payload)}\n\n`);
        break;
      default:
        if (event.source !== "model") {
          output.write(`[${event.type}]\n`);
        }
        break;
    }
  }

  private async handleCommand(command: string): Promise<void> {
    const output = this.options.output ?? defaultOutput;

    if (command === "/quit" || command === "/exit") {
      await this.stop();
      return;
    }

    if (command === "/help") {
      output.write(
        [
          "Commands:",
          "  /help          Show this help",
          "  /status        Show session and approval status",
          "  /permissions   Show approval policy",
          "  /quit          Exit"
        ].join("\n") + "\n"
      );
      return;
    }

    if (command === "/status" || command === "/permissions") {
      const policy = await this.options.agent.getApprovalPolicy();
      output.write(formatApprovalPolicy(policy));
      return;
    }

    output.write(`Unknown command: ${command}\n`);
  }
}

function formatGitStatus(payload: unknown): string {
  const status = payload as { isRepository?: boolean; branch?: string; isDirty?: boolean; changedFiles?: string[] };
  if (!status.isRepository) {
    return "not a git repository";
  }
  const dirty = status.isDirty ? "dirty" : "clean";
  const files = status.changedFiles?.length ? `, changed: ${status.changedFiles.join(", ")}` : "";
  return `${status.branch ?? "unknown branch"} (${dirty})${files}`;
}

function formatTodo(payload: unknown): string {
  const items = (payload as { items?: Array<{ title: string; status: string }> }).items ?? [];
  return items.map((item) => `${item.status}: ${item.title}`).join("; ");
}

function formatErrorPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object" && "error" in payload) {
    return String((payload as { error: unknown }).error);
  }
  if (payload && typeof payload === "object" && "message" in payload) {
    return String((payload as { message: unknown }).message);
  }
  return JSON.stringify(payload);
}

function formatApprovalPolicy(policy: ApprovalPolicyConfig): string {
  const lines = [`Approval policy: default=${policy.defaultMode}`];
  for (const [scope, mode] of Object.entries(policy.scopes)) {
    lines.push(`  ${scope}: ${mode}`);
  }
  return `${lines.join("\n")}\n`;
}
