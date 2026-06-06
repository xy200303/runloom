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

export interface GoogleGeminiProviderOptions extends ProviderHttpPolicyOptions {
  apiKey?: string;
  baseUrl?: string;
}

interface GeminiPayloadBuildResult {
  payload: Record<string, unknown>;
  toolNameByGeminiName: Map<string, string>;
}

interface ToolNameMaps {
  toolNameByRunloomName: Map<string, string>;
  toolNameByGeminiName: Map<string, string>;
}

export class GoogleGeminiProvider implements ModelProvider {
  id = "google-gemini";
  protocol = "google-gemini" as const;
  capabilities = {
    streaming: false,
    tools: true,
    reasoning: false,
    structuredOutput: true,
    vision: false,
    files: false
  };

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly httpOptions: ProviderHttpPolicyOptions;

  constructor(options: GoogleGeminiProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(
      /\/$/,
      ""
    );
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
          message: "GEMINI_API_KEY or GOOGLE_API_KEY is required for the Google Gemini provider.",
          provider: this.id,
          retryable: false,
          authenticationFailed: true
        }
      };
      return;
    }

    const { payload, toolNameByGeminiName } = buildGeminiPayload(request);
    const result = await fetchProviderJson({
      url: `${this.baseUrl}/${geminiModelPath(request.model)}:generateContent`,
      init: {
        method: "POST",
        headers: {
          "x-goog-api-key": this.apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      },
      provider: this.id,
      signal: context.signal,
      normalizeError: normalizeGeminiError,
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
    yield { type: "response.created", responseId: stringValue(json.responseId) ?? stringValue(json.response_id) };

    const candidate = firstCandidate(json);
    for (const delta of extractTextDeltas(candidate)) {
      yield {
        type: "response.output_text.delta",
        delta
      };
    }

    const toolCalls = extractToolCalls(candidate, toolNameByGeminiName);
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
      finishReason: mapFinishReason(stringValue(candidate?.finishReason), toolCalls.length > 0)
    };
  }
}

function buildGeminiPayload(request: ModelRequest): GeminiPayloadBuildResult {
  const toolMaps = createToolNameMaps(request.tools ?? []);
  const input = request.input
    ? inputItemsToGeminiContents(request.input, toolMaps.toolNameByRunloomName)
    : messagesToGeminiContents(request.messages ?? []);
  const payload: Record<string, unknown> = {
    contents: input.contents
  };
  const generationConfig = buildGenerationConfig(request);

  if (input.system) {
    payload.systemInstruction = {
      parts: [{ text: input.system }]
    };
  }
  if (request.tools?.length) {
    payload.tools = [
      {
        functionDeclarations: request.tools.map((tool) => toolToGeminiDeclaration(tool, toolMaps.toolNameByRunloomName))
      }
    ];
  }
  if (request.toolChoice) {
    payload.toolConfig = mapToolChoice(request.toolChoice, toolMaps.toolNameByRunloomName);
  }
  if (Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }

  return {
    payload,
    toolNameByGeminiName: toolMaps.toolNameByGeminiName
  };
}

function inputItemsToGeminiContents(
  items: RunloomModelInputItem[],
  toolNameByRunloomName: Map<string, string>
): { contents: Record<string, unknown>[]; system?: string } {
  const contents: Record<string, unknown>[] = [];
  const system: string[] = [];
  const functionNameByCallId = new Map<string, string>();

  for (const item of items) {
    if (item.type === "message") {
      const content = contentToText(item.content);
      if (item.role === "system") {
        system.push(content);
      } else {
        contents.push({
          role: geminiRole(item.role),
          parts: textToGeminiParts(content)
        });
      }
      continue;
    }

    if (item.type === "function_call") {
      const geminiName = mappedToolName(item.name, toolNameByRunloomName);
      functionNameByCallId.set(item.toolCallId, geminiName);
      contents.push({
        role: "model",
        parts: [
          {
            functionCall: {
              name: geminiName,
              args: normalizeObjectPayload(item.arguments)
            }
          }
        ]
      });
      continue;
    }

    contents.push({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: functionNameByCallId.get(item.toolCallId) ?? safeGeminiToolName(item.toolCallId),
            response: normalizeFunctionResponse(item.output)
          }
        }
      ]
    });
  }

  return {
    contents,
    system: system.filter(Boolean).join("\n\n") || undefined
  };
}

