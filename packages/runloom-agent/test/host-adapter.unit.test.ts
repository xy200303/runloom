import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";
import type { ModelProviderEvent, ModelRequest, RunloomCommand, TerminalEvent } from "../src/index.js";

describe("host adapters", () => {
  it("uses host workspace and diagnostics adapters without depending on UI packages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-host-workspace-"));
    const provider = new RecordingProvider();
    const agent = await createRunloomAgent({
      provider,
      model: "gpt-4.1",
      workspace: process.cwd(),
      host: {
        kind: "custom",
        workspace: {
          root: workspace,
          kind: "virtual",
          async readFile(path) {
            expect(path).toBe("package.json");
            return {
              path,
              content: JSON.stringify({ name: "host-workspace" }),
              encoding: "utf8"
            };
          },
          async getGitStatus() {
            return {
              branch: "host-branch",
              isRepository: true,
              isDirty: true,
              changedFiles: ["src/host.ts"]
            };
          }
        },
        diagnostics: {
          async getDiagnostics(context) {
            expect(context?.workspace).toBe(workspace);
            return [
              {
                path: "src/host.ts",
                severity: "error",
                message: "Host diagnostic from Problems.",
                source: "host",
                line: 7,
                column: 3
              }
            ];
          }
        }
      }
    });

    try {
      const result = await agent.submit("summarize host context");
      const userMessage = provider.requests[0]?.input?.find((item) => item.type === "message" && item.role === "user");
      const events = await agent.listEvents({ runId: result.runId });
      const inspected = events.find((event) => event.type === "coding.workspace.inspected");
      const diagnostics = events.find((event) => event.type === "coding.diagnostics.loaded");
      const session = await agent.getSession(result.sessionId);

      expect(result.status).toBe("completed");
      expect(session.workspace).toBe(workspace);
      expect(inspected?.payload).toMatchObject({
        workspace: "[workspace]",
        packageName: "host-workspace",
        git: {
          branch: "host-branch",
          changedFiles: ["src/host.ts"]
        }
      });
      expect(diagnostics?.payload).toMatchObject({
        count: 1
      });
      expect(userMessage?.content[0]?.text).toMatch(/host-workspace/);
      expect(userMessage?.content[0]?.text).toMatch(/Host diagnostics:/);
      expect(userMessage?.content[0]?.text).toMatch(/src\/host\.ts:7:3/);
    } finally {
      await agent.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes shell verification through host terminal adapter after approval policy allows it", async () => {
    const commands: RunloomCommand[] = [];
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: "",
      approvalPolicy: {
        scopes: {
          shell: "full_access"
        }
      },
      host: {
        kind: "custom",
        terminal: {
          async *run(command): AsyncIterable<TerminalEvent> {
            commands.push(command);
            yield { type: "started", command: command.command, args: command.args, cwd: command.cwd };
            yield { type: "stdout", text: "adapter ok\n" };
            yield { type: "stderr", text: "" };
            yield { type: "exit", exitCode: 0, durationMs: 1 };
          }
        }
      }
    });

    try {
      const result = await agent.executeTool("shell.verify", { command: "node", args: ["--version"] });

      expect(result.status).toBe("completed");
      expect(result.output).toMatchObject({
        exitCode: 0,
        stdout: "adapter ok\n"
      });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        command: "node",
        args: ["--version"]
      });
    } finally {
      await agent.close();
    }
  });

  it("notifies approval bridges when policy changes", async () => {
    const policies: string[] = [];
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: "",
      host: {
        kind: "custom",
        approvals: {
          async requestApproval() {
            return { decision: "approved" };
          },
          onPolicyUpdated(policy) {
            policies.push(policy.scopes.shell ?? policy.defaultMode);
          }
        }
      }
    });

    try {
      await agent.updateApprovalPolicy({
        scopes: {
          shell: "full_access"
        }
      });

      expect(policies).toEqual(["full_access"]);
    } finally {
      await agent.close();
    }
  });
});

class RecordingProvider {
  id = "host-adapter-provider";
  protocol = "custom" as const;
  capabilities = {
    streaming: false,
    tools: true
  };
  requests: ModelRequest[] = [];

  async *createResponse(request: ModelRequest): AsyncIterable<ModelProviderEvent> {
    this.requests.push(request);
    yield { type: "response.created", responseId: "resp_host_adapter" };
    yield { type: "response.output_text.delta", delta: "host context captured" };
    yield { type: "response.completed", finishReason: "stop" };
  }
}
