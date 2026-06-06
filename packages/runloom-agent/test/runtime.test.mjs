import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunloomAgent, OpenAIResponsesProvider } from "../dist/index.js";

test("approval policy can be updated", async () => {
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });

  const policy = await agent.updateApprovalPolicy({
    scopes: {
      "filesystem.write": "ask",
      shell: "auto_decide"
    }
  });

  assert.equal(policy.scopes["filesystem.write"], "ask");
  assert.equal(policy.scopes.shell, "auto_decide");
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

  assert.ok(readTool);
  assert.equal(readTool.permissions[0], "filesystem.read");
  assert.ok(shellTool);
  assert.equal(shellTool.permissions[0], "shell");
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
