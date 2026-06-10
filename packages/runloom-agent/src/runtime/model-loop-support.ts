import type { RunloomDiagnostic, RunloomInput, SubmitOptions, ToolExecutionResult } from "../types.js";

export interface NormalizedSubmitInput {
  text: string;
  model?: string;
  profile?: string;
  taskType?: string;
  language?: string;
}

export function stringifyToolResult(result: ToolExecutionResult): string {
  const payload =
    result.status === "completed"
      ? {
          status: result.status,
          output: result.output
        }
      : {
          status: result.status,
          error: result.error ?? `Tool ${result.toolName} did not complete.`
        };

  const json = JSON.stringify(payload);
  return json.length > 120_000 ? `${json.slice(0, 120_000)}...[truncated]` : json;
}

export function outputDelta(previous: string, next: string): string {
  if (!previous) {
    return next;
  }
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

export function buildSystemPrompt(taskType?: string): string {
  const base =
    "You are Runloom, a professional local coding agent. Be concise, cite local evidence, protect user changes, and summarize verification. Before high-risk code modifications, call edit.plan with target files, risks, and verification commands. At task completion, call delivery.summary with modified files, core changes, verification results, failed items, and remaining risks.";
  if (taskType !== "code_review") {
    return base;
  }

  return `${base} Review mode is active: use a findings-first code review template. Prioritize bugs, behavioral regressions, security issues, public API risks, and missing tests. Order findings by severity, include file and line evidence when available, state clearly when there are no findings, keep summaries secondary, and call review.findings with structured findings and reviewedFiles before completing the task.`;
}

export function buildDiagnosticsContext(diagnostics: RunloomDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }
  const lines = ["", "Host diagnostics:"];
  for (const diagnostic of diagnostics.slice(0, 30)) {
    const location = diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : "";
    const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
    lines.push(`- ${diagnostic.severity} ${diagnostic.path}${location}${source}: ${diagnostic.message}`);
  }
  if (diagnostics.length > 30) {
    lines.push(`- ...${diagnostics.length - 30} more diagnostic(s)`);
  }
  return `\n${lines.join("\n")}`;
}

export function normalizeSubmitInput(
  input: string | RunloomInput,
  options: SubmitOptions,
  defaultModel?: string
): NormalizedSubmitInput {
  if (typeof input === "string") {
    return {
      text: input,
      model: options.model ?? defaultModel,
      profile: options.profile,
      taskType: options.taskType,
      language: options.language
    };
  }

  return {
    text: input.text,
    model: options.model ?? input.model ?? defaultModel,
    profile: options.profile ?? input.profile,
    taskType: options.taskType ?? input.taskType,
    language: options.language ?? input.language
  };
}
