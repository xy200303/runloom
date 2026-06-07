import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createRunloomAgent, OpenAIResponsesProvider } from "../dist/index.js";

const execFileAsync = promisify(execFile);

test("approval policy can be updated", async () => {
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });
  const eventTypes = [];
  agent.subscribe((event) => eventTypes.push(event.type));

  const policy = await agent.updateApprovalPolicy({
    scopes: {
      "filesystem.write": "ask",
      shell: "auto_decide"
    }
  });
  const auditRecords = await agent.listAuditRecords({ action: "approval.policy.updated" });
  const emptyAuditRecords = await agent.listAuditRecords({ action: "approval.policy.updated", limit: 0 });

  assert.equal(policy.scopes["filesystem.write"], "ask");
  assert.equal(policy.scopes.shell, "auto_decide");
  assert.equal(auditRecords.length, 1);
  assert.equal(emptyAuditRecords.length, 0);
  assert.equal(auditRecords[0].action, "approval.policy.updated");
  assert.equal(auditRecords[0].actor, "user");
  assert.deepEqual(auditRecords[0].details.changedScopes, {
    "filesystem.write": "ask",
    shell: "auto_decide"
  });
  assert.ok(eventTypes.includes("audit.recorded"));
  await agent.close();
});

test("approval policy persists when a state directory is configured", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "runloom-state-"));

  try {
    const firstAgent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: "",
      stateDir
    });

    await firstAgent.updateApprovalPolicy({
      defaultMode: "auto_decide",
      scopes: {
        shell: "full_access"
      }
    });
    await firstAgent.close();

    const secondAgent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: "",
      stateDir
    });

    const policy = await secondAgent.getApprovalPolicy();
    assert.equal(policy.defaultMode, "auto_decide");
    assert.equal(policy.scopes.shell, "full_access");
    await secondAgent.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("model routes select providers from global runloom config", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "runloom-config-"));

  try {
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({
        model: {
          default: "openai:gpt-default",
          profiles: {
            frontend_design: "kimi:kimi-design"
          },
          routes: [
            {
              when: { language: "go" },
              model: "go:go-code"
            },
            {
              when: { taskType: "prototype_design" },
              model: "proto:proto-model"
            }
          ]
        }
      })
    );

    const openai = new RecordingProvider("openai-responses");
    const kimi = new RecordingProvider("kimi");
    const go = new RecordingProvider("go");
    const proto = new RecordingProvider("proto");
    const agent = await createRunloomAgent({
      provider: openai,
      workspace: process.cwd(),
      stateDir
    });
    await agent.registerProvider(kimi);
    await agent.registerProvider(go);
    await agent.registerProvider(proto);

    const selections = [];
    agent.subscribe((event) => {
      if (event.type === "model.selection.resolved") {
        selections.push(event.payload);
      }
    });

    const frontendResult = await agent.submit({
      text: "请做一个前端设计任务",
      profile: "frontend_design"
    });
    assert.equal(frontendResult.status, "completed");
    assert.equal(kimi.requests[0].model, "kimi-design");
    assert.equal(selections.at(-1).providerId, "kimi");
    assert.equal(selections.at(-1).source, "profile");

    const goResult = await agent.submit("请完成一个 Go 开发任务");
    assert.equal(goResult.status, "completed");
    assert.equal(go.requests[0].model, "go-code");
    assert.equal(selections.at(-1).providerId, "go");
    assert.equal(selections.at(-1).source, "route");

    const prototypeResult = await agent.submit({
      text: "做一个产品原型",
      taskType: "prototype_design"
    });
    assert.equal(prototypeResult.status, "completed");
    assert.equal(proto.requests[0].model, "proto-model");
    assert.equal(selections.at(-1).providerId, "proto");
    assert.equal(selections.at(-1).source, "route");

    await agent.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("workspace runloom config overrides global model config", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "runloom-config-"));
  const workspace = await mkdtemp(join(tmpdir(), "runloom-workspace-"));

  try {
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({
        model: {
          default: "go:global-default"
        }
      })
    );
    await mkdir(join(workspace, ".runloom"));
    await writeFile(
      join(workspace, ".runloom", "config.json"),
      JSON.stringify({
        model: {
          default: "kimi:workspace-default"
        }
      })
    );

    const go = new RecordingProvider("go");
    const kimi = new RecordingProvider("kimi");
    const agent = await createRunloomAgent({
      provider: go,
      workspace,
      stateDir
    });
    await agent.registerProvider(kimi);

    const result = await agent.submit("普通开发任务");

    assert.equal(result.status, "completed");
    assert.equal(kimi.requests[0].model, "workspace-default");
    assert.equal(go.requests.length, 0);
    await agent.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runloom config rejects secret-like fields", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "runloom-config-"));

  try {
    await writeFile(
      join(stateDir, "config.json"),
      JSON.stringify({
        apiKey: "not-allowed",
        model: {
          default: "openai:gpt-4.1"
        }
      })
    );

    await assert.rejects(
      () =>
        createRunloomAgent({
          provider: new RecordingProvider("openai-responses"),
          workspace: process.cwd(),
          stateDir
        }),
      /secret-like field 'apiKey'/
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("missing OpenAI API key fails without product mock output", async () => {
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });

  const eventTypes = [];
  agent.subscribe((event) => eventTypes.push(event.type));

  const result = await agent.submit("阅读 package.json 并总结项目");

  assert.equal(result.status, "failed");
  assert.match(result.outputText, /OPENAI_API_KEY/);
  assert.ok(eventTypes.includes("coding.workspace.inspected"));
  assert.ok(eventTypes.includes("response.failed"));
  assert.ok(eventTypes.includes("run.failed"));
  await agent.close();
});