function messagesToGeminiContents(messages: RunloomModelMessage[]): { contents: Record<string, unknown>[]; system?: string } {
  const contents: Record<string, unknown>[] = [];
  const system: string[] = [];

  for (const message of messages) {
    const content = contentToText(message.content);
    if (message.role === "system") {
      system.push(content);
      continue;
    }
    if (message.role === "tool" && message.toolCallId) {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.name ? safeGeminiToolName(message.name) : safeGeminiToolName(message.toolCallId),
              response: normalizeFunctionResponse(content)
            }
          }
        ]
      });
      continue;
    }

    contents.push({
      role: geminiRole(message.role),
      parts: textToGeminiParts(content)
    });
  }

  return {
    contents,
    system: system.filter(Boolean).join("\n\n") || undefined
  };
}

function buildGenerationConfig(request: ModelRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {};

  if (typeof request.maxOutputTokens === "number") {
    generationConfig.maxOutputTokens = request.maxOutputTokens;
  }
  if (typeof request.temperature === "number") {
    generationConfig.temperature = request.temperature;
  }
  if (request.responseFormat?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    if (request.responseFormat.schema) {
      generationConfig.responseSchema = request.responseFormat.schema;
    }
  } else if (request.responseFormat?.type === "text") {
    generationConfig.responseMimeType = "text/plain";
  }

  return generationConfig;
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

function textToGeminiParts(text: string): Array<Record<string, unknown>> {
  return [
    {
      text
    }
  ];
}

function geminiRole(role: "user" | "assistant" | "tool"): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

function toolToGeminiDeclaration(
  tool: RunloomModelTool,
  toolNameByRunloomName: Map<string, string>
): Record<string, unknown> {
  return {
    name: mappedToolName(tool.name, toolNameByRunloomName),
    description: tool.description,
    parameters: tool.inputSchema
  };
}

function mapToolChoice(toolChoice: ModelRequest["toolChoice"], toolNameByRunloomName: Map<string, string>): unknown {
  if (toolChoice === "none") {
    return {
      functionCallingConfig: {
        mode: "NONE"
      }
    };
  }
  if (toolChoice === "auto") {
    return {
      functionCallingConfig: {
        mode: "AUTO"
      }
    };
  }
  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [mappedToolName(toolChoice?.name ?? "", toolNameByRunloomName)]
    }
  };
}

function createToolNameMaps(tools: RunloomModelTool[]): ToolNameMaps {
  const toolNameByRunloomName = new Map<string, string>();
  const toolNameByGeminiName = new Map<string, string>();
  const used = new Set<string>();

  for (const tool of tools) {
    const geminiName = uniqueGeminiToolName(tool.name, used);
    used.add(geminiName);
    toolNameByRunloomName.set(tool.name, geminiName);
    toolNameByGeminiName.set(geminiName, tool.name);
  }

  return {
    toolNameByRunloomName,
    toolNameByGeminiName
  };
}

function mappedToolName(name: string, toolNameByRunloomName: Map<string, string>): string {
  return toolNameByRunloomName.get(name) ?? safeGeminiToolName(name);
}

function uniqueGeminiToolName(name: string, used: Set<string>): string {
  const base = safeGeminiToolName(name);
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

function safeGeminiToolName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
  const prefixed = /^[a-zA-Z_]/.test(normalized) ? normalized : `tool_${normalized}`;
  if (prefixed.length <= 64) {
    return prefixed;
  }

  const suffix = `_${shortHash(name)}`;
  return `${prefixed.slice(0, 64 - suffix.length)}${suffix}`;
}

function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function normalizeObjectPayload(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? parseArguments(value) : value;
  return isRecord(parsed) ? parsed : { value: parsed ?? null };
}

function normalizeFunctionResponse(output: string): Record<string, unknown> {
  const parsed = parseArguments(output);
  return isRecord(parsed) ? parsed : { output: parsed };
}

