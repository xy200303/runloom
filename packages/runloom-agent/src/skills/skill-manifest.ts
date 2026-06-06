import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  ApprovalMode,
  RunloomSkillPermissions,
  RunloomSkillSummary,
  RunloomSkillValidation
} from "../types.js";
import { APPROVAL_MODES } from "../approvals/policy.js";

export interface LoadSkillsOptions {
  stateDir?: string;
}

export interface LoadedSkillsResult {
  skills: RunloomSkillSummary[];
  diagnostics: Array<{ skillName: string; source: RunloomSkillSummary["source"]; message: string }>;
}

type SkillSource = Extract<RunloomSkillSummary["source"], "installed" | "generated">;

export interface SkillDefinitionValidationInput {
  manifest: unknown;
  instructions: string;
  source: SkillSource;
  path?: string;
}

export interface SkillDefinitionValidationResult {
  skill?: RunloomSkillSummary;
  diagnostics: string[];
}

export function loadSkills(options: LoadSkillsOptions): LoadedSkillsResult {
  if (!options.stateDir) {
    return { skills: [], diagnostics: [] };
  }

  const root = resolve(options.stateDir, "skills");
  const loaded: RunloomSkillSummary[] = [];
  const diagnostics: LoadedSkillsResult["diagnostics"] = [];

  for (const source of ["installed", "generated"] satisfies SkillSource[]) {
    const sourceRoot = resolve(root, source);
    if (!isSafeDirectory(sourceRoot, root)) {
      continue;
    }
    for (const skillDir of listSkillDirectories(sourceRoot)) {
      const result = loadSkillDirectory(skillDir, source);
      loaded.push(result.skill);
      diagnostics.push(...result.diagnostics);
    }
  }

  return {
    skills: preferInstalledSkills(loaded),
    diagnostics
  };
}

function loadSkillDirectory(
  skillDir: string,
  source: SkillSource
): { skill: RunloomSkillSummary; diagnostics: LoadedSkillsResult["diagnostics"] } {
  const fallbackName = basename(skillDir);
  const diagnostics: LoadedSkillsResult["diagnostics"] = [];
  try {
    const manifestPath = resolve(skillDir, "skill.json");
    const instructionsPath = resolve(skillDir, "SKILL.md");
    assertRegularChildFile(manifestPath, skillDir, "skill.json");
    assertRegularChildFile(instructionsPath, skillDir, "SKILL.md");

    const manifestRaw = readFileSync(manifestPath, "utf8");
    const instructions = readFileSync(instructionsPath, "utf8");
    const validation = validateSkillDefinition({
      manifest: JSON.parse(manifestRaw) as unknown,
      instructions,
      source,
      path: manifestPath
    });
    if (!validation.skill) {
      return {
        skill: disabledSkill(fallbackName, source, validation.diagnostics),
        diagnostics: validation.diagnostics.map((message) => ({ skillName: fallbackName, source, message }))
      };
    }

    return {
      skill: {
        ...validation.skill,
        contentHash: sha256(`${manifestRaw}\n${instructions}`)
      },
      diagnostics
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      skill: disabledSkill(fallbackName, source, [message]),
      diagnostics: [{ skillName: fallbackName, source, message }]
    };
  }
}

export function validateSkillDefinition(input: SkillDefinitionValidationInput): SkillDefinitionValidationResult {
  const path = input.path ?? "<skill proposal>";
  const diagnostics: string[] = [];
  try {
    const skill = parseSkillManifest(input.manifest, input.source, path);
    diagnostics.push(...validateSkillInstructions(input.instructions));
    diagnostics.push(...validateSkillTriggers(skill.triggers ?? []));
    diagnostics.push(...validateSkillPermissions(skill.permissions));
    diagnostics.push(...validateSkillInstructionSafety(input.instructions));
    if (diagnostics.length > 0) {
      return { diagnostics };
    }
    return {
      skill: {
        ...skill,
        instructions: input.instructions,
        contentHash: sha256(`${JSON.stringify(input.manifest)}\n${input.instructions}`)
      },
      diagnostics
    };
  } catch (error) {
    return {
      diagnostics: [error instanceof Error ? error.message : String(error)]
    };
  }
}

function parseSkillManifest(value: unknown, source: SkillSource, path: string): RunloomSkillSummary {
  if (!isRecord(value)) {
    throw new Error(`Skill manifest must be an object: ${path}`);
  }

  const validation = parseValidation(value.validation, path);
  if (validation.schema !== "skill-manifest@1") {
    throw new Error(`Skill manifest validation.schema must be skill-manifest@1: ${path}`);
  }

  return {
    name: parseName(value.name, "name", path),
    version: parseOptionalString(value.version, "version", path),
    description: parseString(value.description, "description", path),
    enabled: true,
    source,
    triggers: parseStringArray(value.triggers, "triggers", path, { minItems: 1 }),
    requiredTools: parseStringArray(value.requiredTools, "requiredTools", path),
    permissions: parsePermissions(value.permissions, path),
    validation
  };
}

function parseValidation(value: unknown, path: string): RunloomSkillValidation {
  if (!isRecord(value)) {
    throw new Error(`Skill manifest validation must be an object: ${path}`);
  }
  const schema = parseString(value.schema, "validation.schema", path);
  const tests = value.tests === undefined ? undefined : parseStringArray(value.tests, "validation.tests", path);
  return {
    schema: schema as RunloomSkillValidation["schema"],
    tests
  };
}

