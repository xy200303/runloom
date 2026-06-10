import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { FILE_HEADERS_ONLY, createTwoFilesPatch } from "diff";
import type {
  RunloomDiffSummary,
  TerminalAdapter,
  ToolDefinition,
  VerificationResult
} from "../types.js";
import {
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath
} from "../security/path-guard.js";
import {
  createDeliverySummaryTool,
  createEditPlanTool,
  createReviewFindingsTool
} from "./artifact-tools.js";
import {
  createGitDiffTool,
  createGitStatusTool
} from "./git-tools.js";

const execFileAsync = promisify(execFile);
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", ".tsbuildinfo"]);

export interface CreateBuiltInCodingToolsOptions {
  terminal?: TerminalAdapter;
}

export function createBuiltInCodingTools(options: CreateBuiltInCodingToolsOptions = {}): ToolDefinition[] {
  return [
    createListFilesTool(),
    createReadFileTool(),
    createSearchFilesTool(),
    createEditPlanTool(),
    createWriteFileTool(),
    createPatchFileTool(),
    createDiffTextTool(),
    createVerifyCommandTool(options.terminal),
    createGitStatusTool(),
    createGitDiffTool(),
    createReviewFindingsTool(),
    createDeliverySummaryTool()
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
      const root = await resolveExistingWorkspacePath(context.workspace, input.path);
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
      const target = await resolveExistingWorkspacePath(context.workspace, input.path);
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
      const root = await resolveExistingWorkspacePath(context.workspace, input.path);
      const candidates: string[] = [];
      const maxResults = input.maxResults ?? 100;
      const maxFileBytes = input.maxFileBytes ?? 200_000;
      await walk(root, context.workspace, candidates, 5000);

      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const file of candidates) {
        if (matches.length >= maxResults) {
          break;
        }
        const abs = await resolveExistingWorkspacePath(context.workspace, file);
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

function createWriteFileTool(): ToolDefinition<
  { path: string; content: string; expectedSha256?: string; allowDirty?: boolean },
  { path: string; bytes: number; sha256Before?: string; sha256After: string }
> {
  return {
    name: "fs.write",
    description: "Write a UTF-8 file inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedSha256: { type: "string" },
        allowDirty: { type: "boolean" }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    permissions: ["filesystem.write"],
    async execute(input, context) {
      const target = await resolveWritableWorkspacePath(context.workspace, input.path);
      const filePath = relative(context.workspace, target);
      const existingContent = await readFile(target, "utf8").catch(() => undefined);
      const sha256Before = existingContent === undefined ? undefined : sha256(existingContent);
      if (input.expectedSha256 && input.expectedSha256 !== sha256Before) {
        throw new Error(`fs.write expected sha256 ${input.expectedSha256}, but found ${sha256Before ?? "missing file"}.`);
      }
      await assertFileCanBeModified(context.workspace, filePath, {
        allowDirty: input.allowDirty,
        hasExpectedCurrentContent: Boolean(input.expectedSha256)
      });
      await writeFile(target, input.content, "utf8");
      return {
        path: filePath,
        bytes: Buffer.byteLength(input.content),
        sha256Before,
        sha256After: sha256(input.content)
      };
    }
  };
}

function createPatchFileTool(): ToolDefinition<
  { path: string; before: string; after: string; expectedSha256?: string; replaceAll?: boolean; allowDirty?: boolean },
  RunloomDiffSummary & { path: string; bytes: number; replacements: number; sha256Before: string; sha256After: string }
> {
  return {
    name: "fs.patch",
    description: "Apply an exact text replacement patch inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        before: { type: "string" },
        after: { type: "string" },
        expectedSha256: { type: "string" },
        replaceAll: { type: "boolean" },
        allowDirty: { type: "boolean" }
      },
      required: ["path", "before", "after"],
      additionalProperties: false
    },
    permissions: ["filesystem.write"],
    async execute(input, context) {
      if (input.before.length === 0) {
        throw new Error("fs.patch requires a non-empty before text.");
      }

      const target = await resolveExistingWorkspacePath(context.workspace, input.path);
      const filePath = relative(context.workspace, target);
      const content = await readFile(target, "utf8");
      const sha256Before = sha256(content);
      if (input.expectedSha256 && input.expectedSha256 !== sha256Before) {
        throw new Error(`fs.patch expected sha256 ${input.expectedSha256}, but found ${sha256Before}.`);
      }
      await assertFileCanBeModified(context.workspace, filePath, {
        allowDirty: input.allowDirty,
        hasExpectedCurrentContent: Boolean(input.expectedSha256)
      });

      const occurrences = countOccurrences(content, input.before);
      if (occurrences === 0) {
        throw new Error(`fs.patch could not find the before text in ${filePath}.`);
      }
      if (occurrences > 1 && !input.replaceAll) {
        throw new Error(`fs.patch found ${occurrences} matches in ${filePath}; set replaceAll to patch all matches.`);
      }

      const nextContent = input.replaceAll ? content.split(input.before).join(input.after) : content.replace(input.before, input.after);
      await writeFile(target, nextContent, "utf8");
      const patch = createUnifiedDiff(content, nextContent, filePath);
      const sha256After = sha256(nextContent);

      return {
        ...summarizePatch(patch, filePath),
        path: filePath,
        bytes: Buffer.byteLength(nextContent),
        replacements: input.replaceAll ? occurrences : 1,
        sha256Before,
        sha256After
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

function createVerifyCommandTool(terminal?: TerminalAdapter): ToolDefinition<
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
      const cwd = await resolveExistingWorkspacePath(context.workspace, input.cwd);
      if (terminal) {
        return runVerificationWithTerminalAdapter(terminal, input, cwd, started, context.signal);
      }
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

async function runVerificationWithTerminalAdapter(
  terminal: TerminalAdapter,
  input: { command: string; args?: string[]; timeoutMs?: number },
  cwd: string,
  started: number,
  signal: AbortSignal | undefined
): Promise<VerificationResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    for await (const event of terminal.run(
      {
        command: input.command,
        args: input.args,
        cwd,
        timeoutMs: input.timeoutMs
      },
      {
        cwd,
        timeoutMs: input.timeoutMs ?? 120_000,
        signal
      }
    )) {
      if (event.type === "stdout") {
        stdout += event.text;
      } else if (event.type === "stderr") {
        stderr += event.text;
      } else if (event.type === "exit") {
        exitCode = event.exitCode;
      } else if (event.type === "failed") {
        exitCode = event.exitCode ?? 1;
        stderr += event.error;
      }
    }
  } catch (error) {
    exitCode = 1;
    stderr += error instanceof Error ? error.message : String(error);
  }

  return {
    command: [input.command, ...(input.args ?? [])].join(" "),
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started
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
  // Keep Runloom's boundary thin here: diff owns the algorithm, Runloom owns security and event records.
  const patch = createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, before, after, undefined, undefined, {
    context: 3,
    headerOptions: FILE_HEADERS_ONLY
  });
  return patch.endsWith("\n") ? patch : `${patch}\n`;
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

async function assertFileCanBeModified(
  workspace: string,
  filePath: string,
  options: { allowDirty?: boolean; hasExpectedCurrentContent?: boolean }
): Promise<void> {
  if (options.allowDirty || options.hasExpectedCurrentContent) {
    return;
  }

  const dirty = await getGitStatusForPath(workspace, filePath);
  if (dirty) {
    throw new Error(
      `Refusing to modify ${filePath} because it has uncommitted changes. Provide expectedSha256 or allowDirty to continue.`
    );
  }
}

async function getGitStatusForPath(workspace: string, filePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--", filePath], {
      cwd: workspace,
      windowsHide: true
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let index = text.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(search, index + search.length);
  }
  return count;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
