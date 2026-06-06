import { access, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export function resolveWorkspacePath(workspace: string, requestedPath = "."): string {
  const workspaceRoot = resolve(workspace);
  const target = resolve(workspaceRoot, requestedPath || ".");

  if (isPathInsideRoot(workspaceRoot, target)) {
    return target;
  }

  throw new Error(`Path is outside the workspace: ${requestedPath}`);
}

export async function resolveExistingWorkspacePath(workspace: string, requestedPath = "."): Promise<string> {
  const target = resolveWorkspacePath(workspace, requestedPath);
  const [realWorkspaceRoot, realTarget] = await Promise.all([realpath(resolve(workspace)), realpath(target)]);

  // Lexical checks catch "../" escapes; realpath catches symlink escapes that point outside the workspace.
  if (isPathInsideRoot(realWorkspaceRoot, realTarget)) {
    return target;
  }

  throw new Error(`Path is outside the workspace: ${requestedPath}`);
}

export async function resolveWritableWorkspacePath(workspace: string, requestedPath = "."): Promise<string> {
  const target = resolveWorkspacePath(workspace, requestedPath);
  const realWorkspaceRoot = await realpath(resolve(workspace));
  const existingParent = await findExistingParent(dirname(target));
  const realParent = await realpath(existingParent);

  // New files may not exist yet, so validate the nearest existing parent before writing.
  if (isPathInsideRoot(realWorkspaceRoot, realParent)) {
    return target;
  }

  throw new Error(`Path is outside the workspace: ${requestedPath}`);
}

function isPathInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsoluteRelative(rel));
}

async function findExistingParent(path: string): Promise<string> {
  let current = path;
  while (true) {
    if (await exists(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`No existing parent directory found for path: ${path}`);
    }
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isAbsoluteRelative(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.startsWith("/") || path.startsWith("\\");
}