test("OpenAI Responses provider maps tools and emits function calls", async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options) => {
    captured = {
      url,
      body: JSON.parse(options.body)
    };

    return new Response(
      JSON.stringify({
        id: "resp_tool_test",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_read_package",
            name: "fs.read",
            arguments: "{\"path\":\"package.json\"}"
          }
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20
        }
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  };

  try {
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1"
    });

    const events = [];
    for await (const event of provider.createResponse(
      {
        model: "gpt-4.1",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Read package.json" }]
          }
        ],
        tools: [
          {
            name: "fs.read",
            description: "Read a file",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string" }
              },
              required: ["path"],
              additionalProperties: false
            }
          }
        ]
      },
      {
        runId: "run_tool_test",
        sessionId: "ses_tool_test"
      }
    )) {
      events.push(event);
    }

    assert.equal(captured.url, "https://api.example.test/v1/responses");
    assert.equal(captured.body.tools[0].type, "function");
    assert.equal(captured.body.tools[0].name, "fs.read");
    assert.equal(captured.body.tools[0].strict, false);
    assert.equal(captured.body.tools[0].parameters.properties.path.type, "string");
    assert.equal(captured.body.input[0].role, "user");

    const toolCall = events.find((event) => event.type === "response.tool_call.completed");
    assert.equal(toolCall.toolCallId, "call_read_package");
    assert.equal(toolCall.name, "fs.read");
    assert.deepEqual(toolCall.arguments, { path: "package.json" });
    assert.equal(events.at(-1).finishReason, "tool_calls");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent executes model-requested tools and continues with real workspace output", async () => {
  class ToolCallingProvider {
    id = "test-tool-loop-provider";
    protocol = "custom";
    capabilities = {
      streaming: false,
      tools: true
    };
    requests = [];

    async *createResponse(request) {
      this.requests.push(request);

      if (this.requests.length === 1) {
        assert.ok(request.tools.some((tool) => tool.name === "fs.read"));
        yield { type: "response.created", responseId: "resp_first" };
        yield {
          type: "response.tool_call.completed",
          toolCallId: "call_read_package",
          name: "fs.read",
          arguments: { path: "package.json" },
          raw: {
            type: "function_call",
            call_id: "call_read_package",
            name: "fs.read",
            arguments: "{\"path\":\"package.json\"}"
          }
        };
        yield { type: "response.completed", finishReason: "tool_calls" };
        return;
      }

      const toolOutput = request.input.find((item) => item.type === "function_call_output");
      assert.equal(toolOutput.toolCallId, "call_read_package");
      assert.match(toolOutput.output, /runloom/);

      yield { type: "response.created", responseId: "resp_second" };
      yield { type: "response.output_text.delta", delta: "已读取 package.json，项目名称是 runloom。" };
      yield { type: "response.completed", finishReason: "stop" };
    }
  }

  const provider = new ToolCallingProvider();
  const agent = await createRunloomAgent({
    provider,
    model: "gpt-4.1",
    workspace: process.cwd()
  });

  const eventTypes = [];
  agent.subscribe((event) => eventTypes.push(event.type));

  const result = await agent.submit("读取 package.json 并总结项目名称");

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "已读取 package.json，项目名称是 runloom。");
  assert.equal(provider.requests.length, 2);
  assert.ok(eventTypes.includes("response.tool_call.completed"));
  assert.ok(eventTypes.includes("tool.call.completed"));
  assert.ok(eventTypes.includes("run.completed"));
  await agent.close();
});

test("agent cancel aborts an active run", async () => {
  class WaitingProvider {
    id = "waiting-provider";
    protocol = "custom";
    capabilities = {
      streaming: false,
      tools: true
    };

    async *createResponse(_request, context) {
      yield { type: "response.created", responseId: "resp_waiting" };
      await waitForAbort(context.signal);
    }
  }

  const agent = await createRunloomAgent({
    provider: new WaitingProvider(),
    model: "gpt-4.1",
    workspace: process.cwd()
  });

  let runId;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const eventTypes = [];
  agent.subscribe((event) => {
    eventTypes.push(event.type);
    if (event.type === "run.started") {
      runId = event.runId;
      resolveStarted();
    }
  });

  const run = agent.submit("等待直到被取消");
  await started;
  await agent.cancel(runId);
  const result = await run;

  assert.equal(result.status, "cancelled");
  assert.equal(result.runId, runId);
  assert.ok(eventTypes.includes("run.cancel_requested"));
  assert.ok(eventTypes.includes("run.cancelled"));
  await agent.close();
});

