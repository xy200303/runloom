import { relative, resolve } from "node:path";

export function resolveWorkspacePath(workspace: string, requestedPath = "."): string {
  const workspaceRoot = resolve(workspace);
  const target = resolve(workspaceRoot, requestedPath);
  const rel = relative(workspaceRoot, target);

  if (rel === "" || (!rel.startsWith("..") && !isAbsoluteRelative(rel))) {
    return target;
  }

  throw new Error(`Path is outside the workspace: ${requestedPath}`);
}

function isAbsoluteRelative(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.startsWith("/") || path.startsWith("\\");
}
