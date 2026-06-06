import type {
  ModelFinishReason,
  ModelProvider,
  ModelProviderContext,
  ModelProviderEvent,
  ModelRequest,
  ModelUsage,
  NormalizedProviderError,
  RunloomContentPart,
  RunloomModelInputItem,
  RunloomModelMessage,
  RunloomModelTool
} from "../types.js";
import { fetchProviderJson } from "./provider-http.js";
import type { ProviderHttpPolicyOptions } from "./provider-http.js";

export interface AnthropicMessagesProviderOptions extends ProviderHttpPolicyOptions {
  apiKey?: string;
  baseUrl?: string;
  version?: string;
  defaultMaxOutputTokens?: number;
  emitThinking?: boolean;
}

interface AnthropicPayloadBuildResult {
  payload: Record<string, unknown>;
  toolNameByAnthropicName: Map<string, string>;
}

interface ToolNameMaps {
  toolNameByRunloomName: Map<string, string>;
  toolNameByAnthropicName: Map<string, string>;
}

export class AnthropicMessagesProvider implements ModelProvider {
  id = "anthropic-messages";
  protocol = "anthropic-messages" as const;
  capabilities = {
    streaming: false,
    tools: true,
    reasoning: true,
    structuredOutput: false,
    vision: false,
    files: false
  };

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly defaultMaxOutputTokens: number;
  private readonly emitThinking: boolean;
  private readonly httpOptions: ProviderHttpPolicyOptions;

  constructor(options: AnthropicMessagesProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.version = options.version ?? "2023-06-01";
    this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 4096;
    this.emitThinking = options.emitThinking ?? false;
    this.httpOptions = {
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      retryBaseDelayMs: options.retryBaseDelayMs
    };
  }

  async *createResponse(request: ModelRequest, context: ModelProviderContext): AsyncIterable<ModelProviderEvent> {
    if (!this.apiKey) {
      yield {
        type: "response.failed",
        error: {
          code: "missing_api_key",
          message: "ANTHROPIC_API_KEY is required for the Anthropic Messages provider.",
          provider: this.id,
          retryable: false,
          authenticationFailed: true
        }
      };
      return;
    }

    const { payload, toolNameByAnthropicName } = buildAnthropicMessagesPayload(request, this.defaultMaxOutputTokens);
    const result = await fetchProviderJson({
      url: `${this.baseUrl}/messages`,
      init: {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": this.version,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      },
      provider: this.id,
      signal: context.signal,
      normalizeError: normalizeAnthropicError,
      ...this.httpOptions
    });

    if (!result.ok) {
      yield {
        type: "response.failed",
        error: result.error
      };
      return;
    }

    const json = result.json;
    yield { type: "response.created", responseId: stringValue(json.id) };

    for (const delta of extractTextDeltas(json)) {
      yield {
        type: "response.output_text.delta",
        delta
      };
    }

    if (this.emitThinking) {
      for (const delta of extractThinkingDeltas(json)) {
        yield {
          type: "response.reasoning.delta",
          delta
        };
      }
    }

    const toolCalls = extractToolCalls(json, toolNameByAnthropicName);
    for (const toolCall of toolCalls) {
      yield toolCall;
    }

    const usage = extractUsage(json);
    if (usage) {
      yield {
        type: "response.usage",
        usage
      };
    }

    yield {
      type: "response.completed",
      finishReason: mapFinishReason(stringValue(json.stop_reason), toolCalls.length > 0)
    };
  }
}

function buildAnthropicMessagesPayload(request: ModelRequest, defaultMaxOutputTokens: number): AnthropicPayloadBuildResult {
  const toolMaps = createToolNameMaps(request.tools ?? []);
  const input = request.input
    ? inputItemsToAnthropicMessages(request.input, toolMaps.toolNameByRunloomName)
    : messagesToAnthropicMessages(request.messages ?? []);
  const payload: Record<string, unknown> = {
    model: request.model,
    messages: input.messages,
    max_tokens: request.maxOutputTokens ?? defaultMaxOutputTokens,
    stream: false
  };

  if (input.system) {
    payload.system = input.system;
  }
  if (request.tools?.length) {
    payload.tools = request.tools.map((tool) => toolToAnthropicTool(tool, toolMaps.toolNameByRunloomName));
  }
  if (request.toolChoice) {
    payload.tool_choice = mapToolChoice(request.toolChoice, toolMaps.toolNameByRunloomName);
  }
  if (typeof request.temperature === "number") {
    payload.temperature = request.temperature;
  }

  return {
    payload,
    toolNameByAnthropicName: toolMaps.toolNameByAnthropicName
  };
}

function inputItemsToAnthropicMessages(
  items: RunloomModelInputItem[],
  toolNameByRunloomName: Map<string, string>
): { messages: Record<string, unknown>[]; system?: string } {
  const messages: Record<string, unknown>[] = [];
  const system: string[] = [];

  for (const item of items) {
    if (item.type === "message") {
      const content = contentToText(item.content);
      if (item.role === "system") {
        system.push(content);
      } else {
        messages.push({
          role: item.role,
          content: textToAnthropicBlocks(content)
        });
      }
      continue;
    }

    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: item.toolCallId,
            name: mappedToolName(item.name, toolNameByRunloomName),
            input: normalizeToolInput(item.arguments)
          }
        ]
      });
      continue;
    }

    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: item.toolCallId,
          content: item.output
        }
      ]
    });
  }

  return {
    messages,
    system: system.filter(Boolean).join("\n\n") || undefined
  };
}

