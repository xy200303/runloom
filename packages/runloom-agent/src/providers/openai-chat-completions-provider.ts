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

export interface OpenAIChatCompletionsProviderOptions extends ProviderHttpPolicyOptions {
  apiKey?: string;
  baseUrl?: string;
}

export class OpenAIChatCompletionsProvider implements ModelProvider {
  id = "openai-chat-completions";
  protocol = "openai-chat-completions" as const;
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

  constructor(options: OpenAIChatCompletionsProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
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
          message: "OPENAI_API_KEY is required for the OpenAI-compatible Chat Completions provider.",
          provider: this.id,
          retryable: false,
          authenticationFailed: true
        }
      };
      return;
    }

    const payload = buildChatCompletionsPayload(request, context);
    const result = await fetchProviderJson({
      url: `${this.baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      },
      provider: this.id,
      signal: context.signal,
      normalizeError: normalizeChatError,
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
    yield { type: "response.created", responseId: typeof json.id === "string" ? json.id : undefined };

    const choice = firstChoice(json);
    const message = isRecord(choice?.message) ? choice.message : {};
    const content = extractTextContent(message.content);
    if (content) {
      yield {
        type: "response.output_text.delta",
        delta: content
      };
    }

    const toolCalls = extractChatToolCalls(message);
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
      finishReason: mapFinishReason(typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined, toolCalls.length > 0)
    };
  }
}

function buildChatCompletionsPayload(request: ModelRequest, context: ModelProviderContext): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: request.model,
    messages: request.input ? inputItemsToChatMessages(request.input) : messagesToChatMessages(request.messages ?? []),
    stream: false,
    metadata: {
      ...request.metadata,
      run_id: context.runId,
      session_id: context.sessionId
    }
  };

  if (request.tools?.length) {
    payload.tools = request.tools.map(toolToChatTool);
  }
  if (request.toolChoice) {
    payload.tool_choice = mapToolChoice(request.toolChoice);
  }
  if (typeof request.maxOutputTokens === "number") {
    payload.max_tokens = request.maxOutputTokens;
  }
  if (typeof request.temperature === "number") {
    payload.temperature = request.temperature;
  }
  if (request.responseFormat?.type === "json_schema") {
    payload.response_format = {
      type: "json_schema",
      json_schema: request.responseFormat.schema
    };
  } else if (request.responseFormat?.type === "text") {
    payload.response_format = {
      type: "text"
    };
  }

  return payload;
}

function inputItemsToChatMessages(items: RunloomModelInputItem[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];

  for (const item of items) {
    if (item.type === "message") {
      messages.push({
        role: item.role,
        content: contentToText(item.content)
      });
      continue;
    }

    if (item.type === "function_call") {
      messages.push(functionCallToAssistantMessage(item));
      continue;
    }

    messages.push({
      role: "tool",
      tool_call_id: item.toolCallId,
      content: item.output
    });
  }

  return messages;
}

function messagesToChatMessages(messages: RunloomModelMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    const base: Record<string, unknown> = {
      role: message.role,
      content: contentToText(message.content)
    };
    if (message.role === "tool" && message.toolCallId) {
      base.tool_call_id = message.toolCallId;
    }
    return base;
  });
}

function functionCallToAssistantMessage(item: Extract<RunloomModelInputItem, { type: "function_call" }>): Record<string, unknown> {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: item.toolCallId,
        type: "function",
        function: {
          name: item.name,
          arguments: stringifyArguments(item.arguments)
        }
      }
    ]
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

function toolToChatTool(tool: RunloomModelTool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false
    }
  };
}

function mapToolChoice(toolChoice: ModelRequest["toolChoice"]): unknown {
  if (toolChoice === "auto" || toolChoice === "none") {
    return toolChoice;
  }
  return {
    type: "function",
    function: {
      name: toolChoice?.name
    }
  };
}

function firstChoice(json: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const choice = choices[0];
  return isRecord(choice) ? choice : undefined;
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

function extractChatToolCalls(message: Record<string, unknown>): ModelProviderEvent[] {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const events: ModelProviderEvent[] = [];

  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
      continue;
    }
    const toolCallId = typeof toolCall.id === "string" ? toolCall.id : undefined;
    const name = typeof toolCall.function.name === "string" ? toolCall.function.name : undefined;
    if (!toolCallId || !name) {
      continue;
    }
    events.push({
      type: "response.tool_call.completed",
      toolCallId,
      name,
      arguments: parseArguments(toolCall.function.arguments),
      raw: toolCall
    });
  }

  return events;
}

function extractUsage(json: Record<string, unknown>): ModelUsage | undefined {
  if (!isRecord(json.usage)) {
    return undefined;
  }

  const usage = json.usage;
  const promptTokens = numberValue(usage.prompt_tokens);
  const completionTokens = numberValue(usage.completion_tokens);
  const totalTokens = numberValue(usage.total_tokens);

  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens,
    raw: usage
  };
}

function normalizeChatError(statusCode: number, json: Record<string, unknown>, provider: string): NormalizedProviderError {
  const error = isRecord(json.error) ? json.error : json;
  const message = typeof error.message === "string" ? error.message : `Provider request failed with status ${statusCode}.`;
  const code = typeof error.code === "string" ? error.code : `http_${statusCode}`;

  return {
    code,
    message,
    provider,
    retryable: statusCode === 429 || statusCode >= 500,
    statusCode,
    rateLimited: statusCode === 429,
    authenticationFailed: statusCode === 401 || statusCode === 403,
    raw: json
  };
}

function mapFinishReason(finishReason: string | undefined, hasToolCalls: boolean): ModelFinishReason {
  if (hasToolCalls || finishReason === "tool_calls" || finishReason === "function_call") {
    return "tool_calls";
  }
  if (finishReason === "stop") {
    return "stop";
  }
  if (finishReason === "length") {
    return "length";
  }
  if (finishReason === "content_filter") {
    return "content_filter";
  }
  return finishReason ? "unknown" : "stop";
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  if (!value.trim()) {
    return {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function stringifyArguments(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
