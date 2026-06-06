import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await agent.close();
});

test("built-in coding tools operate on real workspace data", async () => {
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
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

  await agent.close();
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
  const shellTool = tools.find((tool) => tool.name === "shell.verify");
  const diffTool = tools.find((tool) => tool.name === "git.diff");

  assert.ok(readTool);
  assert.equal(readTool.permissions[0], "filesystem.read");
  assert.ok(shellTool);
  assert.equal(shellTool.permissions[0], "shell");
  assert.ok(diffTool);
  assert.equal(diffTool.permissions[0], "filesystem.read");
  await agent.close();
});

test("skills and MCP servers can be registered without product mock data", async () => {
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });

  assert.deepEqual(await agent.listSkills(), []);
  assert.deepEqual(await agent.listMcpServers(), []);

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

  const skills = await agent.listSkills();
  const servers = await agent.listMcpServers();

  assert.equal(skills[0].name, "typescript-code-review");
  assert.deepEqual(skills[0].requiredTools, ["fs.read", "git.diff"]);
  assert.equal(servers[0].name, "workspace");
  assert.equal(servers[0].transport, "stdio");
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
