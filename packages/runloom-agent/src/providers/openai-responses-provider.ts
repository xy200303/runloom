import type {
  ModelProvider,
  ModelProviderContext,
  ModelProviderEvent,
  ModelRequest,
  ModelUsage,
  NormalizedProviderError,
  RunloomModelMessage
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

    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: request.model,
        input: messagesToInput(request.messages),
        stream: false,
        metadata: {
          ...request.metadata,
          run_id: context.runId,
          session_id: context.sessionId
        }
      }),
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

    const usage = extractUsage(json);
    if (usage) {
      yield {
        type: "response.usage",
        usage
      };
    }

    yield {
      type: "response.completed",
      finishReason: "stop"
    };
  }
}

function messagesToInput(messages: RunloomModelMessage[]): string {
  return messages
    .map((message) => {
      const content = message.content
        .map((part) => {
          if (part.type === "text") {
            return part.text ?? "";
          }
          return `[redacted: ${part.reason ?? "unknown"}]`;
        })
        .join("");
      return `${message.role.toUpperCase()}:\n${content}`;
    })
    .join("\n\n");
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
