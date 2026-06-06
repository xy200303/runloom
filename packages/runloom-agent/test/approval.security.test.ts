import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";
import { createDefaultApprovalPolicy } from "../src/approvals/policy.js";
import { ToolExecutor } from "../src/tools/tool-executor.js";
import type { ApprovalRequest, ToolDefinition } from "../src/types.js";

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
});