function extractTextDeltas(candidate: Record<string, unknown> | undefined): string[] {
  const deltas: string[] = [];

  for (const part of candidateParts(candidate)) {
    if (isRecord(part) && typeof part.text === "string" && part.text) {
      deltas.push(part.text);
    }
  }

  return deltas;
}

function extractToolCalls(
  candidate: Record<string, unknown> | undefined,
  toolNameByGeminiName: Map<string, string>
): ModelProviderEvent[] {
  const events: ModelProviderEvent[] = [];
  let callIndex = 0;

  for (const part of candidateParts(candidate)) {
    if (!isRecord(part) || !isRecord(part.functionCall)) {
      continue;
    }

    callIndex += 1;
    const functionCall = part.functionCall;
    const geminiName = stringValue(functionCall.name);
    if (!geminiName) {
      continue;
    }

    events.push({
      type: "response.tool_call.completed",
      toolCallId: stringValue(functionCall.id) ?? `gemini_call_${callIndex}`,
      name: toolNameByGeminiName.get(geminiName) ?? geminiName,
      arguments: normalizeObjectPayload(functionCall.args),
      raw: part
    });
  }

  return events;
}

function extractUsage(json: Record<string, unknown>): ModelUsage | undefined {
  if (!isRecord(json.usageMetadata)) {
    return undefined;
  }

  const usage = json.usageMetadata;
  const inputTokens = numberValue(usage.promptTokenCount);
  const outputTokens = numberValue(usage.candidatesTokenCount);
  const totalTokens = numberValue(usage.totalTokenCount) ?? sumIfPresent(inputTokens, outputTokens);

  return {
    inputTokens,
    outputTokens,
    reasoningTokens: numberValue(usage.thoughtsTokenCount),
    cachedInputTokens: numberValue(usage.cachedContentTokenCount),
    totalTokens,
    raw: usage
  };
}

function normalizeGeminiError(statusCode: number, json: Record<string, unknown>, provider: string): NormalizedProviderError {
  const error = isRecord(json.error) ? json.error : json;
  const status = stringValue(error.status);
  const code = status?.toLowerCase() ?? stringValue(error.code) ?? `http_${statusCode}`;
  const message = stringValue(error.message) ?? `Provider request failed with status ${statusCode}.`;

  return {
    code,
    message,
    provider,
    retryable: statusCode === 429 || statusCode >= 500,
    statusCode,
    rateLimited: statusCode === 429 || code === "resource_exhausted",
    authenticationFailed:
      statusCode === 401 || statusCode === 403 || code === "unauthenticated" || code === "permission_denied",
    contextWindowExceeded: statusCode === 413 || message.toLowerCase().includes("context window"),
    raw: json
  };
}

function mapFinishReason(finishReason: string | undefined, hasToolCalls: boolean): ModelFinishReason {
  if (hasToolCalls) {
    return "tool_calls";
  }
  if (!finishReason || finishReason === "STOP") {
    return "stop";
  }
  if (finishReason === "MAX_TOKENS") {
    return "length";
  }
  if (
    finishReason === "SAFETY" ||
    finishReason === "RECITATION" ||
    finishReason === "BLOCKLIST" ||
    finishReason === "PROHIBITED_CONTENT" ||
    finishReason === "SPII" ||
    finishReason === "IMAGE_SAFETY" ||
    finishReason === "IMAGE_PROHIBITED_CONTENT" ||
    finishReason === "IMAGE_RECITATION"
  ) {
    return "content_filter";
  }
  if (
    finishReason === "MALFORMED_FUNCTION_CALL" ||
    finishReason === "UNEXPECTED_TOOL_CALL" ||
    finishReason === "TOO_MANY_TOOL_CALLS" ||
    finishReason === "MALFORMED_RESPONSE"
  ) {
    return "error";
  }
  return "unknown";
}

function firstCandidate(json: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const candidate = candidates[0];
  return isRecord(candidate) ? candidate : undefined;
}

function candidateParts(candidate: Record<string, unknown> | undefined): unknown[] {
  const content = isRecord(candidate?.content) ? candidate.content : undefined;
  return Array.isArray(content?.parts) ? content.parts : [];
}

function geminiModelPath(model: string): string {
  const path = model.startsWith("models/") ? model : `models/${model}`;
  return path.split("/").map(encodeURIComponent).join("/");
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
