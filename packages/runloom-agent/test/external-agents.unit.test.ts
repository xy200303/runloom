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
      apiKey: "",
      approvalPolicy: {
        scopes: {
          external_agents: "full_access"
        }
      }
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
      apiKey: "",
      approvalPolicy: {
        scopes: {
          external_agents: "full_access"
        }
      }
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
            changedFiles: ["packages/runloom-agent/src/types.ts"],
            verificationNotes: ["unit tests passed"],
            events: [
              {
                id: "evt_external_step",
                type: "external.step",
                runId: "run_external",
                sessionId: "ses_external",
                sequence: 1,
                timestamp: "2026-01-01T00:00:00.000Z",
                source: "external_agent",
                payload: {
                  message: `Read workspace ${request.workspace}`
                }
              }
            ],
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
        expectedOutput: {
          format: "report",
          requireChangedFilesSummary: true,
          requireVerificationNotes: true
        },
        context: [{ kind: "text", title: "Scope", text: "Focus on public API." }]
      });
      const auditRecords = await agent.listAuditRecords({ action: "external_agent.delegated" });

      expect(result).toMatchObject({
        status: "completed",
        summary: "Review complete.",
        outputText: "Reviewed workspace [workspace]",
        changedFiles: ["packages/runloom-agent/src/types.ts"],
        verificationNotes: ["unit tests passed"],
        diagnostics: ["ok"]
      });
      expect(receivedRequest).toMatchObject({
        task: "Review the current change",
        workspace: resolve(process.cwd()),
        runId: "run_external",
        sessionId: "ses_external",
        maxTurns: 2,
        constraints: ["read-only"],
        expectedOutput: {
          format: "report",
          requireChangedFilesSummary: true,
          requireVerificationNotes: true
        },
        context: [{ kind: "text", title: "Scope", text: "Focus on public API." }]
      });
      expect(eventTypes).toContain("external_agent.delegated");
      expect(eventTypes).toContain("external_agent.event");
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
        maxTurns: 2,
        eventCount: 1
      });
    } finally {
      await agent.close();
    }
  });

  it("fails completed external delegations that violate the output contract", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: "",
      approvalPolicy: {
        scopes: {
          external_agents: "full_access"
        }
      }
    });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));

    try {
      await agent.registerExternalAgent({
        name: "contract-agent",
        description: "Contract checked external agent",
        kind: "local_cli",
        enabled: true,
        status: "available",
        command: "contract-agent",
        async delegate() {
          return {
            status: "completed",
            summary: "Review complete.",
            outputText: "No changed files included."
          };
        }
      });

      const result = await agent.delegateExternalAgent("contract-agent", {
        task: "Review the current change",
        workspace: ".",
        runId: "run_external_contract",
        sessionId: "ses_external_contract",
        expectedOutput: {
          format: "report",
          requireChangedFilesSummary: true,
          requireVerificationNotes: true
        }
      });

      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(/output contract failed/);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining(["changed files summary is required", "verification notes are required"])
      );
      expect(eventTypes).toContain("external_agent.failed");
    } finally {
      await agent.close();
    }
  });

  it("requests approval before delegating to external agents by default", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: ""
    });
    const eventTypes: string[] = [];
    let delegateCalls = 0;
    agent.subscribe((event) => eventTypes.push(event.type));

    try {
      await agent.registerExternalAgent({
        name: "approval-agent",
        description: "Approval gated external agent",
        kind: "local_cli",
        enabled: true,
        status: "available",
        command: "approval-agent",
        async delegate() {
          delegateCalls += 1;
          return {
            status: "completed",
            summary: "Approved delegation complete."
          };
        }
      });

      const request = {
        task: "Review the current change",
        workspace: ".",
        runId: "run_external_approval",
        sessionId: "ses_external_approval"
      };
      const waiting = await agent.delegateExternalAgent("approval-agent", request);
      const approvals = await agent.listApprovals();

      expect(waiting.status).toBe("waiting_approval");
      expect(waiting.approvalId).toBeTruthy();
      expect(delegateCalls).toBe(0);
      expect(approvals[0]).toMatchObject({
        id: waiting.approvalId,
        scope: "external_agents",
        action: "external_agent:approval-agent",
        risk: "high",
        mode: "ask"
      });
      expect(eventTypes).toContain("approval.requested");
      expect(eventTypes).toContain("external_agent.approval_requested");

      await agent.resolveApproval(waiting.approvalId ?? "", { decision: "approved" });
      const completed = await agent.delegateExternalAgent("approval-agent", {
        ...request,
        approvalId: waiting.approvalId
      });

      expect(completed.status).toBe("completed");
      expect(delegateCalls).toBe(1);
      expect(eventTypes).toContain("approval.resolved");
      expect(eventTypes).toContain("external_agent.approved");
      expect(eventTypes).toContain("external_agent.completed");
    } finally {
      await agent.close();
    }
  });
});