function parsePermissions(value: unknown, path: string): RunloomSkillPermissions | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Skill manifest permissions must be an object: ${path}`);
  }

  return {
    readWorkspace: parseOptionalBoolean(value.readWorkspace, "permissions.readWorkspace", path),
    writeWorkspace: parseOptionalBoolean(value.writeWorkspace, "permissions.writeWorkspace", path),
    shell: parseOptionalShellPermission(value.shell, "permissions.shell", path)
  };
}

function validateSkillInstructions(content: string): string[] {
  const requiredSections = ["适用场景", "不适用场景", "执行步骤", "所需工具", "验证方式", "输出格式", "示例"];
  const missing = requiredSections.filter((section) => !content.includes(section));
  return missing.map((section) => `SKILL.md missing required section: ${section}`);
}

function validateSkillTriggers(triggers: string[]): string[] {
  const broadTriggers = new Set(["*", "all", "any", "anything", "task", "code", "help", "work", "所有任务", "任何任务"]);
  return triggers
    .filter((trigger) => broadTriggers.has(trigger.trim().toLowerCase()))
    .map((trigger) => `Skill trigger is too broad: ${trigger}`);
}

function validateSkillPermissions(permissions: RunloomSkillPermissions | undefined): string[] {
  const diagnostics: string[] = [];
  if (!permissions) {
    return diagnostics;
  }
  if (permissions.writeWorkspace === true) {
    diagnostics.push("Generated skill permissions cannot require writeWorkspace by default.");
  }
  if (permissions.shell === true || permissions.shell === "full_access") {
    diagnostics.push("Generated skill permissions cannot require full shell access by default.");
  }
  return diagnostics;
}

function validateSkillInstructionSafety(content: string): string[] {
  const patterns = [
    /bypass\s+approval/i,
    /skip\s+approval/i,
    /disable\s+approval/i,
    /without\s+approval/i,
    /ignore\s+approval/i,
    /绕过审批/,
    /跳过审批/,
    /忽略审批/,
    /无需审批/
  ];
  return patterns.some((pattern) => pattern.test(content))
    ? ["SKILL.md instructions must not ask the model to bypass approvals."]
    : [];
}

function preferInstalledSkills(skills: RunloomSkillSummary[]): RunloomSkillSummary[] {
  const byName = new Map<string, RunloomSkillSummary>();
  for (const skill of skills) {
    const existing = byName.get(skill.name);
    if (!existing || (existing.source === "generated" && skill.source === "installed")) {
      byName.set(skill.name, cloneSkill(skill));
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function disabledSkill(name: string, source: SkillSource, diagnostics: string[]): RunloomSkillSummary {
  return {
    name: sanitizeSkillName(name),
    description: diagnostics[0] ?? "Invalid skill manifest.",
    enabled: false,
    source,
    diagnostics: [...diagnostics]
  };
}

function listSkillDirectories(sourceRoot: string): string[] {
  if (!existsSync(sourceRoot)) {
    return [];
  }
  const stat = lstatSync(sourceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return [];
  }
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => resolve(sourceRoot, entry.name))
    .filter((path) => isSafeDirectory(path, sourceRoot))
    .sort((a, b) => a.localeCompare(b));
}

function assertRegularChildFile(filePath: string, root: string, label: string): void {
  if (!isPathInside(filePath, root)) {
    throw new Error(`${label} must stay inside the skill directory.`);
  }
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
}

function isSafeDirectory(path: string, root: string): boolean {
  if (!isPathInside(path, root) && path !== root) {
    return false;
  }
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPathInside(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`) || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function parseString(value: unknown, field: string, path: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Skill manifest field ${field} must be a non-empty string: ${path}`);
}

function parseOptionalString(value: unknown, field: string, path: string): string | undefined {
  return value === undefined ? undefined : parseString(value, field, path);
}

function parseName(value: unknown, field: string, path: string): string {
  const name = parseString(value, field, path);
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(name)) {
    throw new Error(`Skill manifest field ${field} contains an invalid skill name: ${path}`);
  }
  return name;
}

function parseStringArray(
  value: unknown,
  field: string,
  path: string,
  options: { minItems?: number } = {}
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Skill manifest field ${field} must be a string array: ${path}`);
  }
  const items = value.map((item) => parseString(item, field, path));
  if (options.minItems && items.length < options.minItems) {
    throw new Error(`Skill manifest field ${field} must contain at least ${options.minItems} item(s): ${path}`);
  }
  return items;
}

function parseOptionalBoolean(value: unknown, field: string, path: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Skill manifest field ${field} must be a boolean: ${path}`);
  }
  return value;
}

function parseOptionalShellPermission(value: unknown, field: string, path: string): ApprovalMode | boolean | undefined {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  if (APPROVAL_MODES.includes(value as ApprovalMode)) {
    return value as ApprovalMode;
  }
  throw new Error(`Skill manifest field ${field} must be a boolean or approval mode: ${path}`);
}

function sanitizeSkillName(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]/gi, "-") || "invalid-skill";
}

function cloneSkill(skill: RunloomSkillSummary): RunloomSkillSummary {
  return {
    ...skill,
    triggers: skill.triggers ? [...skill.triggers] : undefined,
    requiredTools: skill.requiredTools ? [...skill.requiredTools] : undefined,
    instructions: skill.instructions,
    permissions: skill.permissions ? { ...skill.permissions } : undefined,
    validation: skill.validation
      ? {
          ...skill.validation,
          tests: skill.validation.tests ? [...skill.validation.tests] : undefined
        }
      : undefined,
    diagnostics: skill.diagnostics ? [...skill.diagnostics] : undefined
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
