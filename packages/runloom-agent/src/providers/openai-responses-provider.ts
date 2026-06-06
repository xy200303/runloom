import type {
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

export interface OpenAIResponsesProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

export class OpenAIResponsesProvider implements ModelProvider {
  id = "openai-responses";
  protocol = "openai-responses" as const;
  capabilities = {
    streaming: false,
    tools: true,
    reasoning: true,
    structuredOutput: true,
    vision: true,
    files: true
  };

  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(options: OpenAIResponsesProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  }

  async *createResponse(request: ModelRequest, context: ModelProviderContext): AsyncIterable<ModelProviderEvent> {
    if (!this.apiKey) {
      yield {
        type: "response.failed",
        error: {
          code: "missing_api_key",
          message: "OPENAI_API_KEY is required for the OpenAI Responses provider.",
          provider: this.id,
          retryable: false,
          authenticationFailed: true
        }
      };
      return;
    }

    const payload = buildResponsesPayload(request, context);
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: context.signal
    });

    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      yield {
        type: "response.failed",
        error: normalizeResponseError(response.status, json, this.id)
      };
      return;
    }

    const responseId = typeof json.id === "string" ? json.id : undefined;
    yield { type: "response.created", responseId };

    const outputText = extractOutputText(json);
    if (outputText) {
      yield {
        type: "response.output_text.delta",
        delta: outputText
      };
    }

    const toolCalls = extractToolCalls(json);
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
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop"
    };
  }
}

function buildResponsesPayload(request: ModelRequest, context: ModelProviderContext): Record<string, unknown> {
  const { input, instructions } = buildResponsesInput(request);
  const payload: Record<string, unknown> = {
    model: request.model,
    input,
    stream: false,
    metadata: {
      ...request.metadata,
      run_id: context.runId,
      session_id: context.sessionId
    }
  };

  if (instructions) {
    payload.instructions = instructions;
  }
  if (request.tools?.length) {
    payload.tools = request.tools.map(toolToResponsesTool);
  }
  if (request.toolChoice) {
    payload.tool_choice = mapToolChoice(request.toolChoice);
  }
  if (typeof request.maxOutputTokens === "number") {
    payload.max_output_tokens = request.maxOutputTokens;
  }
  if (typeof request.temperature === "number") {
    payload.temperature = request.temperature;
  }

  return payload;
}

function buildResponsesInput(request: ModelRequest): { input: unknown; instructions?: string } {
  if (request.input) {
    return inputItemsToResponsesInput(request.input);
  }
  return messagesToResponsesInput(request.messages ?? []);
}

function inputItemsToResponsesInput(items: RunloomModelInputItem[]): { input: unknown; instructions?: string } {
  const input: unknown[] = [];
  const instructions: string[] = [];

  for (const item of items) {
    if (item.type === "message") {
      const text = contentToText(item.content);
      if (item.role === "system") {
        instructions.push(text);
      } else {
        input.push({ role: item.role, content: text });
      }
      continue;
    }

    if (item.type === "function_call") {
      input.push(functionCallToResponsesInput(item));
      continue;
    }

    input.push({
      type: "function_call_output",
      call_id: item.toolCallId,
      output: item.output
    });
  }

  return {
    input: input.length > 0 ? input : "",
    instructions: instructions.filter(Boolean).join("\n\n") || undefined
  };
}

function messagesToResponsesInput(messages: RunloomModelMessage[]): { input: unknown; instructions?: string } {
  const input: unknown[] = [];
  const instructions: string[] = [];

  for (const message of messages) {
    const text = contentToText(message.content);
    if (message.role === "system") {
      instructions.push(text);
      continue;
    }
    if (message.role === "tool" && message.toolCallId) {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: text
      });
      continue;
    }
    input.push({ role: message.role, content: text });
  }

  return {
    input: input.length > 0 ? input : "",
    instructions: instructions.filter(Boolean).join("\n\n") || undefined
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

function toolToResponsesTool(tool: RunloomModelTool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false
  };
}

function mapToolChoice(toolChoice: ModelRequest["toolChoice"]): unknown {
  if (toolChoice === "auto" || toolChoice === "none") {
    return toolChoice;
  }
  return {
    type: "function",
    name: toolChoice?.name
  };
}

function functionCallToResponsesInput(item: Extract<RunloomModelInputItem, { type: "function_call" }>): unknown {
  if (isRecord(item.raw)) {
    return item.raw;
  }
  return {
    type: "function_call",
    call_id: item.toolCallId,
    name: item.name,
    arguments: stringifyArguments(item.arguments)
  };
}

function extractOutputText(json: Record<string, unknown>): string {
  if (typeof json.output_text === "string") {
    return json.output_text;
  }

  const output = Array.isArray(json.output) ? json.output : [];
  const chunks: string[] = [];

  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (isRecord(part) && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("");
}

function extractToolCalls(json: Record<string, unknown>): ModelProviderEvent[] {
  const output = Array.isArray(json.output) ? json.output : [];
  const calls: ModelProviderEvent[] = [];

  for (const item of output) {
    if (!isRecord(item) || item.type !== "function_call") {
      continue;
    }

    const callId = stringValue(item.call_id) ?? stringValue(item.id);
    const name = stringValue(item.name);
    if (!callId || !name) {
      continue;
    }

    calls.push({
      type: "response.tool_call.completed",
      toolCallId: callId,
      name,
      arguments: parseArguments(item.arguments),
      raw: item
    });
  }

  return calls;
}

function extractUsage(json: Record<string, unknown>): ModelUsage | undefined {
  if (!isRecord(json.usage)) {
    return undefined;
  }

  const usage = json.usage;
  const inputTokens = numberValue(usage.input_tokens);
  const outputTokens = numberValue(usage.output_tokens);
  const totalTokens = numberValue(usage.total_tokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    raw: usage
  };
}

function normalizeResponseError(statusCode: number, json: Record<string, unknown>, provider: string): NormalizedProviderError {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
