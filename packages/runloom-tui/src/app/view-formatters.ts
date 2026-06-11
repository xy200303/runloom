import { APPROVAL_MODES, PERMISSION_SCOPES } from "runloom-agent";
import type {
  A2APeerSummary,
  ApprovalPolicyConfig,
  ApprovalRequest,
  ExternalAgentSummary,
  McpServerSummary,
  RunloomEvent,
  RunloomSession,
  RunloomSkillProposal,
  RunloomSkillSummary,
  RunloomTodoItem,
  ToolSummary
} from "runloom-agent";
import { formatActivityCommandHelp } from "./command-formatters.js";
export {
  formatActivityCommandHelp,
  formatApprovalCommandHelp,
  formatApprovalDecision,
  formatApprovalDecisionCommandHelp,
  formatApprovalsCommandHelp,
  formatFocusCommandHelp,
  formatModelCommandHelp,
  formatPermissionsCommandHelp,
  formatScopeList,
  formatScrollCommandHelp,
  formatSessionCommandHelp,
  formatShortcutCommandHelp,
  formatShortcutLabel
} from "./command-formatters.js";
import {
  COMPOSITE_PANEL_LINES,
  DEFAULT_PANEL_LINES,
  clamp,
  visibleSlice,
  type ActivityCategory,
  type TuiActivityRecord,
  type TuiViewContext,
  type TuiViewState
} from "./view-model.js";

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

export function formatTodoView(items: RunloomTodoItem[], limit = DEFAULT_PANEL_LINES, scrollOffset = 0): string {
  if (items.length === 0) {
    return "Todo: (none)\n";
  }
  const visibleItems = visibleSlice(items, limit, scrollOffset);
  const lines = [formatPanelHeader("Todo", items.length, visibleItems.start, visibleItems.items.length, scrollOffset)];
  for (const item of visibleItems.items) {
    const evidence = item.evidence?.length ? ` evidence=${item.evidence.join(",")}` : "";
    lines.push(`  ${item.status} ${item.title}${evidence}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatStatusView(state: TuiViewState, context: TuiViewContext): string {
  const latestActivity = state.activity.at(-1) ?? "(none)";
  return [
    "Status:",
    `  session: ${context.activeSessionId ?? "(none)"}`,
    `  run: ${context.activeRunId ?? "(none)"} status=${state.runStatus}`,
    `  focus: ${state.focus}`,
    `  scroll: transcript=${state.transcriptScrollOffset}, todo=${state.todoScrollOffset}, activity=${state.activityScrollOffset}`,
    `  model: ${formatStatusModel(state, context)}`,
    `  taskType: ${context.activeTaskType ?? "(auto)"}`,
    `  language: ${context.activeLanguage ?? "(auto)"}`,
    `  todo: ${formatTodoCounts(state.todoItems)}`,
    `  latest activity: ${latestActivity}`
  ].join("\n") + "\n";
}

export function formatCompositeView(state: TuiViewState, context: TuiViewContext): string {
  return [
    formatStatusView(state, context).trimEnd(),
    formatTodoView(state.todoItems, COMPOSITE_PANEL_LINES, state.todoScrollOffset).trimEnd(),
    formatActivityView(state.activity, COMPOSITE_PANEL_LINES, state.activityScrollOffset).trimEnd(),
    formatTranscriptView(state.transcript, COMPOSITE_PANEL_LINES, state.transcriptScrollOffset).trimEnd()
  ].join("\n") + "\n";
}

export function formatTranscriptView(lines: string[], limit = DEFAULT_PANEL_LINES, scrollOffset = 0): string {
  if (lines.length === 0) {
    return "Transcript: (empty)\n";
  }
  const visibleLines = visibleSlice(lines, limit, scrollOffset);
  return `${formatPanelHeader("Transcript", lines.length, visibleLines.start, visibleLines.items.length, scrollOffset)}\n${visibleLines.items
    .map((line) => `  ${line}`)
    .join("\n")}\n`;
}

export function formatActivityView(
  lines: string[],
  limit = DEFAULT_PANEL_LINES,
  scrollOffset = 0,
  category?: ActivityCategory
): string {
  const title = category ? `Activity (${category})` : "Activity";
  if (lines.length === 0) {
    return `${title}: (none)\n`;
  }
  const visibleLines = visibleSlice(lines, limit, scrollOffset);
  return `${formatPanelHeader(title, lines.length, visibleLines.start, visibleLines.items.length, scrollOffset)}\n${visibleLines.items
    .map((line) => `  ${line}`)
    .join("\n")}\n`;
}

export function formatActivityDetail(
  records: TuiActivityRecord[],
  allRecords: TuiActivityRecord[],
  category?: ActivityCategory,
  targetText?: string,
  currentIndex?: number
): string {
  const title = category ? `Activity Detail (${category})` : "Activity Detail";
  if (records.length === 0) {
    return `${title}: (none)\n`;
  }

  const resolved = resolveActivityDetailTarget(records, targetText, currentIndex);
  if ("error" in resolved) {
    return `${resolved.error}\n${formatActivityCommandHelp()}`;
  }

  const absoluteIndex = allRecords.indexOf(resolved.record) + 1;
  const lines = [
    `${title}: #${absoluteIndex}`,
    `  category: ${resolved.record.category}`,
    `  filteredIndex: ${resolved.index + 1}`,
    `  event: ${resolved.record.eventType ?? "(none)"}`,
    `  run: ${resolved.record.runId ?? "(none)"}`,
    `  session: ${resolved.record.sessionId ?? "(none)"}`,
    `  source: ${resolved.record.source ?? "(none)"}`,
    `  timestamp: ${resolved.record.timestamp ?? "(none)"}`,
    `  line: ${resolved.record.line}`,
    "  payload:",
    indentBlock(formatUnknownValue(resolved.record.payload), 4)
  ];
  return `${lines.join("\n")}\n`;
}

export function resolveActivityDetailTarget(
  records: TuiActivityRecord[],
  targetText?: string,
  currentIndex?: number
): { record: TuiActivityRecord; index: number } | { error: string } {
  const target = targetText?.trim().toLowerCase();
  if (!target || target === "latest" || target === "last") {
    const index = records.length - 1;
    return { record: records[index], index };
  }

  if (target === "current" || target === "selected" || target === "." || target === "visible") {
    const index = clamp(currentIndex ?? records.length - 1, 0, records.length - 1);
    return { record: records[index], index };
  }

  const parsed = Number(target);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > records.length) {
    return {
      error: `Invalid activity selection: ${targetText ?? "(missing)"}`
    };
  }

  const index = parsed - 1;
  return { record: records[index], index };
}

