import { randomUUID } from "node:crypto";
import { FILE_HEADERS_ONLY, createTwoFilesPatch } from "diff";
import type { RunloomDiffSummary, ToolDefinition } from "../types.js";

export function createDiffTextTool(): ToolDefinition<{ before: string; after: string; filePath?: string }, RunloomDiffSummary> {
  return {
    name: "diff.text",
    description: "Create a simple unified diff between two text values.",
    inputSchema: {
      type: "object",
      properties: {
        before: { type: "string" },
        after: { type: "string" },
        filePath: { type: "string" }
      },
      required: ["before", "after"],
      additionalProperties: false
    },
    permissions: [],
    async execute(input) {
      const filePath = input.filePath ?? `runloom-${randomUUID()}.txt`;
      const patch = createUnifiedDiff(input.before, input.after, filePath);
      return summarizePatch(patch, filePath);
    }
  };
}

export function createUnifiedDiff(before: string, after: string, filePath: string): string {
  // Keep Runloom's boundary thin here: diff owns the algorithm, Runloom owns security and event records.
  const patch = createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, before, after, undefined, undefined, {
    context: 3,
    headerOptions: FILE_HEADERS_ONLY
  });
  return patch.endsWith("\n") ? patch : `${patch}\n`;
}

export function summarizePatch(patch: string, filePath: string): RunloomDiffSummary {
  const additions = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return {
    filesChanged: [filePath],
    additions,
    deletions,
    patch
  };
}