test("agent resume replays a stored run in the same session", async () => {
  const provider = new RecordingProvider("resume-provider");
  const agent = await createRunloomAgent({
    provider,
    model: "gpt-4.1",
    workspace: process.cwd()
  });

  const eventTypes = [];
  agent.subscribe((event) => eventTypes.push(event.type));

  const first = await agent.submit({
    text: "继续同一个任务",
    taskType: "code_review"
  });
  const resumed = await agent.resume(first.runId);

  assert.equal(first.status, "completed");
  assert.equal(resumed.status, "completed");
  assert.notEqual(resumed.runId, first.runId);
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(provider.requests.length, 2);
  assert.ok(eventTypes.includes("run.resumed"));
  await agent.close();
});

test("approved model tool calls resume the same run after approval", async () => {
  class ApprovalGatedToolProvider {
    id = "approval-gated-tool-provider";
    protocol = "custom";
    capabilities = {
      streaming: false,
      tools: true
    };
    requests = [];

    async *createResponse(request) {
      this.requests.push(request);

      if (this.requests.length === 1) {
        yield { type: "response.created", responseId: "resp_needs_approval" };
        yield { type: "response.output_text.delta", delta: "Need approval before verification.\n" };
        yield {
          type: "response.tool_call.completed",
          toolCallId: "call_verify",
          name: "shell.verify",
          arguments: { command: "node", args: ["--version"] }
        };
        yield { type: "response.completed", finishReason: "tool_calls" };
        return;
      }

      const toolOutput = request.input.find((item) => item.type === "function_call_output");
      assert.ok(toolOutput);
      assert.equal(toolOutput.toolCallId, "call_verify");
      assert.match(toolOutput.output, /"status":"completed"/);
      assert.match(toolOutput.output, /"exitCode":0/);

      yield { type: "response.created", responseId: "resp_after_approval" };
      yield { type: "response.output_text.delta", delta: "Verification completed after approval." };
      yield { type: "response.completed", finishReason: "stop" };
    }
  }

  const provider = new ApprovalGatedToolProvider();
  const agent = await createRunloomAgent({
    provider,
    model: "gpt-4.1",
    workspace: process.cwd()
  });
  const eventTypes = [];
  agent.subscribe((event) => eventTypes.push(event.type));

  const waiting = await agent.submit("Run the verification command.");
  const stillWaiting = await agent.resume(waiting.runId);
  await agent.resolveApproval(waiting.approvalId, { decision: "approved" });
  const resumed = await agent.resume(waiting.runId);
  const run = await agent.getRun(waiting.runId);
  const messages = await agent.listMessages({ runId: waiting.runId });

  assert.equal(waiting.status, "waiting_approval");
  assert.ok(waiting.approvalId);
  assert.equal(stillWaiting.status, "waiting_approval");
  assert.equal(stillWaiting.approvalId, waiting.approvalId);
  assert.equal(resumed.runId, waiting.runId);
  assert.equal(resumed.status, "completed");
  assert.equal(run.status, "completed");
  assert.equal(provider.requests.length, 2);
  assert.match(resumed.outputText, /Need approval before verification/);
  assert.match(resumed.outputText, /Verification completed after approval/);
  assert.ok(eventTypes.includes("tool.call.approved"));
  assert.equal(messages.filter((message) => message.role === "assistant").length, 2);
  assert.equal(messages.filter((message) => message.role === "tool").length, 1);
  await agent.close();
});

test("denied model tool approvals cancel the waiting run without executing the tool", async () => {
  class DeniedApprovalProvider {
    id = "denied-approval-provider";
    protocol = "custom";
    capabilities = {
      streaming: false,
      tools: true
    };
    requests = [];

    async *createResponse(request) {
      this.requests.push(request);
      yield { type: "response.created", responseId: "resp_denied_approval" };
      yield {
        type: "response.tool_call.completed",
        toolCallId: "call_denied_verify",
        name: "shell.verify",
        arguments: { command: "node", args: ["--version"] }
      };
      yield { type: "response.completed", finishReason: "tool_calls" };
    }
  }

  const provider = new DeniedApprovalProvider();
  const agent = await createRunloomAgent({
    provider,
    model: "gpt-4.1",
    workspace: process.cwd()
  });
  const eventTypes = [];
  agent.subscribe((event) => eventTypes.push(event.type));

  const waiting = await agent.submit("Run a command that will be denied.");
  await agent.resolveApproval(waiting.approvalId, { decision: "denied" });
  const resumed = await agent.resume(waiting.runId);
  const run = await agent.getRun(waiting.runId);

  assert.equal(waiting.status, "waiting_approval");
  assert.equal(resumed.status, "cancelled");
  assert.equal(resumed.runId, waiting.runId);
  assert.match(resumed.outputText, /Approval denied/);
  assert.equal(run.status, "cancelled");
  assert.equal(provider.requests.length, 1);
  assert.ok(!eventTypes.includes("tool.call.approved"));
  await agent.close();
});

