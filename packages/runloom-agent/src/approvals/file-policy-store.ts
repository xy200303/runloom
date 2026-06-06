import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ApprovalMode, ApprovalPolicyConfig, PermissionScope } from "../types.js";
import { APPROVAL_MODES, PERMISSION_SCOPES } from "./policy.js";

export class FileApprovalPolicyStore {
  private readonly workspace: string;
  private readonly filePath: string;

  constructor(stateDir: string, workspace: string) {
    this.workspace = resolve(workspace);
    const workspaceId = createHash("sha256").update(this.workspace).digest("hex").slice(0, 24);
    this.filePath = join(resolve(stateDir), "workspaces", `${workspaceId}.approval-policy.json`);
  }

  load(): ApprovalPolicyConfig | undefined {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return parseStoredPolicy(parsed, this.workspace);
    } catch {
      return undefined;
    }
  }

  save(policy: ApprovalPolicyConfig): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(
      tempPath,
      JSON.stringify(
        {
          version: 1,
          workspace: this.workspace,
          policy
        },
        null,
        2
      ),
      "utf8"
    );
    renameSync(tempPath, this.filePath);
  }
}

function parseStoredPolicy(value: unknown, workspace: string): ApprovalPolicyConfig | undefined {
  if (!isRecord(value) || value.version !== 1 || value.workspace !== workspace || !isRecord(value.policy)) {
    return undefined;
  }

  const policy = value.policy;
  const defaultMode = parseApprovalMode(policy.defaultMode);
  const updatedAt = typeof policy.updatedAt === "string" ? policy.updatedAt : undefined;
  const updatedBy = parseUpdatedBy(policy.updatedBy);

  if (!defaultMode || !updatedAt || !updatedBy) {
    return undefined;
  }

  const scopes: Partial<Record<PermissionScope, ApprovalMode>> = {};
  if (isRecord(policy.scopes)) {
    for (const [scope, mode] of Object.entries(policy.scopes)) {
      const parsedScope = parsePermissionScope(scope);
      const parsedMode = parseApprovalMode(mode);
      if (parsedScope && parsedMode) {
        scopes[parsedScope] = parsedMode;
      }
    }
  }

  return {
    defaultMode,
    scopes,
    updatedAt,
    updatedBy
  };
}

function parseApprovalMode(value: unknown): ApprovalMode | undefined {
  return APPROVAL_MODES.includes(value as ApprovalMode) ? (value as ApprovalMode) : undefined;
}

function parsePermissionScope(value: unknown): PermissionScope | undefined {
  return PERMISSION_SCOPES.includes(value as PermissionScope) ? (value as PermissionScope) : undefined;
}

function parseUpdatedBy(value: unknown): ApprovalPolicyConfig["updatedBy"] | undefined {
  if (value === "user" || value === "host_app" || value === "migration") {
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
