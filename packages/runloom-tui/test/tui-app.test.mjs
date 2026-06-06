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
  const resumeCalls = [];
  const approvalDecisions = [];
  const listEventCalls = [];
  let pendingApprovals = [
    {
      id: "approval_test",
      runId: "run_tool",
      sessionId: "ses_tool",
      scope: "shell",
      action: "tool:shell.verify",
      risk: "high",
      mode: "ask",
      summary: "Runloom wants to execute shell.verify.",
      details: {
        command: "pnpm test",
        cwd: process.cwd()
      }
    },
    {
      id: "approval_deny",
      runId: "run_tool",
      sessionId: "ses_tool",
      scope: "filesystem.write",
      action: "tool:fs.write",
      risk: "critical",
      mode: "ask",
      summary: "Runloom wants to write a file.",
      details: {
        path: "src/generated.ts"
      }
    },
    {
      id: "approval_once",
      runId: "run_tool",
      sessionId: "ses_tool",
      scope: "filesystem.read",
      action: "tool:fs.read",
      risk: "low",
      mode: "ask",
      summary: "Runloom wants to read a file.",
      details: {
        path: "src/index.ts"
      }
    }
  ];
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
    async listApprovals() {
      return pendingApprovals;
    },
    async resolveApproval(approvalId, decision) {
      approvalDecisions.push({ approvalId, decision });
      pendingApprovals = pendingApprovals.filter((approval) => approval.id !== approvalId);
    },
    async listSkills() {
      return [
        {
          name: "typescript-code-review",
          version: "0.1.0",
          description: "Review TypeScript changes.",
          enabled: true,
          source: "registered",
          requiredTools: ["fs.read"]
        }
      ];
    },
    async listSkillProposals() {
      return [
        {
          id: "skillprop_test",
          skillName: "generated-review",
          changeType: "create",
          reason: "Repeated review guidance.",
          evidence: ["review tasks"],
          diff: "",
          validation: {
            valid: true,
            diagnostics: []
          },
          risk: {
            level: "high",
            reasons: ["create changes the local skill registry"]
          },
          status: "waiting_approval",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          runId: "skill_test",
          sessionId: "ses_tool",
          approvalId: "approval_skill"
        }
      ];
    },
    async listMcpServers() {
      return [
        {
          name: "workspace",
          enabled: true,
          transport: "stdio",
          status: "connected",
          tools: ["fs.read"],
          resources: 1,
          prompts: 0
        }
      ];
    },
    async listSessions() {
      return sessions;
    },
    async listEvents(options) {
      listEventCalls.push(options);
      return [
        {
          id: "evt_replay_run",
          type: "run.started",
          runId: "run_replay",
          sessionId: "ses_tool",
          sequence: 1,
          timestamp: "2026-01-01T00:00:01.000Z",
          source: "runtime",
          payload: {
            input: "Replay a stored task"
          }
        },
        {
          id: "evt_replay_model",
          type: "model.selection.resolved",
          runId: "run_replay",
          sessionId: "ses_tool",
          sequence: 2,
          timestamp: "2026-01-01T00:00:02.000Z",
          source: "runtime",
          payload: {
            providerId: "openai-responses",
            model: "gpt-test",
            source: "default",
            reason: "configured default model"
          }
        },
        {
          id: "evt_replay_delta",
          type: "response.output_text.delta",
          runId: "run_replay",
          sessionId: "ses_tool",
          sequence: 3,
          timestamp: "2026-01-01T00:00:03.000Z",
          source: "model",
          payload: {
            delta: "Replay answer."
          }
        },
        {
          id: "evt_replay_completed",
          type: "response.completed",
          runId: "run_replay",
          sessionId: "ses_tool",
          sequence: 4,
          timestamp: "2026-01-01T00:00:04.000Z",
          source: "model",
          payload: {
            finishReason: "stop"
          }
        },
        {
          id: "evt_replay_todo",
          type: "todo.updated",
          runId: "run_replay",
          sessionId: "ses_tool",
          sequence: 5,
          timestamp: "2026-01-01T00:00:05.000Z",
          source: "runtime",
          payload: {
            items: [
              {
                id: "todo_replay",
                title: "Replay stored events",
                status: "completed",
                updatedAt: "2026-01-01T00:00:05.000Z"
              }
            ]
          }
        },
        {
          id: "evt_replay_run_completed",
          type: "run.completed",
          runId: "run_replay",
          sessionId: "ses_tool",
          sequence: 6,
          timestamp: "2026-01-01T00:00:06.000Z",
          source: "runtime",
          payload: {
            outputText: "Replay answer."
          }
        }
      ];
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
    async resume(runId) {
      resumeCalls.push(runId);
      return {
        runId: "run_resumed",
        sessionId: "ses_tool",
        status: "completed",
        outputText: "resumed"
      };
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
  await app.runCommand("/permissions");
  await app.runCommand("/permissions set filesystem.write ask");
  await app.runCommand("/approvals");
  await app.runCommand("/key n");
  await app.runCommand("/key p");
  await app.runCommand("/key v");
  await app.runCommand("/key s");
  await app.runCommand("/key v");
  await app.runCommand("/key d unsafe file write");
  await app.runCommand("/key a");
  await app.runCommand("/approvals");
  await app.runCommand("/tools");
  await app.runCommand("/skills");
  await app.runCommand("/mcp");
  await app.runCommand("/git");
  await app.runCommand("/session");
  await app.runCommand("/session list");
  app.render({
    id: "evt_run",
    type: "run.started",
    runId: "run_tool",
    sessionId: "ses_tool",
    sequence: 0,
    timestamp: "2026-01-01T00:00:01.000Z",
    source: "runtime",
    payload: {
      input: "Check TUI commands"
    }
  });
  app.render({
    id: "evt_model",
    type: "model.selection.resolved",
    runId: "run_tool",
    sessionId: "ses_tool",
    sequence: 1,
    timestamp: "2026-01-01T00:00:01.500Z",
    source: "runtime",
    payload: {
      providerId: "openai-responses",
      model: "gpt-test",
      source: "default",
      reason: "configured default model"
    }
  });
  app.render({
    id: "evt_delta",
    type: "response.output_text.delta",
    runId: "run_tool",
    sessionId: "ses_tool",
    sequence: 2,
    timestamp: "2026-01-01T00:00:01.700Z",
    source: "model",
    payload: {
      delta: "Working on it."
    }
  });
  app.render({
    id: "evt_completed",
    type: "response.completed",
    runId: "run_tool",
    sessionId: "ses_tool",
    sequence: 3,
    timestamp: "2026-01-01T00:00:01.900Z",
    source: "model",
    payload: {
      finishReason: "stop"
    }
  });
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
  app.render({
    id: "evt_review",
    type: "review.findings.created",
    runId: "run_tool",
    sessionId: "ses_tool",
    sequence: 2,
    timestamp: "2026-01-01T00:00:03.000Z",
    source: "coding",
    payload: {
      reviewedFiles: ["packages/runloom-tui/src/app/tui-app.ts"],
      summary: "One issue found.",
      findings: [
        {
          severity: "high",
          title: "Approval decision errors are hidden",
          category: "bug",
          location: {
            path: "packages/runloom-tui/src/app/tui-app.ts",
            line: 120
          },
          recommendation: "Surface the original error message."
        }
      ]
    }
  });
  app.render({
    id: "evt_tool_completed",
    type: "tool.completed",
    runId: "run_tool",
    sessionId: "ses_tool",
    sequence: 3,
    timestamp: "2026-01-01T00:00:03.500Z",
    source: "runtime",
    payload: {
      toolName: "fs.read",
      status: "completed"
    }
  });
  app.render({
    id: "evt_mcp_connected",
    type: "mcp.server.connected",
    runId: "run_tool",
    sessionId: "ses_tool",
    sequence: 4,
    timestamp: "2026-01-01T00:00:03.700Z",
    source: "runtime",
    payload: {
      name: "workspace"
    }
  });
  await app.runCommand("/status");
  await app.runCommand("/transcript");
  await app.runCommand("/activity");
  await app.runCommand("/activity models");
  await app.runCommand("/activity todos");
  await app.runCommand("/activity reviews");
  await app.runCommand("/activity tools");
  await app.runCommand("/activity mcp");
  await app.runCommand("/activity view models 1");
  await app.runCommand("/activity tools view latest");
  await app.runCommand("/activity view mcp latest");
  await app.runCommand("/view");
  for (let index = 0; index < 25; index += 1) {
    app.render({
      id: `evt_scroll_delta_${index}`,
      type: "response.output_text.delta",
      runId: "run_tool",
      sessionId: "ses_tool",
      sequence: 10 + index * 2,
      timestamp: "2026-01-01T00:00:04.000Z",
      source: "model",
      payload: {
        delta: `Scroll response ${index}.`
      }
    });
    app.render({
      id: `evt_scroll_completed_${index}`,
      type: "response.completed",
      runId: "run_tool",
      sessionId: "ses_tool",
      sequence: 11 + index * 2,
      timestamp: "2026-01-01T00:00:04.500Z",
      source: "model",
      payload: {
        finishReason: "stop"
      }
    });
  }
  await app.runCommand("/focus transcript");
  await app.runCommand("/scroll top");
  await app.runCommand("/scroll bottom");
  await app.runCommand("/focus activity");
  await app.runCommand("/scroll top");
  await app.runCommand("/key alt+1");
  await app.runCommand("/key pgup");
  await app.runCommand("/key pgdn");
  await app.runCommand("/key alt+2");
  await app.runCommand("/key alt+3");
  await app.runCommand("/todo");
  await app.runCommand("/diff");
  await app.runCommand("/tests pnpm typecheck");
  await app.runCommand("/stop");
  await app.runCommand("/resume run_tool");
  await app.runCommand("/replay");
  await app.runCommand("/clear");
  await app.runCommand("/view");
  await app.runCommand("/session switch ses_tool");
  await app.runCommand("/model profile frontend_design");
  await app.submitPrompt("设计一个前端界面");
  await app.runCommand("/model set kimi:kimi-design");
  await app.submitPrompt("继续设计界面");
  await app.runCommand("/review");
  await app.submitPrompt("审查当前代码");
  await app.runCommand("/review off");
  await app.runCommand("/model clear");
  await app.runCommand("/key ctrl+l");
  await app.runCommand("/quit");

  const text = output.toString();
  assert.equal(policy.scopes.shell, "full_access");
  assert.equal(policy.scopes["filesystem.write"], "ask");
  assert.equal(policy.defaultMode, "auto_decide");
  assert.equal(closed, true);
  assert.match(text, /Approval mode for shell set to full_access/);
  assert.match(text, /Approval default mode set to auto_decide/);
  assert.match(text, /Approval Policy:\n {2}default: auto_decide/);
  assert.match(text, /filesystem\.write\s+auto_decide\s+default/);
  assert.match(text, /Approval mode for filesystem\.write set to ask/);
  assert.match(text, /Approval Center: 3 pending focused=approval_test/);
  assert.match(text, /\* approval_test risk=high scope=shell mode=ask/);
  assert.match(text, /Shortcut N\nApproval focus set to approval_deny\nApproval Center: 3 pending focused=approval_deny/);
  assert.match(text, /Shortcut P\nApproval focus set to approval_test\nApproval Center: 3 pending focused=approval_test/);
  assert.match(text, /action=tool:shell\.verify run=run_tool session=ses_tool/);
  assert.match(text, /commands: \/approve approval_test once \| \/approve approval_test session \| \/deny approval_test <reason> \| \/approvals view approval_test/);
  assert.match(text, /selection: \/approvals next \| \/approvals prev \| \/approvals view \| \/approve selected once \| \/deny selected <reason>/);
  assert.match(text, /Shortcut V\nApproval: approval_test/);
  assert.match(text, /Approval: approval_test/);
  assert.match(text, /"command": "pnpm test"/);
  assert.match(text, /Shortcut S\nApproval approval_test approved remember=session/);
  assert.match(text, /Approval focus set to approval_deny/);
  assert.match(text, /Shortcut V\nApproval: approval_deny/);
  assert.match(text, /Shortcut D\nApproval approval_deny denied reason=unsafe file write/);
  assert.match(text, /Approval focus set to approval_once/);
  assert.match(text, /Shortcut A\nApproval approval_once approved remember=never/);
  assert.match(text, /Approvals: \(none pending\)/);
  assert.match(text, /fs\.read - Read a file \[filesystem\.read\]/);
  assert.match(text, /typescript-code-review@0\.1\.0 enabled source=registered tools=fs\.read/);
  assert.match(text, /workspace enabled transport=stdio status=connected tools=fs\.read resources=1 prompts=0/);
  assert.match(text, /\[git\] main \(clean\)/);
  assert.match(text, /Session: ses_tool/);
  assert.match(text, /Sessions:/);
  assert.match(text, /Status:\n {2}session: ses_tool/);
  assert.match(text, /run: run_tool status=running/);
  assert.match(text, /model: openai-responses:gpt-test/);
  assert.match(text, /todo: in_progress=1/);
  assert.match(text, /Transcript:\n {2}user: Check TUI commands/);
  assert.match(text, /assistant: Working on it\./);
  assert.match(text, /Activity:\n(?:.*\n)* {2}model completed/);
  assert.match(text, /Activity \(models\):\n {2}model openai-responses:gpt-test/);
  assert.match(text, /Activity \(models\):\n(?:.*\n)* {2}model completed/);
  assert.match(text, /Activity \(todos\):\n {2}todo in_progress: Check TUI commands/);
  assert.match(text, /Activity \(reviews\):\n {2}review findings recorded/);
  assert.match(text, /Activity \(tools\):\n {2}tool\.completed fs\.read status=completed/);
  assert.match(text, /Activity \(mcp\):\n {2}mcp\.server\.connected/);
  assert.match(text, /Activity Detail \(models\): #2\n {2}category: models\n {2}filteredIndex: 1\n {2}event: model\.selection\.resolved/);
  assert.match(text, /"providerId": "openai-responses"/);
  assert.match(text, /Activity Detail \(tools\): #6\n {2}category: tools\n {2}filteredIndex: 1\n {2}event: tool\.completed/);
  assert.match(text, /"toolName": "fs\.read"/);
  assert.match(text, /Activity Detail \(mcp\): #7\n {2}category: mcp\n {2}filteredIndex: 1\n {2}event: mcp\.server\.connected/);
  assert.match(text, /Focus set to transcript/);
  assert.match(text, /Transcript: showing 1-20 of 27 offset=7/);
  assert.match(text, /assistant: Scroll response 0\./);
  assert.match(text, /Transcript: showing 8-27 of 27/);
  assert.match(text, /assistant: Scroll response 24\./);
  assert.match(text, /Focus set to activity/);
  assert.match(text, /Activity: showing 1-20 of 32 offset=12/);
  assert.match(text, /Shortcut Alt\+1\nFocus set to transcript/);
  assert.match(text, /Shortcut PgUp\nTranscript: showing 1-20 of 27 offset=7/);
  assert.match(text, /Shortcut PgDn\nTranscript: showing 8-27 of 27/);
  assert.match(text, /Shortcut Alt\+2\nFocus set to todo/);
  assert.match(text, /Shortcut Alt\+3\nFocus set to activity/);
  assert.match(text, /Todo:\n {2}in_progress Check TUI commands/);
  assert.match(text, /\[review\] 1 finding\(s\)/);
  assert.match(text, /Files: packages\/runloom-tui\/src\/app\/tui-app\.ts/);
  assert.match(text, /high bug packages\/runloom-tui\/src\/app\/tui-app\.ts:120 - Approval decision errors are hidden/);
  assert.match(text, /recommendation: Surface the original error message/);
  assert.match(text, /Diff: 1 file\(s\), \+4\/-1/);
  assert.match(text, /packages\/runloom-tui\/src\/app\/tui-app\.ts/);
  assert.match(text, /\[tests\] pnpm typecheck exit=0 duration=12ms/);
  assert.match(text, /tests ok/);
  assert.match(text, /Stop requested for run_tool/);
  assert.match(text, /\[resume\] run_tool -> run_resumed completed/);
  assert.match(text, /\[replay\] loaded 6 event\(s\)/);
  assert.match(text, /user: Replay a stored task/);
  assert.match(text, /assistant: Replay answer\./);
  assert.match(text, /completed Replay stored events/);
  assert.match(text, /View cleared\nStatus:\n {2}session: ses_tool\n {2}run: run_replay status=completed\n(?:.*\n)*Todo: \(none\)\nActivity: \(none\)\nTranscript: \(empty\)/);
  assert.match(text, /Session switched to ses_tool\n\[replay\] loaded 6 event\(s\)\nStatus:\n {2}session: ses_tool\n {2}run: run_replay status=completed/);
  assert.match(text, /Model profile set to frontend_design/);
  assert.match(text, /Model override set to kimi:kimi-design/);
  assert.match(text, /Review mode enabled/);
  assert.match(text, /Review mode disabled/);
  assert.match(text, /Shortcut Ctrl\+L\nView cleared/);
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
  assert.deepEqual(resumeCalls, ["run_tool"]);
  assert.deepEqual(listEventCalls, [
    {
      sessionId: "ses_tool",
      limit: 200
    },
    {
      sessionId: "ses_tool",
      limit: 200
    }
  ]);
  assert.deepEqual(approvalDecisions, [
    {
      approvalId: "approval_test",
      decision: {
        decision: "approved",
        remember: "session"
      }
    },
    {
      approvalId: "approval_deny",
      decision: {
        decision: "denied",
        reason: "unsafe file write"
      }
    },
    {
      approvalId: "approval_once",
      decision: {
        decision: "approved",
        remember: "never"
      }
    }
  ]);
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
