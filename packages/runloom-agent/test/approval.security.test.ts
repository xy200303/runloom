import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";
import { createDefaultApprovalPolicy } from "../src/approvals/policy.js";
import { ToolExecutor } from "../src/tools/tool-executor.js";
import type { ApprovalRequest, ModelProvider, ModelRequest, ToolDefinition } from "../src/types.js";

describe("approval security", () => {
  it("requires approval for high-risk shell tools in auto_decide mode", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      workspace: process.cwd(),
      apiKey: "",
      approvalPolicy: {
        scopes: {
          shell: "auto_decide"
        }
      }
    });

    const result = await agent.executeTool("shell.verify", {
      command: "node",
      args: ["--version"]
    });

    expect(result.status).toBe("waiting_approval");
    expect(result.approvalId).toMatch(/^approval_/);
    await agent.close();
  });

  it("allows low-risk read tools in auto_decide mode", async () => {
    const approvals: ApprovalRequest[] = [];
    const events: string[] = [];
    const executor = new ToolExecutor({
      workspace: process.cwd(),
      getApprovalPolicy: () =>
        createDefaultApprovalPolicy({
          scopes: {
            "filesystem.read": "auto_decide"
          }
        }),
      saveApproval: (request) => approvals.push(request),
      emit: (type) => events.push(type)
    });
    const tool: ToolDefinition<Record<string, never>, { ok: true }> = {
      name: "low.read",
      description: "Low-risk read",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      permissions: ["filesystem.read"],
      async execute() {
        return { ok: true };
      }
    };

    const result = await executor.execute(tool, {}, {
      runId: "run_security",
      sessionId: "ses_security"
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ ok: true });
    expect(approvals).toHaveLength(0);
    expect(events).toContain("tool.call.completed");
    expect(events).not.toContain("approval.requested");
  });

  it("blocks filesystem tools from reading outside the workspace", async () => {
    await withTempWorkspace(async (workspace, root) => {
      await writeFile(join(root, "outside-secret.txt"), "outside");
      const agent = await createRunloomAgent({
        provider: "openai-responses",
        workspace,
        apiKey: ""
      });

      const result = await agent.executeTool("fs.read", {
        path: "../outside-secret.txt"
      });

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/outside the workspace/);
      await agent.close();
    });
  });

  it("redacts secret-like values from tool output and events", async () => {
    await withTempWorkspace(async (workspace) => {
      const rawSecret = "sk-testsecret1234567890";
      const rawJsonSecret = "json-value-12345";
      await writeFile(
        join(workspace, "secret.env"),
        `OPENAI_API_KEY=${rawSecret}\n{"apiKey":"${rawJsonSecret}"}\nPUBLIC_VALUE=ok\n`
      );
      const agent = await createRunloomAgent({
        provider: "openai-responses",
        workspace,
        apiKey: ""
      });

      const result = await agent.executeTool<{ content: string }>("fs.read", {
        path: "secret.env"
      });
      const events = await agent.listEvents({ sessionId: result.sessionId });
      const eventText = JSON.stringify(events);

      expect(result.status).toBe("completed");
      expect(result.output?.content).not.toContain(rawSecret);
      expect(result.output?.content).not.toContain(rawJsonSecret);
      expect(result.output?.content).toContain("OPENAI_API_KEY=[redacted:secret]");
      expect(result.output?.content).toContain('"apiKey":"[redacted:secret]"');
      expect(eventText).not.toContain(rawSecret);
      expect(eventText).not.toContain(rawJsonSecret);
      expect(eventText).toContain("[redacted:secret]");
      await agent.close();
    });
  });

  it("redacts model-visible workspace context and tool results", async () => {
    await withTempWorkspace(async (workspace) => {
      const rawSecret = "sk-toolresult1234567890";
      const provider = new SecretReadingProvider();
      await writeFile(join(workspace, "secret.env"), `API_TOKEN=${rawSecret}\n`);
      const agent = await createRunloomAgent({
        provider,
        workspace
      });

      const result = await agent.submit("Read secret.env and continue.");
      const secondRequestOutput = provider.requests[1]?.input?.find((item) => item.type === "function_call_output");
      const firstRequestText = JSON.stringify(provider.requests[0]?.input ?? []);
      const toolOutput = secondRequestOutput?.type === "function_call_output" ? secondRequestOutput.output : "";

      expect(result.status).toBe("completed");
      expect(firstRequestText).not.toContain(workspace);
      expect(firstRequestText).toContain("[workspace]");
      expect(toolOutput).not.toContain(rawSecret);
      expect(toolOutput).toContain("API_TOKEN=[redacted:secret]");
      await agent.close();
    });
  });
});

class SecretReadingProvider implements ModelProvider {
  id = "secret-reading-provider";
  protocol = "custom" as const;
  capabilities = {
    streaming: false,
    tools: true
  };
  requests: ModelRequest[] = [];

  async *createResponse(request: ModelRequest) {
    this.requests.push(request);

    if (this.requests.length === 1) {
      yield {
        type: "response.tool_call.completed" as const,
        toolCallId: "call_read_secret",
        name: "fs.read",
        arguments: { path: "secret.env" }
      };
      yield { type: "response.completed" as const, finishReason: "tool_calls" as const };
      return;
    }

    yield { type: "response.output_text.delta" as const, delta: "done" };
    yield { type: "response.completed" as const, finishReason: "stop" as const };
  }
}

async function withTempWorkspace(callback: (workspace: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "runloom-security-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  try {
    await callback(workspace, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
