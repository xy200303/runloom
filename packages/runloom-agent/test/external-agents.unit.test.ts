import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createClaudeCodeExternalAgentAdapter,
  createCodexExternalAgentAdapter,
  createLocalCliExternalAgentAdapter,
  createRunloomAgent
} from "../src/index.js";

describe("external agent adapters", () => {
  it("creates a default Codex CLI adapter descriptor", () => {
    const adapter = createCodexExternalAgentAdapter();

    expect(adapter).toEqual({
      name: "codex",
      description: "Codex CLI",
      kind: "local_cli",
      enabled: true,
      status: "available",
      capabilities: ["code_review", "edit"],
      command: "codex",
      maxTurns: 3,
      error: undefined
    });
    expect(adapter.delegate).toBeUndefined();
  });

  it("creates a default Claude Code CLI adapter descriptor", () => {
    const adapter = createClaudeCodeExternalAgentAdapter();

    expect(adapter).toEqual({
      name: "claude-code",
      description: "Claude Code CLI",
      kind: "local_cli",
      enabled: true,
      status: "available",
      capabilities: ["code_review", "edit"],
      command: "claude",
      maxTurns: 3,
      error: undefined
    });
    expect(adapter.delegate).toBeUndefined();
  });

  it("creates a generic local CLI adapter descriptor", () => {
    const capabilities = ["code_review", "diagnostics"];
    const adapter = createLocalCliExternalAgentAdapter({
      name: "team-reviewer",
      description: "Team review specialist",
      command: "team-reviewer",
      capabilities,
      maxTurns: 5
    });
    capabilities.push("edit");

    expect(adapter).toEqual({
      name: "team-reviewer",
      description: "Team review specialist",
      kind: "local_cli",
      enabled: true,
      status: "available",
      capabilities: ["code_review", "diagnostics"],
      command: "team-reviewer",
      maxTurns: 5,
      error: undefined
    });
    expect(adapter.delegate).toBeUndefined();
  });

  it("allows hosts to override the Codex adapter descriptor", () => {
    const capabilities = ["code_review"];
    const adapter = createCodexExternalAgentAdapter({
      name: "codex-review",
      description: "Codex review-only CLI",
      command: "codex",
      enabled: false,
      status: "disabled",
      capabilities,
      maxTurns: 1,
      error: "disabled by host"
    });
    capabilities.push("edit");

    expect(adapter).toMatchObject({
      name: "codex-review",
      description: "Codex review-only CLI",
      kind: "local_cli",
      enabled: false,
      status: "disabled",
      capabilities: ["code_review"],
      command: "codex",
      maxTurns: 1,
      error: "disabled by host"
    });
  });

  it("registers local CLI adapters through the public agent API", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: ""
    });

    try {
      await agent.registerExternalAgent(createCodexExternalAgentAdapter({ maxTurns: 2 }));
      await agent.registerExternalAgent(createClaudeCodeExternalAgentAdapter({ status: "unavailable" }));

      const agents = await agent.listExternalAgents();
      expect(agents).toEqual([
        {
          name: "claude-code",
          description: "Claude Code CLI",
          kind: "local_cli",
          enabled: true,
          status: "unavailable",
          capabilities: ["code_review", "edit"],
          command: "claude",
          maxTurns: 3,
          error: undefined
        },
        {
          name: "codex",
          description: "Codex CLI",
          kind: "local_cli",
          enabled: true,
          status: "available",
          capabilities: ["code_review", "edit"],
          command: "codex",
          maxTurns: 2,
          error: undefined
        }
      ]);
    } finally {
      await agent.close();
    }
  });

  it("delegates to registered external agents with normalized requests and audit events", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: ""
    });
    const eventTypes: string[] = [];
    let receivedRequest: unknown;
    agent.subscribe((event) => eventTypes.push(event.type));

    try {
      await agent.registerExternalAgent({
        name: "team-reviewer",
        description: "Team review specialist",
        kind: "local_cli",
        enabled: true,
        status: "available",
        capabilities: ["code_review"],
        command: "team-reviewer",
        maxTurns: 2,
        async delegate(request) {
          receivedRequest = request;
          return {
            status: "completed",
            summary: "Review complete.",
            outputText: `Reviewed workspace ${request.workspace}`,
            diagnostics: ["ok"]
          };
        }
      });

      const result = await agent.delegateExternalAgent("team-reviewer", {
        task: "Review the current change",
        workspace: ".",
        runId: "run_external",
        sessionId: "ses_external",
        maxTurns: 5,
        constraints: ["read-only"],
        context: [{ kind: "text", title: "Scope", text: "Focus on public API." }]
      });
      const auditRecords = await agent.listAuditRecords({ action: "external_agent.delegated" });

      expect(result).toMatchObject({
        status: "completed",
        summary: "Review complete.",
        outputText: "Reviewed workspace [workspace]",
        diagnostics: ["ok"]
      });
      expect(receivedRequest).toMatchObject({
        task: "Review the current change",
        workspace: resolve(process.cwd()),
        runId: "run_external",
        sessionId: "ses_external",
        maxTurns: 2,
        constraints: ["read-only"],
        context: [{ kind: "text", title: "Scope", text: "Focus on public API." }]
      });
      expect(eventTypes).toContain("external_agent.delegated");
      expect(eventTypes).toContain("external_agent.completed");
      expect(eventTypes).toContain("audit.recorded");
      expect(auditRecords[0]).toMatchObject({
        action: "external_agent.delegated",
        actor: "runtime",
        summary: "External agent delegated: team-reviewer",
        runId: "run_external",
        sessionId: "ses_external"
      });
      expect(auditRecords[0]?.details).toMatchObject({
        name: "team-reviewer",
        status: "completed",
        maxTurns: 2
      });
    } finally {
      await agent.close();
    }
  });
});
