import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitStatusSummary, RunloomDiffSummary, ToolDefinition } from "../types.js";

const execFileAsync = promisify(execFile);

export function createGitStatusTool(): ToolDefinition<Record<string, never>, GitStatusSummary> {
  return {
    name: "git.status",
    description: "Read git status for the workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    permissions: ["filesystem.read"],
    async execute(_input, context) {
      try {
        const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
          cwd: context.workspace,
          windowsHide: true
        });
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        const branchLine = lines.find((line) => line.startsWith("## "));
        const branch = branchLine?.replace(/^##\s+/, "").split("...")[0];
        const changedFiles = lines
          .filter((line) => !line.startsWith("## "))
          .map((line) => line.slice(3).trim())
          .filter(Boolean);
        return {
          branch,
          isRepository: true,
          isDirty: changedFiles.length > 0,
          changedFiles
        };
      } catch {
        return {
          isRepository: false,
          isDirty: false,
          changedFiles: []
        };
      }
    }
  };
}

export function createGitDiffTool(): ToolDefinition<
  { staged?: boolean; maxBytes?: number },
  RunloomDiffSummary
> {
  return {
    name: "git.diff",
    description: "Read the current workspace git diff as a unified patch summary.",
    inputSchema: {
      type: "object",
      properties: {
        staged: { type: "boolean" },
        maxBytes: { type: "number" }
      },
      additionalProperties: false
    },
    permissions: ["filesystem.read"],
    async execute(input, context) {
      const modeArgs = input.staged ? ["--cached"] : ["HEAD"];
      try {
        const [{ stdout: numstat }, { stdout: patch }] = await Promise.all([
          execFileAsync("git", ["diff", ...modeArgs, "--numstat", "--"], {
            cwd: context.workspace,
            windowsHide: true
          }),
          execFileAsync("git", ["diff", ...modeArgs, "--no-ext-diff", "--unified=3", "--"], {
            cwd: context.workspace,
            windowsHide: true,
            maxBuffer: 1024 * 1024 * 20
          })
        ]);
        const maxBytes = input.maxBytes ?? 120_000;
        return summarizeGitDiff(numstat, patch, maxBytes);
      } catch {
        return {
          filesChanged: [],
          additions: 0,
          deletions: 0,
          patch: ""
        };
      }
    }
  };
}

function summarizeGitDiff(numstat: string, patch: string, maxBytes: number): RunloomDiffSummary {
  let additions = 0;
  let deletions = 0;
  const filesChanged: string[] = [];

  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [added, deleted, filePath] = line.split("\t");
    if (filePath) {
      filesChanged.push(filePath);
    }
    additions += parseGitNumstatValue(added);
    deletions += parseGitNumstatValue(deleted);
  }

  const truncatedPatch =
    patch.length > maxBytes ? `${patch.slice(0, maxBytes)}\n...[truncated ${patch.length - maxBytes} bytes]` : patch;

  return {
    filesChanged,
    additions,
    deletions,
    patch: truncatedPatch
  };
}

function parseGitNumstatValue(value: string | undefined): number {
  if (!value || value === "-") {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