function messagesToAnthropicMessages(messages: RunloomModelMessage[]): { messages: Record<string, unknown>[]; system?: string } {
  const converted: Record<string, unknown>[] = [];
  const system: string[] = [];

  for (const message of messages) {
    const content = contentToText(message.content);
    if (message.role === "system") {
      system.push(content);
      continue;
    }
    if (message.role === "tool" && message.toolCallId) {
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content
          }
        ]
      });
      continue;
    }

    converted.push({
      role: message.role,
      content: textToAnthropicBlocks(content)
    });
  }

  return {
    messages: converted,
    system: system.filter(Boolean).join("\n\n") || undefined
  };
}

function contentToText(content: RunloomContentPart[]): string {
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text ?? "";
      }
      return `[redacted: ${part.reason ?? "unknown"}]`;
    })
    .join("");
}

function textToAnthropicBlocks(text: string): Array<Record<string, unknown>> {
  return [
    {
      type: "text",
      text
    }
  ];
}

function toolToAnthropicTool(
  tool: RunloomModelTool,
  toolNameByRunloomName: Map<string, string>
): Record<string, unknown> {
  return {
    name: mappedToolName(tool.name, toolNameByRunloomName),
    description: tool.description,
    input_schema: tool.inputSchema
  };
}

function mapToolChoice(toolChoice: ModelRequest["toolChoice"], toolNameByRunloomName: Map<string, string>): unknown {
  if (toolChoice === "auto" || toolChoice === "none") {
    return {
      type: toolChoice
    };
  }
  return {
    type: "tool",
    name: mappedToolName(toolChoice?.name ?? "", toolNameByRunloomName)
  };
}

function createToolNameMaps(tools: RunloomModelTool[]): ToolNameMaps {
  const toolNameByRunloomName = new Map<string, string>();
  const toolNameByAnthropicName = new Map<string, string>();
  const used = new Set<string>();

  for (const tool of tools) {
    const anthropicName = uniqueAnthropicToolName(tool.name, used);
    used.add(anthropicName);
    toolNameByRunloomName.set(tool.name, anthropicName);
    toolNameByAnthropicName.set(anthropicName, tool.name);
  }

  return {
    toolNameByRunloomName,
    toolNameByAnthropicName
  };
}

function mappedToolName(name: string, toolNameByRunloomName: Map<string, string>): string {
  return toolNameByRunloomName.get(name) ?? safeAnthropicToolName(name);
}