test("runs and events can be queried through the public API", async () => {
  const provider = new RecordingProvider("query-provider");
  const agent = await createRunloomAgent({
    provider,
    model: "gpt-4.1",
    workspace: process.cwd()
  });

  const result = await agent.submit({
    text: "查询 run 和 event",
    taskType: "general"
  });

  const run = await agent.getRun(result.runId);
  const runs = await agent.listRuns({ sessionId: result.sessionId });
  const allEvents = await agent.listEvents({ sessionId: result.sessionId });
  const runEvents = await agent.listEvents({ runId: result.runId });
  const lastEvent = await agent.listEvents({ runId: result.runId, limit: 1 });
  const noEvents = await agent.listEvents({ runId: result.runId, limit: 0 });
  const messages = await agent.listMessages({ runId: result.runId });
  const noMessages = await agent.listMessages({ runId: result.runId, limit: 0 });

  assert.equal(run.id, result.runId);
  assert.equal(run.sessionId, result.sessionId);
  assert.equal(run.status, "completed");
  assert.equal(run.inputText, "查询 run 和 event");
  assert.equal(run.outputText, result.outputText);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, result.runId);
  assert.ok(allEvents.some((event) => event.type === "run.started"));
  assert.ok(runEvents.every((event) => event.runId === result.runId));
  assert.equal(lastEvent.length, 1);
  assert.equal(lastEvent[0].type, "run.completed");
  assert.deepEqual(noEvents, []);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content[0].text, "查询 run 和 event");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content[0].text, result.outputText);
  assert.deepEqual(noMessages, []);
  await agent.close();
});

