import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ModelRouteConfig,
  ModelSelectionResult,
  RunloomConfig,
  RunloomModelConfig,
  RunloomTaskType
} from "../types.js";

export interface LoadRunloomConfigOptions {
  stateDir?: string;
  workspace: string;
}

export interface ModelSelectionInput {
  explicitModel?: string;
  profile?: string;
  taskType?: RunloomTaskType | string;
  language?: string;
  text: string;
  workspace: string;
  defaultProviderId: string;
  providerAliases?: Record<string, string>;
}

interface ConfigFile {
  path: string;
  config: RunloomConfig;
}

export function loadRunloomConfig(options: LoadRunloomConfigOptions): RunloomConfig {
  const files: ConfigFile[] = [];
  if (options.stateDir) {
    files.push(readConfigFile(join(resolve(options.stateDir), "config.json")));
  }
  files.push(readConfigFile(join(resolve(options.workspace), ".runloom", "config.json")));

  return files.reduce<RunloomConfig>((merged, file) => mergeConfig(merged, file.config), {});
}

export function selectModel(config: RunloomConfig, input: ModelSelectionInput): ModelSelectionResult {
  const inferredTaskType = input.taskType ?? inferTaskType(input.text);
  const inferredLanguage = normalizeLanguage(input.language ?? inferLanguage(input.text, input.workspace, inferredTaskType));

  if (input.explicitModel) {
    return toSelection(input.explicitModel, input, {
      source: "explicit",
      reason: "explicit model requested",
      profile: input.profile,
      taskType: inferredTaskType,
      language: inferredLanguage
    });
  }

  const profileModel = input.profile ? config.model?.profiles?.[input.profile] : undefined;
  if (profileModel) {
    return toSelection(profileModel, input, {
      source: "profile",
      reason: `profile matched: ${input.profile}`,
      profile: input.profile,
      taskType: inferredTaskType,
      language: inferredLanguage
    });
  }

  const routes = config.model?.routes ?? [];
  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i];
    if (route && routeMatches(route, { taskType: inferredTaskType, language: inferredLanguage, workspace: input.workspace })) {
      return toSelection(route.model, input, {
        source: "route",
        reason: routeReason(route),
        profile: route.profile,
        taskType: inferredTaskType,
        language: inferredLanguage,
        routeIndex: i
      });
    }
  }

  if (config.model?.default) {
    return toSelection(config.model.default, input, {
      source: "default",
      reason: "configured default model",
      taskType: inferredTaskType,
      language: inferredLanguage
    });
  }

  return toSelection("gpt-4.1", input, {
    source: "fallback",
    reason: "built-in fallback model",
    taskType: inferredTaskType,
    language: inferredLanguage
  });
}

function readConfigFile(path: string): ConfigFile {
  if (!existsSync(path)) {
    return { path, config: {} };
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Runloom config JSON at ${path}: ${message}`);
  }

  assertNoSecretKeys(parsed, path);
  return { path, config: parseConfig(parsed, path) };
}

function parseConfig(value: unknown, path: string): RunloomConfig {
  if (!isRecord(value)) {
    throw new Error(`Runloom config must be an object: ${path}`);
  }

  return {
    model: parseModelConfig(value.model, path)
  };
}

function parseModelConfig(value: unknown, path: string): RunloomModelConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Runloom model config must be an object: ${path}`);
  }

  const modelConfig: RunloomModelConfig = {};
  if (value.default !== undefined) {
    modelConfig.default = parseString(value.default, "model.default", path);
  }
  if (value.profiles !== undefined) {
    if (!isRecord(value.profiles)) {
      throw new Error(`Runloom model.profiles must be an object: ${path}`);
    }
    modelConfig.profiles = {};
    for (const [profile, model] of Object.entries(value.profiles)) {
      modelConfig.profiles[profile] = parseString(model, `model.profiles.${profile}`, path);
    }
  }
  if (value.routes !== undefined) {
    if (!Array.isArray(value.routes)) {
      throw new Error(`Runloom model.routes must be an array: ${path}`);
    }
    modelConfig.routes = value.routes.map((route, index) => parseRoute(route, index, path));
  }

  return modelConfig;
}

function parseRoute(value: unknown, index: number, path: string): ModelRouteConfig {
  if (!isRecord(value)) {
    throw new Error(`Runloom model.routes[${index}] must be an object: ${path}`);
  }
  if (!isRecord(value.when)) {
    throw new Error(`Runloom model.routes[${index}].when must be an object: ${path}`);
  }

  const route: ModelRouteConfig = {
    when: {},
    model: parseString(value.model, `model.routes.${index}.model`, path)
  };

  if (value.profile !== undefined) {
    route.profile = parseString(value.profile, `model.routes.${index}.profile`, path);
  }
  if (value.when.taskType !== undefined) {
    route.when.taskType = parseString(value.when.taskType, `model.routes.${index}.when.taskType`, path);
  }
  if (value.when.language !== undefined) {
    route.when.language = normalizeLanguage(parseString(value.when.language, `model.routes.${index}.when.language`, path));
  }
  if (value.when.workspacePattern !== undefined) {
    route.when.workspacePattern = parseString(
      value.when.workspacePattern,
      `model.routes.${index}.when.workspacePattern`,
      path
    );
  }

  if (!route.when.taskType && !route.when.language && !route.when.workspacePattern) {
    throw new Error(`Runloom model.routes[${index}].when must contain at least one matcher: ${path}`);
  }

  return route;
}