function uniqueAnthropicToolName(name: string, used: Set<string>): string {
  const base = safeAnthropicToolName(name);
  if (!used.has(base)) {
    return base;
  }

  const hash = shortHash(name);
  let index = 1;
  while (true) {
    const suffix = `_${hash}_${index}`;
    const candidate = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function safeAnthropicToolName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
  if (normalized.length <= 64) {
    return normalized;
  }

  const suffix = `_${shortHash(name)}`;
  return `${normalized.slice(0, 64 - suffix.length)}${suffix}`;
}

function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function normalizeToolInput(value: unknown): unknown {
  if (typeof value === "string") {
    return parseArguments(value);
  }
  return value ?? {};
}

function extractTextDeltas(json: Record<string, unknown>): string[] {
  const content = Array.isArray(json.content) ? json.content : [];
  const deltas: string[] = [];

  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text) {
      deltas.push(block.text);
    }
  }

  return deltas;
}

function extractThinkingDeltas(json: Record<string, unknown>): string[] {
  const content = Array.isArray(json.content) ? json.content : [];
  const deltas: string[] = [];

  for (const block of content) {
    if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      deltas.push(block.thinking);
    }
  }

  return deltas;
}

function extractToolCalls(
  json: Record<string, unknown>,
  toolNameByAnthropicName: Map<string, string>
): ModelProviderEvent[] {
  const content = Array.isArray(json.content) ? json.content : [];
  const events: ModelProviderEvent[] = [];

  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") {
      continue;
    }

    const toolCallId = stringValue(block.id);
    const anthropicName = stringValue(block.name);
    if (!toolCallId || !anthropicName) {
      continue;
    }

    events.push({
      type: "response.tool_call.completed",
      toolCallId,
      name: toolNameByAnthropicName.get(anthropicName) ?? anthropicName,
      arguments: normalizeToolInput(block.input),
      raw: block
    });
  }

  return events;
}

function extractUsage(json: Record<string, unknown>): ModelUsage | undefined {
  if (!isRecord(json.usage)) {
    return undefined;
  }

  const usage = json.usage;
  const inputTokens = numberValue(usage.input_tokens);
  const outputTokens = numberValue(usage.output_tokens);
  const cacheReadTokens = numberValue(usage.cache_read_input_tokens);
  const cacheCreationTokens = numberValue(usage.cache_creation_input_tokens);
  const cachedInputTokens =
    cacheReadTokens === undefined && cacheCreationTokens === undefined
      ? undefined
      : (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0);

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens: sumIfPresent(inputTokens, outputTokens),
    raw: usage
  };
}

function normalizeAnthropicError(statusCode: number, json: Record<string, unknown>, provider: string): NormalizedProviderError {
  const error = isRecord(json.error) ? json.error : json;
  const code = stringValue(error.type) ?? stringValue(error.code) ?? `http_${statusCode}`;
  const message = stringValue(error.message) ?? `Provider request failed with status ${statusCode}.`;

  return {
    code,
    message,
    provider,
    retryable: statusCode === 429 || statusCode >= 500,
    statusCode,
    rateLimited: statusCode === 429 || code === "rate_limit_error",
    authenticationFailed: statusCode === 401 || statusCode === 403 || code === "authentication_error",
    contextWindowExceeded:
      statusCode === 413 || code === "request_too_large" || code === "context_window_exceeded" || code.includes("context"),
    raw: json
  };
}

function mapFinishReason(stopReason: string | undefined, hasToolCalls: boolean): ModelFinishReason {
  if (hasToolCalls || stopReason === "tool_use") {
    return "tool_calls";
  }
  if (stopReason === "end_turn" || stopReason === "stop_sequence") {
    return "stop";
  }
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
    return "length";
  }
  if (stopReason === "refusal" || stopReason === "content_filter") {
    return "content_filter";
  }
  return stopReason ? "unknown" : "stop";
}

function parseArguments(value: string): unknown {
  if (!value.trim()) {
    return {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function sumIfPresent(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined || second === undefined) {
    return undefined;
  }
  return first + second;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
