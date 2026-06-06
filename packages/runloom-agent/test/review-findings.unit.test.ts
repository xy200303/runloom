import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";
import type { RunloomReviewFindings } from "../src/index.js";

describe("review findings", () => {
  it("records structured review findings through the public API", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      workspace: process.cwd(),
      apiKey: ""
    });
    const eventTypes: string[] = [];
    agent.subscribe((event) => eventTypes.push(event.type));

    const result = await agent.executeTool<RunloomReviewFindings>("review.findings", {
      reviewedFiles: ["packages/runloom-agent/src/runtime/default-agent.ts"],
      summary: "One high-severity issue was found.",
      findings: [
        {
          severity: "high",
          title: "Resume replays without approved tool continuation",
          description: "The run resumes the original prompt instead of continuing after the approval decision.",
          category: "regression",
          location: {
            path: "packages/runloom-agent/src/runtime/default-agent.ts",
            line: 395
          },
          evidence: ["resume() calls submit() with the original input"],
          recommendation: "Persist pending tool calls and continue from the approved call."
        }
      ]
    });

    expect(result.status).toBe("completed");
    expect(result.output?.id).toMatch(/^review_/);
    expect(result.output?.runId).toBe(result.runId);
    expect(result.output?.sessionId).toBe(result.sessionId);
    expect(eventTypes).toContain("review.findings.created");

    const findings = await agent.listReviewFindings({ runId: result.runId });
    const emptyFindings = await agent.listReviewFindings({ sessionId: result.sessionId, limit: 0 });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe(result.output?.id);
    expect(findings[0]?.findings[0]?.severity).toBe("high");
    expect(findings[0]?.findings[0]?.location?.line).toBe(395);
    expect(emptyFindings).toEqual([]);
    await agent.close();
  });

  it("rejects malformed review findings before recording", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      workspace: process.cwd(),
      apiKey: ""
    });

    const result = await agent.executeTool("review.findings", {
      reviewedFiles: ["packages/runloom-agent/src/types.ts"],
      findings: [
        {
          severity: "urgent",
          title: "Invalid severity",
          description: "This severity is not part of the public review schema."
        }
      ]
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/severity must be critical, high, medium, low, or info/);
    expect(await agent.listReviewFindings({ runId: result.runId })).toEqual([]);
    await agent.close();
  });
});
