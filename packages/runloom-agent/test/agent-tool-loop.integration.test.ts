import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";
import type { ModelProvider, ModelRequest } from "../src/types.js";

describe("agent tool loop integration", () => {
  it("executes a model-requested workspace tool and continues with its real output", async () => {
    const provider = new ToolCallingProvider();
    const agent = await createRunloomAgent({
      provider,
      workspace: process.cwd()
    });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));

    const result = await agent.submit("Read package.json and summarize the package name");

    expect(result.status).toBe("completed");
    expect(result.outputText).toBe("package.json contains runloom");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.tools?.some((tool) => tool.name === "fs.read")).toBe(true);
    const toolOutput = provider.requests[1]?.input?.find((item) => item.type === "function_call_output");
    expect(toolOutput?.type).toBe("function_call_output");
    const parsedToolOutput = JSON.parse(toolOutput?.type === "function_call_output" ? toolOutput.output : "{}") as {
      output?: { content?: string };
    };
    expect(parsedToolOutput.output?.content).toContain('"name": "runloom"');
    expect(eventTypes).toContain("model.selection.resolved");
    expect(eventTypes).toContain("tool.call.completed");
    expect(eventTypes).toContain("run.completed");

    await agent.close();
  });
});

class ToolCallingProvider implements ModelProvider {
  id = "tool-loop-provider";
  protocol = "custom" as const;
  capabilities = {
    streaming: false,
    tools: true
  };
  requests: ModelRequest[] = [];

  async *createResponse(request: ModelRequest) {
    this.requests.push(request);

    if (this.requests.length === 1) {
      yield { type: "response.created" as const, responseId: "resp_first" };
      yield {
        type: "response.tool_call.completed" as const,
        toolCallId: "call_read_package",
        name: "fs.read",
        arguments: { path: "package.json" }
      };
      yield { type: "response.completed" as const, finishReason: "tool_calls" as const };
      return;
    }

    yield { type: "response.created" as const, responseId: "resp_second" };
    yield { type: "response.output_text.delta" as const, delta: "package.json contains runloom" };
    yield { type: "response.completed" as const, finishReason: "stop" as const };
  }
}