test("stateDir persists sessions, runs, messages, and replayable events", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "runloom-runtime-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "runloom-runtime-workspace-"));

  try {
    const firstAgent = await createRunloomAgent({
      provider: new RecordingProvider("persistent-provider"),
      model: "gpt-4.1",
      workspace,
      stateDir
    });
    const first = await firstAgent.submit("persist this run");
    await firstAgent.close();

    const secondAgent = await createRunloomAgent({
      provider: new RecordingProvider("persistent-provider"),
      model: "gpt-4.1",
      workspace,
      stateDir
    });
    const replayed = [];
    const unsubscribe = secondAgent.subscribe((event) => replayed.push(event), {
      replay: true,
      sessionId: first.sessionId
    });
    unsubscribe();

    const session = await secondAgent.getSession(first.sessionId);
    const run = await secondAgent.getRun(first.runId);
    const sessions = await secondAgent.listSessions();
    const runs = await secondAgent.listRuns({ sessionId: first.sessionId });
    const messages = await secondAgent.listMessages({ runId: first.runId });
    const events = await secondAgent.listEvents({ runId: first.runId });

    assert.equal(first.status, "completed");
    assert.equal(session.id, first.sessionId);
    assert.equal(run.id, first.runId);
    assert.equal(run.status, "completed");
    assert.equal(run.outputText, first.outputText);
    assert.equal(sessions.length, 1);
    assert.equal(runs.length, 1);
    assert.equal(messages.length, 2);
    assert.ok(events.some((event) => event.type === "run.started"));
    assert.ok(events.some((event) => event.type === "run.completed"));
    assert.equal(replayed.length, events.length);
    await secondAgent.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("stateDir persists waiting approval runs and resumes them in a new agent", async () => {
  class PersistentApprovalProvider {
    id = "persistent-approval-provider";
    protocol = "custom";
    capabilities = {
      streaming: false,
      tools: true
    };
    requests = [];

    async *createResponse(request) {
      this.requests.push(request);
      const toolOutput = request.input.find((item) => item.type === "function_call_output");
      if (toolOutput) {
        assert.equal(toolOutput.toolCallId, "call_persistent_verify");
        assert.match(toolOutput.output, /"status":"completed"/);
        yield { type: "response.created", responseId: "resp_persistent_after_approval" };
        yield { type: "response.output_text.delta", delta: "Persistent verification completed." };
        yield { type: "response.completed", finishReason: "stop" };
        return;
      }

      yield { type: "response.created", responseId: "resp_persistent_waiting" };
      yield { type: "response.output_text.delta", delta: "Persisting before approval.\n" };
      yield {
        type: "response.tool_call.completed",
        toolCallId: "call_persistent_verify",
        name: "shell.verify",
        arguments: { command: "node", args: ["--version"] }
      };
      yield { type: "response.completed", finishReason: "tool_calls" };
    }
  }

  const stateDir = await mkdtemp(join(tmpdir(), "runloom-pending-state-"));
  const workspace = await mkdtemp(join(tmpdir(), "runloom-pending-workspace-"));

  try {
    const firstProvider = new PersistentApprovalProvider();
    const firstAgent = await createRunloomAgent({
      provider: firstProvider,
      model: "gpt-4.1",
      workspace,
      stateDir
    });
    const waiting = await firstAgent.submit("Run a persistent verification command.");
    await firstAgent.close();

    const secondProvider = new PersistentApprovalProvider();
    const secondAgent = await createRunloomAgent({
      provider: secondProvider,
      model: "gpt-4.1",
      workspace,
      stateDir
    });
    const approvals = await secondAgent.listApprovals();
    await secondAgent.resolveApproval(waiting.approvalId, { decision: "approved" });
    const resumed = await secondAgent.resume(waiting.runId);
    const run = await secondAgent.getRun(waiting.runId);
    const events = await secondAgent.listEvents({ runId: waiting.runId });

    assert.equal(waiting.status, "waiting_approval");
    assert.equal(firstProvider.requests.length, 1);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].id, waiting.approvalId);
    assert.equal(resumed.runId, waiting.runId);
    assert.equal(resumed.status, "completed");
    assert.match(resumed.outputText, /Persisting before approval/);
    assert.match(resumed.outputText, /Persistent verification completed/);
    assert.equal(run.status, "completed");
    assert.equal(secondProvider.requests.length, 1);
    assert.ok(events.some((event) => event.type === "tool.call.approved"));
    assert.ok(events.some((event) => event.type === "run.completed"));
    await secondAgent.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("built-in coding tools operate on real workspace data", async () => {
  const displayedDiffs = [];
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: "",
    host: {
      kind: "custom",
      diff: {
        async showDiff(diff) {
          displayedDiffs.push(diff);
        }
      }
    }
  });

  const readResult = await agent.executeTool("fs.read", { path: "package.json" });
  assert.equal(readResult.status, "completed");
  assert.match(readResult.output.content, /"name": "runloom"/);

  const searchResult = await agent.executeTool("fs.search", { query: "runloom-agent", path: "packages", maxResults: 5 });
  assert.equal(searchResult.status, "completed");
  assert.ok(searchResult.output.matches.length > 0);

  const diffResult = await agent.executeTool("diff.text", {
    before: "alpha\nbeta\n",
    after: "alpha\ngamma\n",
    filePath: "sample.txt"
  });
  assert.equal(diffResult.status, "completed");
  assert.equal(diffResult.output.filesChanged[0], "sample.txt");
  assert.match(diffResult.output.patch, /-beta/);
  assert.match(diffResult.output.patch, /\+gamma/);
  const diffRecords = await agent.listDiffRecords({ runId: diffResult.runId });
  const noDiffRecords = await agent.listDiffRecords({ runId: diffResult.runId, limit: 0 });
  assert.equal(diffRecords.length, 1);
  assert.equal(diffRecords[0].toolName, "diff.text");
  assert.equal(diffRecords[0].displayed, true);
  assert.equal(diffRecords[0].diff.filesChanged[0], "sample.txt");
  assert.equal(displayedDiffs.length, 1);
  assert.deepEqual(noDiffRecords, []);

  await agent.close();
});

test("file patch tool is guarded and applies exact replacements", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "runloom-fs-patch-"));
  const filePath = join(workspace, "sample.txt");
  const initialContent = "alpha\nbeta\n";

  try {
    await writeFile(filePath, initialContent);

    const defaultAgent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace,
      apiKey: ""
    });
    const waiting = await defaultAgent.executeTool("fs.patch", {
      path: "sample.txt",
      before: "beta",
      after: "gamma"
    });
    assert.equal(waiting.status, "waiting_approval");
    assert.ok(waiting.approvalId);
    await defaultAgent.close();

    const fullAccessAgent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace,
      apiKey: "",
      approvalPolicy: {
        scopes: {
          "filesystem.write": "full_access"
        }
      }
    });
    const result = await fullAccessAgent.executeTool("fs.patch", {
      path: "sample.txt",
      before: "beta",
      after: "gamma",
      expectedSha256: sha256(initialContent)
    });
    const mismatchedHash = await fullAccessAgent.executeTool("fs.patch", {
      path: "sample.txt",
      before: "gamma",
      after: "delta",
      expectedSha256: sha256(initialContent)
    });

    assert.equal(result.status, "completed");
    assert.equal(result.output.path, "sample.txt");
    assert.equal(result.output.replacements, 1);
    assert.equal(result.output.filesChanged[0], "sample.txt");
    assert.match(result.output.patch, /-beta/);
    assert.match(result.output.patch, /\+gamma/);
    assert.equal(await readFile(filePath, "utf8"), "alpha\ngamma\n");
    assert.equal(mismatchedHash.status, "failed");
    assert.match(mismatchedHash.error, /expected sha256/);
    await fullAccessAgent.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file write and patch tools protect dirty user changes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "runloom-dirty-file-"));
  const filePath = join(workspace, "sample.txt");
  const dirtyContent = "alpha\nuser change\n";

  try {
    await execFileAsync("git", ["init"], { cwd: workspace, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "runloom@example.test"], { cwd: workspace, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "Runloom Test"], { cwd: workspace, windowsHide: true });
    await writeFile(filePath, "alpha\n");
    await execFileAsync("git", ["add", "sample.txt"], { cwd: workspace, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workspace, windowsHide: true });
    await writeFile(filePath, dirtyContent);

    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace,
      apiKey: "",
      approvalPolicy: {
        scopes: {
          "filesystem.write": "full_access"
        }
      }
    });

    const blockedPatch = await agent.executeTool("fs.patch", {
      path: "sample.txt",
      before: "alpha",
      after: "beta"
    });
    const blockedWrite = await agent.executeTool("fs.write", {
      path: "sample.txt",
      content: "overwrite\n"
    });
    const controlledPatch = await agent.executeTool("fs.patch", {
      path: "sample.txt",
      before: "user change",
      after: "controlled change",
      expectedSha256: sha256(dirtyContent)
    });

    assert.equal(blockedPatch.status, "failed");
    assert.match(blockedPatch.error, /uncommitted changes/);
    assert.equal(blockedWrite.status, "failed");
    assert.match(blockedWrite.error, /uncommitted changes/);
    assert.equal(controlledPatch.status, "completed");
    assert.equal(await readFile(filePath, "utf8"), "alpha\ncontrolled change\n");
    await agent.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("git diff tool reads a real workspace patch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "runloom-git-diff-"));

  try {
    await execFileAsync("git", ["init"], { cwd: workspace, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "runloom@example.test"], { cwd: workspace, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "Runloom Test"], { cwd: workspace, windowsHide: true });
    await writeFile(join(workspace, "sample.txt"), "alpha\nbeta\n");
    await execFileAsync("git", ["add", "sample.txt"], { cwd: workspace, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workspace, windowsHide: true });
    await writeFile(join(workspace, "sample.txt"), "alpha\ngamma\n");

    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace,
      apiKey: ""
    });

    const result = await agent.executeTool("git.diff", {});

    assert.equal(result.status, "completed");
    assert.equal(result.output.filesChanged[0], "sample.txt");
    assert.equal(result.output.additions, 1);
    assert.equal(result.output.deletions, 1);
    assert.match(result.output.patch, /-beta/);
    assert.match(result.output.patch, /\+gamma/);
    await agent.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("built-in tools can be listed for host adapters", async () => {
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });

  const tools = await agent.listTools();
  const readTool = tools.find((tool) => tool.name === "fs.read");
  const patchTool = tools.find((tool) => tool.name === "fs.patch");
  const shellTool = tools.find((tool) => tool.name === "shell.verify");
  const diffTool = tools.find((tool) => tool.name === "git.diff");
  const editPlanTool = tools.find((tool) => tool.name === "edit.plan");
  const deliverySummaryTool = tools.find((tool) => tool.name === "delivery.summary");
  const reviewFindingsTool = tools.find((tool) => tool.name === "review.findings");

  assert.ok(readTool);
  assert.equal(readTool.permissions[0], "filesystem.read");
  assert.ok(patchTool);
  assert.equal(patchTool.permissions[0], "filesystem.write");
  assert.ok(shellTool);
  assert.equal(shellTool.permissions[0], "shell");
  assert.ok(diffTool);
  assert.equal(diffTool.permissions[0], "filesystem.read");
  assert.ok(editPlanTool);
  assert.deepEqual(editPlanTool.permissions, []);
  assert.ok(deliverySummaryTool);
  assert.deepEqual(deliverySummaryTool.permissions, []);
  assert.ok(reviewFindingsTool);
  assert.deepEqual(reviewFindingsTool.permissions, []);
  await agent.close();
});

