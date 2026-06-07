import { describe, expect, it } from "vitest";
import {
  createClaudeCodeExternalAgentAdapter,
  createCodexExternalAgentAdapter,
  createRunloomAgent
} from "../src/index.js";

describe("external agent adapters", () => {
  it("creates a default Codex CLI adapter descriptor", () => {
    const adapter = createCodexExternalAgentAdapter();

    expect(adapter).toEqual({
      name: "codex",
      description: "Codex CLI",
      kind: "local_cli",
      enabled: true,
      status: "available",
      capabilities: ["code_review", "edit"],
      command: "codex",
      maxTurns: 3,
      error: undefined
    });
    expect(adapter.delegate).toBeUndefined();
  });

  it("creates a default Claude Code CLI adapter descriptor", () => {
    const adapter = createClaudeCodeExternalAgentAdapter();

    expect(adapter).toEqual({
      name: "claude-code",
      description: "Claude Code CLI",
      kind: "local_cli",
      enabled: true,
      status: "available",
      capabilities: ["code_review", "edit"],
      command: "claude",
      maxTurns: 3,
      error: undefined
    });
    expect(adapter.delegate).toBeUndefined();
  });

  it("allows hosts to override the Codex adapter descriptor", () => {
    const capabilities = ["code_review"];
    const adapter = createCodexExternalAgentAdapter({
      name: "codex-review",
      description: "Codex review-only CLI",
      command: "codex",
      enabled: false,
      status: "disabled",
      capabilities,
      maxTurns: 1,
      error: "disabled by host"
    });
    capabilities.push("edit");

    expect(adapter).toMatchObject({
      name: "codex-review",
      description: "Codex review-only CLI",
      kind: "local_cli",
      enabled: false,
      status: "disabled",
      capabilities: ["code_review"],
      command: "codex",
      maxTurns: 1,
      error: "disabled by host"
    });
  });

  it("registers local CLI adapters through the public agent API", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: ""
    });

    try {
      await agent.registerExternalAgent(createCodexExternalAgentAdapter({ maxTurns: 2 }));
      await agent.registerExternalAgent(createClaudeCodeExternalAgentAdapter({ status: "unavailable" }));

      const agents = await agent.listExternalAgents();
      expect(agents).toEqual([
        {
          name: "claude-code",
          description: "Claude Code CLI",
          kind: "local_cli",
          enabled: true,
          status: "unavailable",
          capabilities: ["code_review", "edit"],
          command: "claude",
          maxTurns: 3,
          error: undefined
        },
        {
          name: "codex",
          description: "Codex CLI",
          kind: "local_cli",
          enabled: true,
          status: "available",
          capabilities: ["code_review", "edit"],
          command: "codex",
          maxTurns: 2,
          error: undefined
        }
      ]);
    } finally {
      await agent.close();
    }
  });
});
