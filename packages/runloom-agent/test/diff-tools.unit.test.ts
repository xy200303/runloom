import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";
import type { RunloomDiffSummary } from "../src/index.js";

describe("diff tools", () => {
  it("uses a mature line diff for inserted lines", async () => {
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      workspace: process.cwd(),
      apiKey: ""
    });

    const result = await agent.executeTool<RunloomDiffSummary>("diff.text", {
      before: "alpha\nbeta\ngamma\n",
      after: "alpha\ninserted\nbeta\ngamma\n",
      filePath: "sample.txt"
    });

    expect(result.status).toBe("completed");
    expect(result.output?.additions).toBe(1);
    expect(result.output?.deletions).toBe(0);
    expect(result.output?.patch).toContain("+inserted");
    expect(result.output?.patch).not.toContain("-beta");
    expect(result.output?.patch).not.toContain("-gamma");
    await agent.close();
  });
});