test("code review runs use review instructions and structured findings tool", async () => {
  const provider = new RecordingProvider("review-provider");
  const agent = await createRunloomAgent({
    provider,
    model: "gpt-4.1",
    workspace: process.cwd()
  });

  const result = await agent.submit({
    text: "review the current changes",
    taskType: "code_review"
  });

  assert.equal(result.status, "completed");
  assert.match(provider.requests[0].input[0].content[0].text, /Review mode is active/);
  assert.ok(provider.requests[0].tools.some((tool) => tool.name === "review.findings"));
  await agent.close();
});

test("agent loads skill manifests from stateDir", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "runloom-agent-skills-"));

  try {
    await writeSkillFixture(stateDir, "installed", "typescript-code-review", {
      name: "typescript-code-review",
      version: "0.1.0",
      description: "Review TypeScript changes.",
      triggers: ["review TypeScript"],
      requiredTools: ["fs.read", "git.diff"],
      permissions: {
        readWorkspace: true,
        writeWorkspace: false,
        shell: "ask"
      },
      validation: {
        schema: "skill-manifest@1",
        tests: ["tests/*.case.md"]
      }
    });
    await writeSkillFixture(
      stateDir,
      "generated",
      "bad-skill",
      {
        name: "bad-skill",
        description: "Invalid generated skill.",
        triggers: ["bad"],
        validation: {
          schema: "wrong-schema"
        }
      },
      "## 适用场景\n\nOnly one section.\n"
    );

    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: "",
      stateDir
    });

    const skills = await agent.listSkills();
    const events = await agent.listEvents({ runId: "skills" });
    const loadedEvent = events.find((event) => event.type === "skills.loaded");
    const diagnosticEvent = events.find((event) => event.type === "skills.diagnostic");

    assert.equal(skills.length, 2);
    assert.equal(skills[0].name, "bad-skill");
    assert.equal(skills[0].enabled, false);
    assert.match(skills[0].diagnostics[0], /validation\.schema/);
    assert.equal(skills[1].name, "typescript-code-review");
    assert.equal(skills[1].source, "installed");
    assert.equal(skills[1].permissions.shell, "ask");
    assert.deepEqual(skills[1].validation.tests, ["tests/*.case.md"]);
    assert.match(skills[1].contentHash, /^[a-f0-9]{64}$/);
    assert.equal(loadedEvent.payload.count, 2);
    assert.equal(loadedEvent.payload.enabled, 1);
    assert.equal(loadedEvent.payload.disabled, 1);
    assert.equal(diagnosticEvent.payload.skillName, "bad-skill");
    await agent.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("matching skills activate and inject context into model requests", async () => {
  const provider = new RecordingProvider("skill-context-provider");
  const agent = await createRunloomAgent({
    provider,
    model: "gpt-4.1",
    workspace: process.cwd()
  });
  const skillEvents = [];
  agent.subscribe((event) => {
    if (event.type === "skill.activated") {
      skillEvents.push(event.payload);
    }
  });

  await agent.registerSkill({
    name: "typescript-code-review",
    version: "0.1.0",
    description: "Review TypeScript changes for public API risk.",
    enabled: true,
    source: "registered",
    triggers: ["review TypeScript"],
    requiredTools: ["fs.read"],
    instructions: "## 执行步骤\n\nFind bugs first.\n\n## 输出格式\n\nFindings first."
  });

  const result = await agent.submit("Please review TypeScript changes");
  const userMessage = provider.requests[0].input.find((item) => item.type === "message" && item.role === "user");

  assert.equal(result.status, "completed");
  assert.equal(skillEvents.length, 1);
  assert.equal(skillEvents[0].skillName, "typescript-code-review");
  assert.match(skillEvents[0].reason, /trigger matched user input/);
  assert.match(userMessage.content[0].text, /Activated skills:/);
  assert.match(userMessage.content[0].text, /typescript-code-review@0\.1\.0/);
  assert.match(userMessage.content[0].text, /Find bugs first/);
  await agent.close();
});

