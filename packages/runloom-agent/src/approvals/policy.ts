import type { ApprovalMode, ApprovalPolicyConfig, ApprovalPolicyPatch, PermissionScope } from "../types.js";

const DEFAULT_SCOPES: Partial<Record<PermissionScope, ApprovalMode>> = {
  "filesystem.read": "full_access",
  "filesystem.write": "ask",
  "filesystem.delete": "ask",
  shell: "ask",
  network: "ask",
  browser: "ask",
  gui: "ask",
  "mcp.tools": "ask",
  external_agents: "ask",
  "a2a.delegation": "ask",
  "memory.write": "ask",
  "identity.write": "ask",
  "tools.register": "ask",
  "skills.register": "ask",
  "evolution.apply": "ask",
  "npm.publish": "ask"
};

export function createDefaultApprovalPolicy(patch: ApprovalPolicyPatch = {}): ApprovalPolicyConfig {
  return {
    defaultMode: patch.defaultMode ?? "ask",
    scopes: {
      ...DEFAULT_SCOPES,
      ...patch.scopes
    },
    updatedAt: new Date().toISOString(),
    updatedBy: "user"
  };
}

export function applyApprovalPolicyPatch(
  current: ApprovalPolicyConfig,
  patch: ApprovalPolicyPatch,
  updatedBy: ApprovalPolicyConfig["updatedBy"] = "user"
): ApprovalPolicyConfig {
  return {
    defaultMode: patch.defaultMode ?? current.defaultMode,
    scopes: {
      ...current.scopes,
      ...patch.scopes
    },
    updatedAt: new Date().toISOString(),
    updatedBy
  };
}

export function getApprovalMode(policy: ApprovalPolicyConfig, scope: PermissionScope): ApprovalMode {
  return policy.scopes[scope] ?? policy.defaultMode;
}
