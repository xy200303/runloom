import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CodingTaskSummary, GitStatusSummary, WorkspaceAdapter } from "../types.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceInspection {
  summary: CodingTaskSummary;
  packageJson?: string;
}

export async function inspectWorkspace(workspace: string, adapter?: WorkspaceAdapter): Promise<WorkspaceInspection> {
  const packageJson = await readOptionalText(join(workspace, "package.json"), adapter);
  const packageInfo = parsePackageInfo(packageJson);
  const git = adapter?.getGitStatus ? await adapter.getGitStatus() : await readGitStatus(workspace);

  return {
    packageJson,
    summary: {
      workspace,
      packageName: packageInfo.name,
      packageManager: await detectPackageManager(workspace),
      git
    }
  };
}

export function buildWorkspaceContext(inspection: WorkspaceInspection): string {
  const lines: string[] = [];
  lines.push("Workspace summary:");
  lines.push(`- root: ${inspection.summary.workspace}`);
  if (inspection.summary.packageName) {
    lines.push(`- package: ${inspection.summary.packageName}`);
  }
  if (inspection.summary.packageManager) {
    lines.push(`- package manager: ${inspection.summary.packageManager}`);
  }
  if (inspection.summary.git) {
    lines.push(`- git repository: ${inspection.summary.git.isRepository ? "yes" : "no"}`);
    if (inspection.summary.git.branch) {
      lines.push(`- git branch: ${inspection.summary.git.branch}`);
    }
    lines.push(`- git dirty: ${inspection.summary.git.isDirty ? "yes" : "no"}`);
    if (inspection.summary.git.changedFiles.length > 0) {
      lines.push(`- changed files: ${inspection.summary.git.changedFiles.join(", ")}`);
    }
  }
  if (inspection.packageJson) {
    lines.push("");
    lines.push("package.json:");
    lines.push(truncateText(inspection.packageJson, 12000));
  }
  return lines.join("\n");
}

async function readOptionalText(path: string, adapter?: WorkspaceAdapter): Promise<string | undefined> {
  if (adapter?.readFile) {
    try {
      return (await adapter.readFile("package.json", { maxBytes: 12000, encoding: "utf8" })).content;
    } catch {
      // Fall through to the local filesystem for host adapters that only implement part of the contract.
    }
  }
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function parsePackageInfo(packageJson?: string): { name?: string } {
  if (!packageJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(packageJson) as { name?: unknown };
    return typeof parsed.name === "string" ? { name: parsed.name } : {};
  } catch {
    return {};
  }
}

async function detectPackageManager(workspace: string): Promise<string | undefined> {
  const candidates: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"]
  ];

  for (const [file, manager] of candidates) {
    try {
      await access(join(workspace, file));
      return manager;
    } catch {
      // Keep checking the remaining lockfiles.
    }
  }
  return undefined;
}

async function readGitStatus(workspace: string): Promise<GitStatusSummary> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
      cwd: workspace,
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

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}
