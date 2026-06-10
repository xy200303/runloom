import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveExistingWorkspacePath } from "../security/path-guard.js";
import type { TerminalAdapter, ToolDefinition, VerificationResult } from "../types.js";

const execFileAsync = promisify(execFile);

export function createVerifyCommandTool(terminal?: TerminalAdapter): ToolDefinition<
  { command: string; args?: string[]; cwd?: string; timeoutMs?: number },
  VerificationResult
> {
  return {
    name: "shell.verify",
    description: "Run a verification command in the workspace without shell interpolation.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "number" }
      },
      required: ["command"],
      additionalProperties: false
    },
    permissions: ["shell"],
    async execute(input, context) {
      const started = Date.now();
      const cwd = await resolveExistingWorkspacePath(context.workspace, input.cwd);
      if (terminal) {
        return runVerificationWithTerminalAdapter(terminal, input, cwd, started, context.signal);
      }
      try {
        const result = await execFileAsync(input.command, input.args ?? [], {
          cwd,
          timeout: input.timeoutMs ?? 120_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024 * 10
        });
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - started
        };
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: typeof err.code === "number" ? err.code : 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? err.message ?? "",
          durationMs: Date.now() - started
        };
      }
    }
  };
}

async function runVerificationWithTerminalAdapter(
  terminal: TerminalAdapter,
  input: { command: string; args?: string[]; timeoutMs?: number },
  cwd: string,
  started: number,
  signal: AbortSignal | undefined
): Promise<VerificationResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    for await (const event of terminal.run(
      {
        command: input.command,
        args: input.args,
        cwd,
        timeoutMs: input.timeoutMs
      },
      {
        cwd,
        timeoutMs: input.timeoutMs ?? 120_000,
        signal
      }
    )) {
      if (event.type === "stdout") {
        stdout += event.text;
      } else if (event.type === "stderr") {
        stderr += event.text;
      } else if (event.type === "exit") {
        exitCode = event.exitCode;
      } else if (event.type === "failed") {
        exitCode = event.exitCode ?? 1;
        stderr += event.error;
      }
    }
  } catch (error) {
    exitCode = 1;
    stderr += error instanceof Error ? error.message : String(error);
  }

  return {
    command: [input.command, ...(input.args ?? [])].join(" "),
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started
  };
}
