import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";
import type { RunloomEditPlan } from "../src/index.js";

describe("edit plans", () => {
  it("records built-in edit plans through the public API", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      workspace: process.cwd(),
      apiKey: ""
    });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));

    const result = await agent.executeTool<RunloomEditPlan>("edit.plan", {
      goal: "Add a runtime API before changing code",
      targetFiles: ["packages/runloom-agent/src/types.ts", "packages/runloom-agent/src/runtime/default-agent.ts"],
      risks: ["Public API changes need type and runtime coverage"],
      verificationCommands: ["pnpm test:unit", "pnpm typecheck"],
      reason: "The change affects host-facing runtime behavior"
    });

    expect(result.status).toBe("completed");
    expect(result.output?.id).toMatch(/^editplan_/);
    expect(result.output?.status).toBe("proposed");
    expect(result.output?.runId).toBe(result.runId);
    expect(result.output?.sessionId).toBe(result.sessionId);
    expect(eventTypes).toContain("edit.plan.created");

    const plans = await agent.listEditPlans({ runId: result.runId });
    const emptyPlans = await agent.listEditPlans({ sessionId: result.sessionId, limit: 0 });

    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe(result.output?.id);
    expect(plans[0]?.targetFiles).toEqual(result.output?.targetFiles);
    expect(emptyPlans).toEqual([]);
    await agent.close();
  });

  it("rejects malformed edit plan input before recording", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      workspace: process.cwd(),
      apiKey: ""
    });

    const result = await agent.executeTool("edit.plan", {
      goal: "Invalid plan",
      targetFiles: "packages/runloom-agent/src/types.ts",
      risks: ["Invalid target file shape"],
      verificationCommands: ["pnpm test:unit"]
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/targetFiles to be a string array/);
    expect(await agent.listEditPlans({ runId: result.runId })).toEqual([]);
    await agent.close();
  });
});
