import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { GitStatusSummary, RunloomDiffSummary, ToolDefinition, VerificationResult } from "../types.js";
import { resolveWorkspacePath } from "./path-guard.js";

const execFileAsync = promisify(execFile);
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", ".tsbuildinfo"]);

export function createBuiltInCodingTools(): ToolDefinition[] {
  return [
    createListFilesTool(),
    createReadFileTool(),
    createSearchFilesTool(),
    createWriteFileTool(),
    createDiffTextTool(),
    createVerifyCommandTool(),
    createGitStatusTool()
  ];
}

function createListFilesTool(): ToolDefinition<{ path?: string; recursive?: boolean; maxEntries?: number }, { files: string[] }> {
  return {
    name: "fs.list",
    description: "List files in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        maxEntries: { type: "number" }
      },
      additionalProperties: false
    },
    permissions: ["filesystem.read"],
    async execute(input, context) {
      const root = resolveWorkspacePath(context.workspace, input.path);
      const maxEntries = input.maxEntries ?? 200;
      const files: string[] = [];

      if (input.recursive) {
        await walk(root, context.workspace, files, maxEntries);
      } else {
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries.slice(0, maxEntries)) {
          files.push(relative(context.workspace, join(root, entry.name)) || entry.name);
        }
      }

      return { files };
    }
  };
}

function createReadFileTool(): ToolDefinition<{ path: string; maxBytes?: number }, { path: string; content: string; truncated: boolean }> {
  return {
    name: "fs.read",
    description: "Read a UTF-8 file from the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number" }
      },
      required: ["path"],
      additionalProperties: false
    },
    permissions: ["filesystem.read"],
    async execute(input, context) {
      const target = resolveWorkspacePath(context.workspace, input.path);
      const maxBytes = input.maxBytes ?? 120_000;
      const content = await readFile(target, "utf8");
      return {
        path: relative(context.workspace, target),
        content: content.length > maxBytes ? content.slice(0, maxBytes) : content,
        truncated: content.length > maxBytes
      };
    }
  };
}

function createSearchFilesTool(): ToolDefinition<
  { query: string; path?: string; maxResults?: number; maxFileBytes?: number },
  { matches: Array<{ path: string; line: number; text: string }> }
> {
  return {
    name: "fs.search",
    description: "Search UTF-8 workspace files for a literal query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        maxResults: { type: "number" },
        maxFileBytes: { type: "number" }
      },
      required: ["query"],
      additionalProperties: false
    },
    permissions: ["filesystem.read"],
    async execute(input, context) {
      const root = resolveWorkspacePath(context.workspace, input.path);
      const candidates: string[] = [];
      const maxResults = input.maxResults ?? 100;
      const maxFileBytes = input.maxFileBytes ?? 200_000;
      await walk(root, context.workspace, candidates, 5000);

      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const file of candidates) {
        if (matches.length >= maxResults) {
          break;
        }
        const abs = resolveWorkspacePath(context.workspace, file);
        const fileStat = await stat(abs).catch(() => undefined);
        if (!fileStat?.isFile() || fileStat.size > maxFileBytes) {
          continue;
        }
        const content = await readFile(abs, "utf8").catch(() => undefined);
        if (!content) {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i]?.includes(input.query)) {
            matches.push({ path: file, line: i + 1, text: lines[i] ?? "" });
            if (matches.length >= maxResults) {
              break;
            }
          }
        }
      }
      return { matches };
    }
  };
}

function createWriteFileTool(): ToolDefinition<{ path: string; content: string }, { path: string; bytes: number }> {
  return {
    name: "fs.write",
    description: "Write a UTF-8 file inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    permissions: ["filesystem.write"],
    async execute(input, context) {
      const target = resolveWorkspacePath(context.workspace, input.path);
      await writeFile(target, input.content, "utf8");
      return {
        path: relative(context.workspace, target),
        bytes: Buffer.byteLength(input.content)
      };
    }
  };
}

function createDiffTextTool(): ToolDefinition<{ before: string; after: string; filePath?: string }, RunloomDiffSummary> {
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

function createVerifyCommandTool(): ToolDefinition<
  { command: string; args?: string[]; cwd?: string; timeoutMs?: number },
  VerificationResult
> {
  return {
    name: "shell.verify",
    description: "Run a verification command in the workspace without shell interpolation.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "number" }
      },
      required: ["command"],
      additionalProperties: false
    },
    permissions: ["shell"],
    async execute(input, context) {
      const started = Date.now();
      const cwd = resolveWorkspacePath(context.workspace, input.cwd);
      try {
        const result = await execFileAsync(input.command, input.args ?? [], {
          cwd,
          timeout: input.timeoutMs ?? 120_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024 * 10
        });
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - started
        };
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
        return {
          command: [input.command, ...(input.args ?? [])].join(" "),
          exitCode: typeof err.code === "number" ? err.code : 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? err.message ?? "",
          durationMs: Date.now() - started
        };
      }
    }
  };
}

function createGitStatusTool(): ToolDefinition<Record<string, never>, GitStatusSummary> {
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

async function walk(root: string, workspace: string, output: string[], maxEntries: number): Promise<void> {
  if (output.length >= maxEntries) {
    return;
  }

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (output.length >= maxEntries) {
      return;
    }
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) {
      continue;
    }
    const abs = join(root, entry.name);
    const rel = relative(workspace, abs);
    if (entry.isDirectory()) {
      await walk(abs, workspace, output, maxEntries);
    } else {
      output.push(rel);
    }
  }
}

function createUnifiedDiff(before: string, after: string, filePath: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`, "@@"];
  const max = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < max; i += 1) {
    const beforeLine = beforeLines[i];
    const afterLine = afterLines[i];
    if (beforeLine === afterLine && beforeLine !== undefined) {
      lines.push(` ${beforeLine}`);
    } else {
      if (beforeLine !== undefined) {
        lines.push(`-${beforeLine}`);
      }
      if (afterLine !== undefined) {
        lines.push(`+${afterLine}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function summarizePatch(patch: string, filePath: string): RunloomDiffSummary {
  const additions = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return {
    filesChanged: [filePath],
    additions,
    deletions,
    patch
  };
}
