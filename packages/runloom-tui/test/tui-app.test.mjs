import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { createRunloomTuiApp } from "../dist/index.js";

test("approval command updates scope and default modes", async () => {
  const policy = {
    defaultMode: "ask",
    scopes: {
      shell: "ask"
    },
    updatedAt: new Date().toISOString(),
    updatedBy: "user"
  };
  let closed = false;
  const submissions = [];
  const toolCalls = [];
  const cancelCalls = [];
  const sessions = [
    {
      id: "ses_tool",
      workspace: process.cwd(),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z"
    }
  ];

  const agent = {
    subscribe() {
      return () => {};
    },
    async submit(input, options) {
      submissions.push({ input, options });
      return {
        runId: "run_test",
        sessionId: "ses_test",
        status: "completed",
        outputText: ""
      };
    },
    async getApprovalPolicy() {
      return policy;
    },
    async listTools() {
      return [
        {
          name: "fs.read",
          description: "Read a file",
          inputSchema: {},
          permissions: ["filesystem.read"]
        }
      ];
    },
    async listSessions() {
      return sessions;
    },
    async getSession(sessionId) {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      return session;
    },
    async cancel(runId) {
      cancelCalls.push(runId);
    },
    async executeTool(name, input) {
      toolCalls.push({ name, input });
      if (name === "git.status") {
        return {
          toolName: name,
          runId: "run_tool",
          sessionId: "ses_tool",
          status: "completed",
          output: {
            branch: "main",
            isRepository: true,
            isDirty: false,
            changedFiles: []
          },
          durationMs: 1
        };
      }
      if (name === "shell.verify") {
        return {
          toolName: name,
          runId: "run_tool",
          sessionId: "ses_tool",
          status: "completed",
          output: {
            command: [input.command, ...(input.args ?? [])].join(" "),
            exitCode: 0,
            stdout: "tests ok\n",
            stderr: "",
            durationMs: 12
          },
          durationMs: 12
        };
      }
      if (name === "git.diff") {
        return {
          toolName: name,
          runId: "run_tool",
          sessionId: "ses_tool",
          status: "completed",
          output: {
            filesChanged: ["packages/runloom-tui/src/app/tui-app.ts"],
            additions: 4,
            deletions: 1,
            patch: "--- a/packages/runloom-tui/src/app/tui-app.ts\n+++ b/packages/runloom-tui/src/app/tui-app.ts\n@@\n-old\n+new\n"
          },
          durationMs: 2
        };
      }
      throw new Error(`Unexpected tool: ${name}`);
    },
    async updateApprovalPolicy(patch) {
      if (patch.defaultMode) {
        policy.defaultMode = patch.defaultMode;
      }
      if (patch.scopes) {
        policy.scopes = {
          ...policy.scopes,
          ...patch.scopes
        };
      }
      return policy;
    },
    async close() {
      closed = true;
    }
  };

  const output = new MemoryOutput();
  const app = createRunloomTuiApp({ agent, output });

  await app.runCommand("/approval shell full_access");
  await app.runCommand("/approval default auto_decide");
  await app.runCommand("/tools");
  await app.runCommand("/git");
  await app.runCommand("/session");
  await app.runCommand("/session list");
  app.render({
    id: "evt_todo",
    type: "todo.updated",
    runId: "run_tool",
    sessionId: "ses_tool",
    sequence: 1,
    timestamp: "2026-01-01T00:00:02.000Z",
    source: "runtime",
    payload: {
      items: [
        {
          id: "todo_test",
          title: "Check TUI commands",
          status: "in_progress",
          updatedAt: "2026-01-01T00:00:02.000Z"
        }
      ]
    }
  });
  await app.runCommand("/todo");
  await app.runCommand("/diff");
  await app.runCommand("/tests pnpm typecheck");
  await app.runCommand("/stop");
  await app.runCommand("/model profile frontend_design");
  await app.submitPrompt("设计一个前端界面");
  await app.runCommand("/model set kimi:kimi-design");
  await app.submitPrompt("继续设计界面");
  await app.runCommand("/review");
  await app.submitPrompt("审查当前代码");
  await app.runCommand("/review off");
  await app.runCommand("/model clear");
  await app.runCommand("/quit");

  const text = output.toString();
  assert.equal(policy.scopes.shell, "full_access");
  assert.equal(policy.defaultMode, "auto_decide");
  assert.equal(closed, true);
  assert.match(text, /Approval mode for shell set to full_access/);
  assert.match(text, /Approval default mode set to auto_decide/);
  assert.match(text, /fs\.read - Read a file \[filesystem\.read\]/);
  assert.match(text, /\[git\] main \(clean\)/);
  assert.match(text, /Session: ses_tool/);
  assert.match(text, /Sessions:/);
  assert.match(text, /Todo:\n  in_progress Check TUI commands/);
  assert.match(text, /Diff: 1 file\(s\), \+4\/-1/);
  assert.match(text, /packages\/runloom-tui\/src\/app\/tui-app\.ts/);
  assert.match(text, /\[tests\] pnpm typecheck exit=0 duration=12ms/);
  assert.match(text, /tests ok/);
  assert.match(text, /Stop requested for run_tool/);
  assert.match(text, /Model profile set to frontend_design/);
  assert.match(text, /Model override set to kimi:kimi-design/);
  assert.match(text, /Review mode enabled/);
  assert.match(text, /Review mode disabled/);
  assert.equal(submissions[0].input.profile, "frontend_design");
  assert.equal(submissions[0].input.model, undefined);
  assert.equal(submissions[0].options.sessionId, "ses_tool");
  assert.equal(submissions[1].input.model, "kimi:kimi-design");
  assert.equal(submissions[1].input.profile, undefined);
  assert.equal(submissions[1].options.sessionId, "ses_tool");
  assert.equal(submissions[2].input.taskType, "code_review");
  assert.equal(submissions[2].options.sessionId, "ses_tool");
  assert.deepEqual(toolCalls[0], { name: "git.status", input: {} });
  assert.deepEqual(toolCalls[1], { name: "git.diff", input: {} });
  assert.deepEqual(toolCalls[2], { name: "shell.verify", input: { command: "pnpm", args: ["typecheck"] } });
  assert.deepEqual(cancelCalls, ["run_tool"]);
});

class MemoryOutput extends Writable {
  chunks = [];

  _write(chunk, _encoding, callback) {
    this.chunks.push(String(chunk));
    callback();
  }

  toString() {
    return this.chunks.join("");
  }
}