export function formatStatusModel(state: TuiViewState, context: Pick<TuiViewContext, "activeModel" | "activeProfile">): string {
  if (context.activeModel) {
    return `${context.activeModel} override`;
  }
  if (context.activeProfile) {
    return `profile:${context.activeProfile}`;
  }
  if (state.latestModel?.providerId || state.latestModel?.model) {
    return `${state.latestModel.providerId ?? "unknown"}:${state.latestModel.model ?? "unknown"}`;
  }
  return "(auto)";
}

export function formatTodoCounts(items: RunloomTodoItem[]): string {
  if (items.length === 0) {
    return "none";
  }

  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ");
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

export function formatApprovalRequest(payload: unknown): string {
  const request = payload as { id?: string; scope?: string; mode?: string; summary?: string };
  return `${request.id ?? "unknown"} scope=${request.scope ?? "unknown"} mode=${request.mode ?? "unknown"} ${request.summary ?? ""}`;
}

export function formatApprovalResolution(payload: unknown): string {
  const resolution = payload as { approvalId?: string; decision?: { decision?: string } };
  return `${resolution.approvalId ?? "unknown"} decision=${resolution.decision?.decision ?? "unknown"}`;
}

export function formatWaitingApproval(payload: unknown): string {
  const waiting = payload as { approvalId?: string };
  return waiting.approvalId ? `approval=${waiting.approvalId}` : "";
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

export function formatApprovalPolicy(policy: ApprovalPolicyConfig): string {
  const lines = [`Approval policy: default=${policy.defaultMode}`];
  for (const [scope, mode] of Object.entries(policy.scopes)) {
    lines.push(`  ${scope}: ${mode}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatApprovalPolicyPanel(policy: ApprovalPolicyConfig): string {
  const scopeWidth = Math.max("scope".length, ...PERMISSION_SCOPES.map((scope) => scope.length));
  const modeWidth = Math.max("mode".length, ...APPROVAL_MODES.map((mode) => mode.length));
  const lines = [
    "Approval Policy:",
    `  default: ${policy.defaultMode}`,
    `  updated: ${policy.updatedAt} by ${policy.updatedBy}`,
    `  ${"scope".padEnd(scopeWidth)}  ${"mode".padEnd(modeWidth)}  source`
  ];

  for (const scope of PERMISSION_SCOPES) {
    const configuredMode = policy.scopes[scope];
    const mode = configuredMode ?? policy.defaultMode;
    const source = configuredMode ? "override" : "default";
    lines.push(`  ${scope.padEnd(scopeWidth)}  ${mode.padEnd(modeWidth)}  ${source}`);
  }

  lines.push("  commands: /permissions set <scope|default> <full_access|ask|auto_decide>");
  return `${lines.join("\n")}\n`;
}

export function formatTools(tools: ToolSummary[]): string {
  if (tools.length === 0) {
    return "No tools registered.\n";
  }
  const lines = ["Tools:"];
  for (const tool of tools) {
    const permissions = tool.permissions.length ? tool.permissions.join(", ") : "none";
    lines.push(`  ${tool.name} - ${tool.description} [${permissions}]`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatApprovals(approvals: ApprovalRequest[], focusedApprovalId?: string): string {
  if (approvals.length === 0) {
    return "Approvals: (none pending)\n";
  }
  const focus = focusedApprovalId ? ` focused=${focusedApprovalId}` : "";
  const lines = [`Approval Center: ${approvals.length} pending${focus}`];
  for (const approval of approvals) {
    const expires = approval.expiresAt ? ` expires=${approval.expiresAt}` : "";
    const marker = approval.id === focusedApprovalId ? "*" : " ";
    lines.push(`${marker} ${approval.id} risk=${approval.risk} scope=${approval.scope} mode=${approval.mode}${expires}`);
    lines.push(`    action=${approval.action} run=${approval.runId} session=${approval.sessionId}`);
    lines.push(`    summary: ${approval.summary}`);
    lines.push(
      `    commands: /approve ${approval.id} once | /approve ${approval.id} session | /deny ${approval.id} <reason> | /approvals view ${approval.id}`
    );
  }
  lines.push("  selection: /approvals next | /approvals prev | /approvals view | /approve selected once | /deny selected <reason>");
  return `${lines.join("\n")}\n`;
}

export function formatApprovalDetail(approval: ApprovalRequest): string {
  const lines = [
    `Approval: ${approval.id}`,
    `  action: ${approval.action}`,
    `  scope: ${approval.scope}`,
    `  risk: ${approval.risk}`,
    `  mode: ${approval.mode}`,
    `  run: ${approval.runId}`,
    `  session: ${approval.sessionId}`,
    `  summary: ${approval.summary}`
  ];
  if (approval.expiresAt) {
    lines.push(`  expiresAt: ${approval.expiresAt}`);
  }
  lines.push("  details:");
  lines.push(indentBlock(formatUnknownValue(approval.details), 4));
  lines.push(`  commands: /approve ${approval.id} once | /approve ${approval.id} session | /deny ${approval.id} <reason>`);
  return `${lines.join("\n")}\n`;
}

export function formatSkills(skills: RunloomSkillSummary[], proposals: RunloomSkillProposal[] = []): string {
  if (skills.length === 0 && proposals.length === 0) {
    return "Skills: (none registered)\n";
  }
  const lines = ["Skills:"];
  for (const skill of skills) {
    const state = skill.enabled ? "enabled" : "disabled";
    const version = skill.version ? `@${skill.version}` : "";
    const requiredTools = skill.requiredTools?.length ? ` tools=${skill.requiredTools.join(",")}` : "";
    const permissions = formatSkillPermissions(skill.permissions);
    const diagnostics = skill.diagnostics?.length ? ` diagnostics=${skill.diagnostics.join("; ")}` : "";
    lines.push(
      `  ${skill.name}${version} ${state} source=${skill.source}${requiredTools}${permissions}${diagnostics} - ${skill.description}`
    );
  }
  if (proposals.length > 0) {
    lines.push("Skill proposals:");
    for (const proposal of proposals) {
      const approval = proposal.approvalId ? ` approval=${proposal.approvalId}` : "";
      const diagnostics = proposal.diagnostics?.length ? ` diagnostics=${proposal.diagnostics.join("; ")}` : "";
      lines.push(
        `  ${proposal.id} ${proposal.status} ${proposal.changeType} skill=${proposal.skillName} risk=${proposal.risk.level}${approval}${diagnostics}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatSkillPermissions(permissions: RunloomSkillSummary["permissions"]): string {
  if (!permissions) {
    return "";
  }
  const entries: string[] = [];
  if (permissions.readWorkspace !== undefined) {
    entries.push(`readWorkspace:${permissions.readWorkspace}`);
  }
  if (permissions.writeWorkspace !== undefined) {
    entries.push(`writeWorkspace:${permissions.writeWorkspace}`);
  }
  if (permissions.shell !== undefined) {
    entries.push(`shell:${permissions.shell}`);
  }
  return entries.length ? ` permissions=${entries.join(",")}` : "";
}

export function formatMcpServers(servers: McpServerSummary[]): string {
  if (servers.length === 0) {
    return "MCP servers: (none registered)\n";
  }
  const lines = ["MCP servers:"];
  for (const server of servers) {
    const state = server.enabled ? "enabled" : "disabled";
    const tools = server.tools?.length ? ` tools=${server.tools.join(",")}` : "";
    const inventory = `resources=${server.resources ?? 0} prompts=${server.prompts ?? 0}`;
    const permissions = server.permissions
      ? ` permissions=tools:${server.permissions.tools},resources:${server.permissions.resources},prompts:${server.permissions.prompts}`
      : "";
    const error = server.error ? ` error=${server.error}` : "";
    lines.push(`  ${server.name} ${state} transport=${server.transport} status=${server.status}${tools} ${inventory}${permissions}${error}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatA2APeers(peers: A2APeerSummary[]): string {
  if (peers.length === 0) {
    return "A2A peers: (none registered)\n";
  }
  const lines = ["A2A peers:"];
  for (const peer of peers) {
    const state = peer.enabled ? "enabled" : "disabled";
    const transport = peer.transport ? ` transport=${peer.transport}` : "";
    const endpoint = peer.endpoint ? ` endpoint=${peer.endpoint}` : "";
    const version = peer.version ? ` version=${peer.version}` : "";
    const capabilities = peer.capabilities?.length
      ? ` capabilities=${peer.capabilities.map((capability) => capability.name).join(",")}`
      : "";
    const error = peer.error ? ` error=${peer.error}` : "";
    lines.push(
      `  ${peer.name} ${state} status=${peer.status}${transport}${endpoint}${version}${capabilities}${error} id=${peer.id}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatExternalAgents(agents: ExternalAgentSummary[]): string {
  if (agents.length === 0) {
    return "External agents: (none registered)\n";
  }
  const lines = ["External agents:"];
  for (const agent of agents) {
    const state = agent.enabled ? "enabled" : "disabled";
    const capabilities = agent.capabilities?.length ? ` capabilities=${agent.capabilities.join(",")}` : "";
    const command = agent.command ? ` command=${agent.command}` : "";
    const maxTurns = agent.maxTurns ? ` maxTurns=${agent.maxTurns}` : "";
    const error = agent.error ? ` error=${agent.error}` : "";
    lines.push(
      `  ${agent.name} ${state} kind=${agent.kind} status=${agent.status}${capabilities}${command}${maxTurns}${error} - ${agent.description}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatCurrentSession(session: RunloomSession, activeRunId?: string): string {
  return [
    `Session: ${session.id}`,
    `  workspace: ${session.workspace}`,
    `  createdAt: ${session.createdAt}`,
    `  updatedAt: ${session.updatedAt}`,
    `  activeRun: ${activeRunId ?? "(none)"}`
  ].join("\n") + "\n";
}

export function formatSessions(sessions: RunloomSession[], activeSessionId?: string): string {
  if (sessions.length === 0) {
    return "Sessions: (none)\n";
  }
  const lines = ["Sessions:"];
  for (const session of sessions) {
    const marker = session.id === activeSessionId ? "*" : " ";
    lines.push(`${marker} ${session.id} updated=${session.updatedAt} workspace=${session.workspace}`);
  }
  return `${lines.join("\n")}\n`;
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

export function formatActiveModelState(model?: string, profile?: string, taskType?: string, language?: string): string {
  return [
    "Model overrides:",
    `  model: ${model ?? "(auto)"}`,
    `  profile: ${profile ?? "(auto)"}`,
    `  taskType: ${taskType ?? "(auto)"}`,
    `  language: ${language ?? "(auto)"}`
  ].join("\n") + "\n";
}

export function formatPanelHeader(name: string, total: number, start: number, count: number, scrollOffset: number): string {
  if (total <= count && scrollOffset === 0) {
    return `${name}:`;
  }
  const first = count > 0 ? start + 1 : 0;
  const last = start + count;
  const offset = scrollOffset > 0 ? ` offset=${scrollOffset}` : "";
  return `${name}: showing ${first}-${last} of ${total}${offset}`;
}

export function formatUnknownValue(value: unknown): string {
  if (value === undefined) {
    return "(none)";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function indentBlock(value: string, spaces: number): string {
  const padding = " ".repeat(spaces);
  return value
    .split(/\r?\n/)
    .map((line) => `${padding}${line}`)
    .join("\n");
}
