import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";
import type { ModelProviderEvent, ModelRequest } from "../src/index.js";

describe("Runloom MCP server projection", () => {
  it("exposes read-only tools, skills, memory query, and prompts", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: ""
    });

    try {
      await agent.registerSkill({
        name: "typescript-code-review",
        version: "0.1.0",
        description: "Review TypeScript changes.",
        enabled: true,
        source: "registered",
        triggers: ["review TypeScript"],
        instructions: "Review TypeScript changes carefully."
      });

      const server = agent.createMcpServer();
      const tools = await server.listTools();
      const resources = await server.listResources();
      const skills = await server.readResource("runloom://skills");
      const memory = await server.callTool("runloom.memory.query", { query: "review", limit: 3 });
      const prompt = await server.getPrompt("runloom.code-review", { topic: "public API" });
      const resourceAudits = await agent.listAuditRecords({ action: "mcp.server.resource.read" });
      const toolAudits = await agent.listAuditRecords({ action: "mcp.server.tool.called" });

      expect(tools.map((tool) => tool.name)).toContain("fs.read");
      expect(tools.map((tool) => tool.name)).toContain("runloom.memory.query");
      expect(tools.map((tool) => tool.name)).not.toContain("shell.verify");
      expect(tools.map((tool) => tool.name)).not.toContain("runloom.agent.submit");
      expect(resources.map((resource) => resource.uri)).toContain("runloom://skills");
      expect(resources.map((resource) => resource.uri)).toContain("runloom://memory");
      expect(skills.structuredContent).toMatchObject({
        skills: [
          {
            name: "typescript-code-review",
            source: "registered"
          }
        ]
      });
      expect(memory.status).toBe("completed");
      expect(memory.structuredContent).toMatchObject({
        query: "review",
        records: [],
        status: "unavailable"
      });
      expect(prompt.messages[0]?.content[0]?.text).toMatch(/public API/);
      expect(resourceAudits[0]?.summary).toBe("MCP server resource read: runloom://skills.");
      expect(toolAudits[0]?.summary).toBe("MCP server tool called: runloom.memory.query.");
    } finally {
      await agent.close();
    }
  });

  it("routes exposed Runloom tool calls through approval instead of executing directly", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: ""
    });

    try {
      const server = agent.createMcpServer({ readOnly: false });
      const tools = await server.listTools();
      const result = await server.callTool("shell.verify", { command: "node", args: ["--version"] });
      const approvals = await agent.listApprovals();
      const auditRecords = await agent.listAuditRecords({ action: "mcp.server.tool.called" });

      expect(tools.map((tool) => tool.name)).toContain("shell.verify");
      expect(result.status).toBe("waiting_approval");
      expect(result.approvalId).toBeTruthy();
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        scope: "shell",
        action: "tool:shell.verify"
      });
      expect(auditRecords[0]?.details).toMatchObject({
        toolName: "shell.verify",
        status: "waiting_approval"
      });
    } finally {
      await agent.close();
    }
  });

  it("exposes agent service calls when explicitly enabled", async () => {
    const provider = new RecordingProvider();
    const agent = await createRunloomAgent({
      provider,
      model: "gpt-4.1",
      workspace: process.cwd()
    });

    try {
      const server = agent.createMcpServer({ readOnly: false, exposeAgentService: true });
      const tools = await server.listTools();
      const result = await server.callTool("runloom.agent.submit", { text: "say hello" });
      const auditRecords = await agent.listAuditRecords({ action: "mcp.server.tool.called" });

      expect(tools.map((tool) => tool.name)).toContain("runloom.agent.submit");
      expect(result.status).toBe("completed");
      expect(result.structuredContent).toMatchObject({
        outputText: "hello from agent service"
      });
      expect(provider.requests).toHaveLength(1);
      expect(auditRecords[0]?.summary).toBe("MCP server tool called: runloom.agent.submit.");
    } finally {
      await agent.close();
    }
  });
});

class RecordingProvider {
  id = "mcp-server-agent-service-provider";
  protocol = "custom" as const;
  capabilities = {
    streaming: false,
    tools: true
  };
  requests: ModelRequest[] = [];

  async *createResponse(request: ModelRequest): AsyncIterable<ModelProviderEvent> {
    this.requests.push(request);
    yield { type: "response.created", responseId: "resp_mcp_server_agent_service" };
    yield { type: "response.output_text.delta", delta: "hello from agent service" };
    yield { type: "response.completed", finishReason: "stop" };
  }
}