test("MCP config discovery registers tools that enter approval policy", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "runloom-mcp-discovery-"));
  const adapter = new RecordingMcpClient();

  try {
    await writeMcpConfigFixture(stateDir, {
      servers: {
        workspace: {
          transport: "custom",
          enabled: true,
          permissions: {
            tools: "ask",
            resources: "allow",
            prompts: "allow"
          }
        }
      }
    });
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: "",
      stateDir,
      mcpClient: adapter
    });

    const servers = await agent.listMcpServers();
    const tools = await agent.listTools();
    const result = await agent.executeTool("mcp.workspace.echo", { text: "hello" });

    assert.equal(servers[0].status, "connected");
    assert.deepEqual(servers[0].tools, ["echo"]);
    assert.equal(servers[0].resources, 1);
    assert.equal(servers[0].prompts, 1);
    assert.ok(tools.some((tool) => tool.name === "mcp.workspace.echo"));
    assert.equal(result.status, "waiting_approval");
    assert.equal(adapter.calls.length, 0);
    await agent.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("approved MCP tools call the adapter and emit MCP call events", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "runloom-mcp-call-"));
  const adapter = new RecordingMcpClient();

  try {
    await writeMcpConfigFixture(stateDir, {
      servers: {
        workspace: {
          transport: "custom",
          enabled: true,
          permissions: {
            tools: "ask",
            resources: "allow",
            prompts: "allow"
          }
        }
      }
    });
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: "",
      stateDir,
      mcpClient: adapter,
      approvalPolicy: {
        scopes: {
          "mcp.tools": "full_access"
        }
      }
    });
    const eventTypes = [];
    agent.subscribe((event) => eventTypes.push(event.type));

    await agent.listMcpServers();
    const result = await agent.executeTool("mcp.workspace.echo", { text: "hello" });
    const auditRecords = await agent.listAuditRecords({ action: "mcp.tool.called" });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.output, {
      serverName: "workspace",
      toolName: "echo",
      input: { text: "hello" }
    });
    assert.deepEqual(adapter.calls, [
      {
        serverName: "workspace",
        toolName: "echo",
        input: { text: "hello" }
      }
    ]);
    assert.ok(eventTypes.includes("mcp.discovery.completed"));
    assert.ok(eventTypes.includes("mcp.tool.call.requested"));
    assert.ok(eventTypes.includes("mcp.tool.call.completed"));
    assert.equal(auditRecords.length, 1);
    assert.equal(auditRecords[0].summary, "MCP tool called: workspace/echo");
    await agent.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("skills, MCP servers, and external agents can be registered without product mock data", async () => {
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });

  assert.deepEqual(await agent.listSkills(), []);
  assert.deepEqual(await agent.listMcpServers(), []);
  assert.deepEqual(await agent.listExternalAgents(), []);

  await agent.registerSkill({
    name: "typescript-code-review",
    version: "0.1.0",
    description: "Review TypeScript changes.",
    enabled: true,
    source: "registered",
    triggers: ["review"],
    requiredTools: ["fs.read", "git.diff"]
  });
  await agent.registerMcpServer({
    name: "workspace",
    enabled: true,
    transport: "stdio",
    status: "disconnected",
    tools: ["fs.read"],
    resources: 0,
    prompts: 0
  });
  await agent.registerExternalAgent({
    name: "codex",
    description: "Codex CLI",
    kind: "local_cli",
    enabled: true,
    status: "available",
    capabilities: ["code_review", "edit"],
    command: "codex",
    maxTurns: 3
  });

  const skills = await agent.listSkills();
  const servers = await agent.listMcpServers();
  const externalAgents = await agent.listExternalAgents();

  assert.equal(skills[0].name, "typescript-code-review");
  assert.deepEqual(skills[0].requiredTools, ["fs.read", "git.diff"]);
  assert.equal(servers[0].name, "workspace");
  assert.equal(servers[0].transport, "stdio");
  assert.equal(externalAgents[0].name, "codex");
  assert.deepEqual(externalAgents[0].capabilities, ["code_review", "edit"]);
  assert.equal(externalAgents[0].command, "codex");
  await agent.close();
});

