import type {
  A2APeerSummary,
  ExternalAgentSummary,
  McpServerSummary,
  RunloomSkillProposal,
  RunloomSkillSummary,
  ToolSummary
} from "runloom-agent";

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
