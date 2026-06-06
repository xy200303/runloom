import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";
import type { RunloomDeliverySummary } from "../src/index.js";

describe("delivery summaries", () => {
  it("records final delivery summaries through the public API", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      workspace: process.cwd(),
      apiKey: ""
    });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));

    const result = await agent.executeTool<RunloomDeliverySummary>("delivery.summary", {
      modifiedFiles: ["packages/runloom-agent/src/types.ts"],
      coreChanges: ["Added a delivery summary record API"],
      verificationResults: [
        {
          command: "pnpm test:unit",
          status: "passed",
          exitCode: 0,
          summary: "Unit tests passed"
        }
      ],
      failedItems: [],
      remainingRisks: ["Persistent storage is still pending"]
    });

    expect(result.status).toBe("completed");
    expect(result.output?.id).toMatch(/^delivery_/);
    expect(result.output?.runId).toBe(result.runId);
    expect(result.output?.sessionId).toBe(result.sessionId);
    expect(eventTypes).toContain("delivery.summary.created");

    const summaries = await agent.listDeliverySummaries({ runId: result.runId });
    const emptySummaries = await agent.listDeliverySummaries({ sessionId: result.sessionId, limit: 0 });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe(result.output?.id);
    expect(summaries[0]?.verificationResults[0]?.status).toBe("passed");
    expect(emptySummaries).toEqual([]);
    await agent.close();
  });

  it("rejects malformed delivery summaries before recording", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      workspace: process.cwd(),
      apiKey: ""
    });

    const result = await agent.executeTool("delivery.summary", {
      modifiedFiles: ["packages/runloom-agent/src/types.ts"],
      coreChanges: ["Invalid verification status"],
      verificationResults: [{ command: "pnpm test:unit", status: "unknown" }],
      failedItems: [],
      remainingRisks: []
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/status must be passed, failed, or skipped/);
    expect(await agent.listDeliverySummaries({ runId: result.runId })).toEqual([]);
    await agent.close();
  });
});
