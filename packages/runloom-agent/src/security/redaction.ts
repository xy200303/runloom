import { resolve } from "node:path";

export interface RedactionOptions {
  workspace?: string;
}

const SECRET_REPLACEMENT = "[redacted:secret]";
const WORKSPACE_REPLACEMENT = "[workspace]";
const SECRET_KEY_PATTERN = /(?:api[-_]?key|token|secret|password|cookie|authorization)/i;
const QUOTED_SECRET_PROPERTY_PATTERN =
  /(["'])([A-Za-z0-9_.-]*(?:api[-_]?key|token|secret|password|cookie|authorization)[A-Za-z0-9_.-]*)\1(\s*:\s*)(["'])([^"']+)\4/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:api[-_]?key|token|secret|password|cookie|authorization)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)([^\s"',;]+)(\2)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const STANDALONE_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g
];

export function redactText(text: string, options: RedactionOptions = {}): string {
  let redacted = redactWorkspacePath(text, options.workspace);
  redacted = redacted.replace(
    QUOTED_SECRET_PROPERTY_PATTERN,
    (_match, keyQuote: string, key: string, separator: string, valueQuote: string) =>
      `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${SECRET_REPLACEMENT}${valueQuote}`
  );
  redacted = redacted.replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, quote: string) => {
    return `${prefix}${quote}${SECRET_REPLACEMENT}${quote}`;
  });
  redacted = redacted.replace(BEARER_PATTERN, (_match, prefix: string) => `${prefix}${SECRET_REPLACEMENT}`);
  for (const pattern of STANDALONE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, SECRET_REPLACEMENT);
  }
  return redacted;
}

export function redactValue<TValue>(value: TValue, options: RedactionOptions = {}): TValue {
  return redactUnknown(value, options, new WeakSet<object>()) as TValue;
}

function redactUnknown(value: unknown, options: RedactionOptions, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactText(value, options);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (seen.has(value)) {
    return "[redacted:circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const redactedItems = value.map((item) => redactUnknown(item, options, seen));
    seen.delete(value);
    return redactedItems;
  }

  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    redacted[key] = SECRET_KEY_PATTERN.test(key) ? SECRET_REPLACEMENT : redactUnknown(child, options, seen);
  }
  seen.delete(value);
  return redacted;
}

function redactWorkspacePath(text: string, workspace?: string): string {
  if (!workspace) {
    return text;
  }

  const workspaceRoot = resolve(workspace);
  const variants = new Set([
    workspaceRoot,
    workspaceRoot.replace(/\\/g, "/"),
    workspaceRoot.replace(/\\/g, "\\\\")
  ]);
  let redacted = text;
  for (const variant of variants) {
    if (variant) {
      redacted = redacted.split(variant).join(WORKSPACE_REPLACEMENT);
    }
  }
  return redacted;
}