test("shell verification is governed by approval policy", async () => {
  const defaultAgent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });

  const waiting = await defaultAgent.executeTool("shell.verify", { command: "node", args: ["--version"] });
  assert.equal(waiting.status, "waiting_approval");
  assert.ok(waiting.approvalId);
  const pendingApprovals = await defaultAgent.listApprovals();
  assert.equal(pendingApprovals.length, 1);
  assert.equal(pendingApprovals[0].id, waiting.approvalId);
  assert.equal(pendingApprovals[0].sessionId, waiting.sessionId);
  await defaultAgent.resolveApproval(waiting.approvalId, { decision: "approved" });
  assert.deepEqual(await defaultAgent.listApprovals(), []);
  await defaultAgent.close();

  const fullAccessAgent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: "",
    approvalPolicy: {
      scopes: {
        shell: "full_access"
      }
    }
  });

  const verified = await fullAccessAgent.executeTool("shell.verify", { command: "node", args: ["--version"] });
  assert.equal(verified.status, "completed");
  assert.equal(verified.output.exitCode, 0);
  assert.match(verified.output.stdout.trim(), /^v\d+\./);
  await fullAccessAgent.close();

  const autoDecideAgent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: "",
    approvalPolicy: {
      scopes: {
        shell: "auto_decide"
      }
    }
  });

  const autoDecision = await autoDecideAgent.executeTool("shell.verify", { command: "node", args: ["--version"] });
  assert.equal(autoDecision.status, "waiting_approval");
  assert.ok(autoDecision.approvalId);
  await autoDecideAgent.close();
});

class RecordingProvider {
  protocol = "custom";
  capabilities = {
    streaming: false,
    tools: true
  };
  requests = [];

  constructor(id) {
    this.id = id;
  }

  async *createResponse(request) {
    this.requests.push(request);
    yield { type: "response.created", responseId: `resp_${this.id}` };
    yield { type: "response.output_text.delta", delta: `${this.id}:${request.model}` };
    yield { type: "response.completed", finishReason: "stop" };
  }
}

class RecordingMcpClient {
  calls = [];

  async discover(server) {
    return {
      tools: [
        {
          name: "echo",
          description: "Echo input.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" }
            },
            additionalProperties: false
          }
        }
      ],
      resources: [
        {
          uri: `runloom://${server.name}/resource`,
          name: "resource"
        }
      ],
      prompts: [
        {
          name: "prompt",
          description: "Prompt fragment."
        }
      ]
    };
  }

  async callTool(server, toolName, input) {
    this.calls.push({
      serverName: server.name,
      toolName,
      input
    });
    return {
      serverName: server.name,
      toolName,
      input
    };
  }
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => {
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function writeSkillFixture(stateDir, source, name, manifest, instructions = validSkillInstructions()) {
  const skillDir = join(stateDir, "skills", source, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(skillDir, "SKILL.md"), instructions, "utf8");
}

async function writeMcpConfigFixture(stateDir, config) {
  await mkdir(join(stateDir, "mcp"), { recursive: true });
  await writeFile(join(stateDir, "mcp", "servers.json"), JSON.stringify(config, null, 2), "utf8");
}

function validSkillInstructions() {
  return [
    "## 适用场景",
    "Review tasks.",
    "## 不适用场景",
    "Unrelated tasks.",
    "## 执行步骤",
    "Read, compare, report.",
    "## 所需工具",
    "fs.read and git.diff.",
    "## 验证方式",
    "Check findings.",
    "## 输出格式",
    "Findings first.",
    "## 示例",
    "Example review."
  ].join("\n\n");
}
