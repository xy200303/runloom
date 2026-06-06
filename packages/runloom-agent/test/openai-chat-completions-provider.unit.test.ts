import { describe, expect, it } from "vitest";
import { OpenAIChatCompletionsProvider } from "../src/index.js";
import type { ModelProviderEvent } from "../src/index.js";

describe("OpenAI-compatible Chat Completions provider", () => {
  it("maps Runloom messages, tools, tool calls, and usage", async () => {
    const originalFetch = globalThis.fetch;
    let captured: { url: string; body: Record<string, unknown> } | undefined;

    globalThis.fetch = async (url, options) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(options?.body)) as Record<string, unknown>
      };

      return new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          choices: [
            {
              message: {
                role: "assistant",
                content: "Reading package metadata.",
                tool_calls: [
                  {
                    id: "call_read_package",
                    type: "function",
                    function: {
                      name: "fs.read",
                      arguments: "{\"path\":\"package.json\"}"
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    };

    try {
      const provider = new OpenAIChatCompletionsProvider({
        apiKey: "test-key",
        baseUrl: "https://api.example.test/v1"
      });
      const events = await collectEvents(
        provider.createResponse(
          {
            model: "gpt-4.1",
            input: [
              {
                type: "message",
                role: "system",
                content: [{ type: "text", text: "Be concise." }]
              },
              {
                type: "message",
                role: "user",
                content: [{ type: "text", text: "Read package.json" }]
              }
            ],
            tools: [
              {
                name: "fs.read",
                description: "Read a file.",
                inputSchema: {
                  type: "object",
                  properties: {
                    path: { type: "string" }
                  },
                  required: ["path"],
                  additionalProperties: false
                }
              }
            ],
            toolChoice: "auto",
            maxOutputTokens: 100,
            temperature: 0
          },
          {
            runId: "run_chat_test",
            sessionId: "ses_chat_test"
          }
        )
      );

      expect(captured?.url).toBe("https://api.example.test/v1/chat/completions");
      expect(captured?.body.model).toBe("gpt-4.1");
      expect(captured?.body.messages).toEqual([
        { role: "system", content: "Be concise." },
        { role: "user", content: "Read package.json" }
      ]);
      expect(captured?.body.tools).toEqual([
        {
          type: "function",
          function: {
            name: "fs.read",
            description: "Read a file.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" }
              },
              required: ["path"],
              additionalProperties: false
            },
            strict: false
          }
        }
      ]);
      expect(captured?.body.tool_choice).toBe("auto");
      expect(captured?.body.max_tokens).toBe(100);
      expect(captured?.body.temperature).toBe(0);

      expect(events[0]).toEqual({ type: "response.created", responseId: "chatcmpl_test" });
      expect(events).toContainEqual({ type: "response.output_text.delta", delta: "Reading package metadata." });
      expect(events).toContainEqual({
        type: "response.tool_call.completed",
        toolCallId: "call_read_package",
        name: "fs.read",
        arguments: { path: "package.json" },
        raw: {
          id: "call_read_package",
          type: "function",
          function: {
            name: "fs.read",
            arguments: "{\"path\":\"package.json\"}"
          }
        }
      });
      expect(events).toContainEqual({
        type: "response.usage",
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          raw: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18
          }
        }
      });
      expect(events.at(-1)).toEqual({ type: "response.completed", finishReason: "tool_calls" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes provider errors", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "rate_limit_exceeded",
            message: "Slow down."
          }
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );

    try {
      const provider = new OpenAIChatCompletionsProvider({
        apiKey: "test-key",
        baseUrl: "https://api.example.test/v1"
      });
      const events = await collectEvents(
        provider.createResponse(
          {
            model: "gpt-4.1",
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "Hello" }]
              }
            ]
          },
          {
            runId: "run_error",
            sessionId: "ses_error"
          }
        )
      );

      expect(events).toEqual([
        {
          type: "response.failed",
          error: {
            code: "rate_limit_exceeded",
            message: "Slow down.",
            provider: "openai-chat-completions",
            retryable: true,
            statusCode: 429,
            rateLimited: true,
            authenticationFailed: false,
            raw: {
              error: {
                code: "rate_limit_exceeded",
                message: "Slow down."
              }
            }
          }
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports missing API keys without product mock output", async () => {
    const provider = new OpenAIChatCompletionsProvider({
      apiKey: ""
    });
    const events = await collectEvents(
      provider.createResponse(
        {
          model: "gpt-4.1",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Hello" }]
            }
          ]
        },
        {
          runId: "run_missing_key",
          sessionId: "ses_missing_key"
        }
      )
    );

    expect(events).toEqual([
      {
        type: "response.failed",
        error: {
          code: "missing_api_key",
          message: "OPENAI_API_KEY is required for the OpenAI-compatible Chat Completions provider.",
          provider: "openai-chat-completions",
          retryable: false,
          authenticationFailed: true
        }
      }
    ]);
  });
});

async function collectEvents(events: AsyncIterable<ModelProviderEvent>): Promise<ModelProviderEvent[]> {
  const collected: ModelProviderEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
