import type { RunloomEvent } from "runloom-agent";

export function formatGitStatus(payload: unknown): string {
  const status = payload as { isRepository?: boolean; branch?: string; isDirty?: boolean; changedFiles?: string[] };
  if (!status.isRepository) {
    return "not a git repository";
  }
  const dirty = status.isDirty ? "dirty" : "clean";
  const files = status.changedFiles?.length ? `, changed: ${status.changedFiles.join(", ")}` : "";
  return `${status.branch ?? "unknown branch"} (${dirty})${files}`;
}

export function formatTodo(payload: unknown): string {
  const items = (payload as { items?: Array<{ title: string; status: string }> }).items ?? [];
  return items.map((item) => `${item.status}: ${item.title}`).join("; ");
}

export function formatErrorPayload(payload: unknown): string {
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

export function formatSkillActivation(payload: unknown): string {
  const activation = payload as { skillName?: string; reason?: string };
  const reason = activation.reason ? ` reason=${activation.reason}` : "";
  return `${activation.skillName ?? "unknown"}${reason}`;
}

export function formatToolActivityEvent(event: RunloomEvent): string {
  const payload = event.payload as {
    toolName?: string;
    name?: string;
    status?: string;
    approvalId?: string;
    error?: string;
  };
  const toolName = payload.toolName ?? payload.name;
  const status = payload.status ? ` status=${payload.status}` : "";
  const approval = payload.approvalId ? ` approval=${payload.approvalId}` : "";
  const error = payload.error ? ` error=${payload.error}` : "";
  return `${event.type}${toolName ? ` ${toolName}` : ""}${status}${approval}${error}`;
}

export function formatModelSelection(payload: unknown): string {
  const selection = payload as { providerId?: string; model?: string; reason?: string; source?: string };
  const model = `${selection.providerId ?? "unknown"}:${selection.model ?? "unknown"}`;
  const source = selection.source ? ` source=${selection.source}` : "";
  const reason = selection.reason ? ` reason=${selection.reason}` : "";
  return `${model}${source}${reason}`;
}

export function formatToolExecutionState(result: { toolName: string; status: string; error?: string; approvalId?: string }): string {
  if (result.status === "waiting_approval") {
    return `[tool] ${result.toolName} waiting for approval ${result.approvalId ?? ""}\n`;
  }
  return `[tool] ${result.toolName} ${result.status}${result.error ? `: ${result.error}` : ""}\n`;
}

export function formatVerificationResult(payload: unknown): string {
  const result = payload as { command?: string; exitCode?: number; durationMs?: number; stdout?: string; stderr?: string };
  const lines = [
    `[tests] ${result.command ?? "verification"} exit=${result.exitCode ?? "unknown"} duration=${result.durationMs ?? 0}ms`
  ];
  if (result.stdout?.trim()) {
    lines.push(result.stdout.trim());
  }
  if (result.stderr?.trim()) {
    lines.push(result.stderr.trim());
  }
  return `${lines.join("\n")}\n`;
}

export function formatVerificationActivity(payload: unknown): string {
  const result = payload as { command?: string; exitCode?: number; durationMs?: number };
  return `${result.command ?? "verification"} exit=${result.exitCode ?? "unknown"} duration=${result.durationMs ?? 0}ms`;
}

export function formatDiffSummary(payload: unknown): string {
  const diff = payload as { filesChanged?: string[]; additions?: number; deletions?: number; patch?: string };
  const files = diff.filesChanged ?? [];
  if (files.length === 0 && !diff.patch?.trim()) {
    return "Diff: no tracked changes\n";
  }
  const lines = [`Diff: ${files.length} file(s), +${diff.additions ?? 0}/-${diff.deletions ?? 0}`];
  if (files.length) {
    lines.push(`Files: ${files.join(", ")}`);
  }
  if (diff.patch?.trim()) {
    lines.push(diff.patch.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

export function formatDiffActivity(payload: unknown): string {
  const diff = payload as { filesChanged?: string[]; additions?: number; deletions?: number; patch?: string };
  const files = diff.filesChanged ?? [];
  if (files.length === 0 && !diff.patch?.trim()) {
    return "no tracked changes";
  }
  return `${files.length} file(s), +${diff.additions ?? 0}/-${diff.deletions ?? 0}`;
}

export function formatReviewFindings(payload: unknown): string {
  const review = payload as {
    findings?: Array<{
      severity?: string;
      title?: string;
      category?: string;
      location?: { path?: string; line?: number };
      recommendation?: string;
    }>;
    reviewedFiles?: string[];
    summary?: string;
  };
  const findings = review.findings ?? [];
  const lines = [`[review] ${findings.length} finding(s)`];
  if (review.reviewedFiles?.length) {
    lines.push(`Files: ${review.reviewedFiles.join(", ")}`);
  }
  if (review.summary) {
    lines.push(`Summary: ${review.summary}`);
  }
  if (findings.length === 0) {
    lines.push("No findings recorded.");
    return `${lines.join("\n")}\n`;
  }
  for (const finding of findings) {
    const location = finding.location?.path
      ? ` ${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ""}`
      : "";
    const category = finding.category ? ` ${finding.category}` : "";
    lines.push(`  ${finding.severity ?? "unknown"}${category}${location} - ${finding.title ?? "(untitled)"}`);
    if (finding.recommendation) {
      lines.push(`    recommendation: ${finding.recommendation}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
