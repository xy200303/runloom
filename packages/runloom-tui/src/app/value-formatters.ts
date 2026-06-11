export function formatUnknownValue(value: unknown): string {
  if (value === undefined) {
    return "(none)";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function indentBlock(value: string, spaces: number): string {
  const padding = " ".repeat(spaces);
  return value
    .split(/\r?\n/)
    .map((line) => `${padding}${line}`)
    .join("\n");
}