function parseString(value: unknown, field: string, path: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Runloom config field ${field} must be a non-empty string: ${path}`);
}

function mergeConfig(base: RunloomConfig, override: RunloomConfig): RunloomConfig {
  return {
    model: mergeModelConfig(base.model, override.model)
  };
}

function mergeModelConfig(base?: RunloomModelConfig, override?: RunloomModelConfig): RunloomModelConfig | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    default: override?.default ?? base?.default,
    profiles: {
      ...(base?.profiles ?? {}),
      ...(override?.profiles ?? {})
    },
    routes: [...(override?.routes ?? []), ...(base?.routes ?? [])]
  };
}

function routeMatches(
  route: ModelRouteConfig,
  context: { taskType?: string; language?: string; workspace: string }
): boolean {
  if (route.when.taskType && route.when.taskType !== context.taskType) {
    return false;
  }
  if (route.when.language && normalizeLanguage(route.when.language) !== context.language) {
    return false;
  }
  if (route.when.workspacePattern && !matchesPattern(context.workspace, route.when.workspacePattern)) {
    return false;
  }
  return true;
}

function routeReason(route: ModelRouteConfig): string {
  const matchers: string[] = [];
  if (route.when.taskType) {
    matchers.push(`taskType=${route.when.taskType}`);
  }
  if (route.when.language) {
    matchers.push(`language=${route.when.language}`);
  }
  if (route.when.workspacePattern) {
    matchers.push(`workspacePattern=${route.when.workspacePattern}`);
  }
  return `route matched: ${matchers.join(", ")}`;
}

function toSelection(
  modelRef: string,
  input: ModelSelectionInput,
  metadata: Omit<ModelSelectionResult, "providerId" | "model" | "modelRef">
): ModelSelectionResult {
  const parsed = parseModelRef(modelRef, input.defaultProviderId, input.providerAliases ?? {});
  return {
    ...metadata,
    providerId: parsed.providerId,
    model: parsed.model,
    modelRef
  };
}

function parseModelRef(
  modelRef: string,
  defaultProviderId: string,
  providerAliases: Record<string, string>
): { providerId: string; model: string } {
  const separator = modelRef.indexOf(":");
  if (separator <= 0) {
    return {
      providerId: defaultProviderId,
      model: modelRef
    };
  }

  const rawProviderId = modelRef.slice(0, separator);
  const model = modelRef.slice(separator + 1);
  return {
    providerId: providerAliases[rawProviderId] ?? rawProviderId,
    model
  };
}

function inferTaskType(text: string): RunloomTaskType {
  const lower = text.toLowerCase();
  if (lower.includes("prototype") || text.includes("原型")) {
    return "prototype_design";
  }
  if (/\bgo\b|golang|go开发/i.test(text)) {
    return "go_development";
  }
  if (lower.includes("frontend") || lower.includes("ui") || lower.includes("vue") || lower.includes("react") || text.includes("前端")) {
    return "frontend_design";
  }
  if (lower.includes("review") || text.includes("审查") || text.includes("评审")) {
    return "code_review";
  }
  if (lower.includes("test") || text.includes("测试")) {
    return "test_fix";
  }
  return "general";
}

function inferLanguage(text: string, workspace: string, taskType?: string): string | undefined {
  if (taskType === "go_development" || /\bgo\b|golang|go开发/i.test(text)) {
    return "go";
  }
  if (existsSync(join(workspace, "go.mod"))) {
    return "go";
  }
  if (existsSync(join(workspace, "package.json"))) {
    return "typescript";
  }
  return undefined;
}

function normalizeLanguage(language: string | undefined): string | undefined {
  return language?.trim().toLowerCase() || undefined;
}

function matchesPattern(value: string, pattern: string): boolean {
  const normalizedValue = value.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const regex = new RegExp(`^${escapeRegExp(normalizedPattern).replace(/\\\*/g, ".*")}$`, "i");
  return regex.test(normalizedValue);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNoSecretKeys(value: unknown, path: string): void {
  if (!isRecord(value) && !Array.isArray(value)) {
    return;
  }

  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    if (typeof key === "string" && /api[-_]?key|token|secret|password|cookie/i.test(key)) {
      throw new Error(`Runloom config must not contain secret-like field '${key}': ${path}`);
    }
    assertNoSecretKeys(child, path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
