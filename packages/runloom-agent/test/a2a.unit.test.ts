import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";

describe("A2A peers", () => {
  it("registers and lists A2A peers through the public agent API", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: ""
    });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));

    try {
      const capabilities = [
        {
          name: "summarize-docs",
          description: "Summarize project documentation",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" }
        }
      ];

      expect(await agent.listA2APeers()).toEqual([]);
      await agent.registerA2APeer({
        id: "docs",
        name: "Documentation Agent",
        version: "0.1.0",
        endpoint: "http://127.0.0.1:43120/a2a",
        transport: "http",
        enabled: true,
        status: "available",
        capabilities
      });
      await agent.registerA2APeer({
        id: "review",
        name: "Code Review Agent",
        transport: "custom",
        enabled: false,
        status: "disabled",
        capabilities: [{ name: "review-code" }]
      });
      capabilities[0].inputSchema = { type: "string" };

      const peers = await agent.listA2APeers();
      expect(peers.map((peer) => peer.name)).toEqual(["Code Review Agent", "Documentation Agent"]);
      expect(peers[1]).toMatchObject({
        id: "docs",
        name: "Documentation Agent",
        version: "0.1.0",
        endpoint: "http://127.0.0.1:43120/a2a",
        transport: "http",
        enabled: true,
        status: "available",
        capabilities: [
          {
            name: "summarize-docs",
            description: "Summarize project documentation",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" }
          }
        ]
      });
      expect(eventTypes).toEqual(["a2a.peer.discovered", "a2a.peer.discovered"]);
    } finally {
      await agent.close();
    }
  });

  it("delegates to registered A2A peers with audit events", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: "",
      approvalPolicy: {
        scopes: {
          "a2a.delegation": "full_access"
        }
      }
    });
    const eventTypes: string[] = [];
    let delegatedTask = "";
    let delegatedWorkspace = "";
    let delegatedCapability: string | undefined;
    agent.subscribe((event) => eventTypes.push(event.type));

    try {
      await agent.registerA2APeer({
        id: "docs",
        name: "Documentation Agent",
        endpoint: "http://127.0.0.1:43120/a2a",
        transport: "http",
        enabled: true,
        status: "available",
        capabilities: [{ name: "summarize-docs" }],
        async delegate(request) {
          delegatedTask = request.task;
          delegatedWorkspace = request.workspace;
          delegatedCapability = request.capability;
          return {
            status: "completed",
            summary: "Documentation summarized.",
            outputText: "Summary complete.",
            events: [
              {
                id: "evt_peer_progress",
                type: "a2a.peer.progress",
                runId: request.runId ?? "run_a2a_delegate",
                sessionId: request.sessionId ?? "ses_a2a_delegate",
                sequence: 1,
                timestamp: "2026-01-01T00:00:00.000Z",
                source: "a2a",
                payload: {
                  step: "summarized"
                }
              }
            ]
          };
        }
      });

      const result = await agent.delegateA2APeer("docs", {
        task: " Summarize project documentation ",
        workspace: ".",
        runId: "run_a2a_delegate",
        sessionId: "ses_a2a_delegate",
        capability: "summarize-docs",
        constraints: ["Do not reveal secrets"],
        context: [{ kind: "text", title: "README", text: "Project documentation" }]
      });
      const auditRecords = await agent.listAuditRecords({ action: "a2a.delegated" });

      expect(result).toMatchObject({
        status: "completed",
        summary: "Documentation summarized.",
        outputText: "Summary complete."
      });
      expect(delegatedTask).toBe("Summarize project documentation");
      expect(delegatedWorkspace).toBe(process.cwd());
      expect(delegatedCapability).toBe("summarize-docs");
      expect(eventTypes).toContain("a2a.delegated");
      expect(eventTypes).toContain("a2a.event");
      expect(eventTypes).toContain("a2a.completed");
      expect(eventTypes).toContain("audit.recorded");
      expect(auditRecords[0]).toMatchObject({
        action: "a2a.delegated",
        runId: "run_a2a_delegate",
        sessionId: "ses_a2a_delegate"
      });
      expect(auditRecords[0]?.details).toMatchObject({
        peerId: "docs",
        status: "completed",
        capability: "summarize-docs",
        eventCount: 1
      });
    } finally {
      await agent.close();
    }
  });

  it("requests approval before delegating to A2A peers by default", async () => {
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
      await agent.registerA2APeer({
        id: "approval-docs",
        name: "Approval Documentation Agent",
        enabled: true,
        status: "available",
        capabilities: [{ name: "summarize-docs" }],
        async delegate() {
          delegateCalls += 1;
          return {
            status: "completed",
            summary: "Approved A2A delegation complete."
          };
        }
      });

      const request = {
        task: "Summarize docs after approval",
        workspace: ".",
        runId: "run_a2a_approval",
        sessionId: "ses_a2a_approval",
        capability: "summarize-docs"
      };
      const waiting = await agent.delegateA2APeer("approval-docs", request);
      const approvals = await agent.listApprovals();

      expect(waiting.status).toBe("waiting_approval");
      expect(waiting.approvalId).toBeTruthy();
      expect(delegateCalls).toBe(0);
      expect(approvals[0]).toMatchObject({
        id: waiting.approvalId,
        scope: "a2a.delegation",
        action: "a2a:approval-docs",
        risk: "high",
        mode: "ask"
      });
      expect(eventTypes).toContain("approval.requested");
      expect(eventTypes).toContain("a2a.approval_requested");

      await agent.resolveApproval(waiting.approvalId ?? "", { decision: "approved" });
      const completed = await agent.delegateA2APeer("approval-docs", {
        ...request,
        approvalId: waiting.approvalId
      });

      expect(completed.status).toBe("completed");
      expect(delegateCalls).toBe(1);
      expect(eventTypes).toContain("approval.resolved");
      expect(eventTypes).toContain("a2a.approved");
      expect(eventTypes).toContain("a2a.completed");
    } finally {
      await agent.close();
    }
  });
});
