import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesProvider } from "../src/index.js";
import type { ModelProviderEvent } from "../src/index.js";

describe("Anthropic Messages provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps Runloom input items, tools, tool calls, and usage", async () => {
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        captured = {
          url: String(url),
          headers: options.headers as Record<string, string>,
          body: JSON.parse(String(options.body)) as Record<string, unknown>
        };

        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Reading package metadata."
              },
              {
                type: "tool_use",
                id: "toolu_read_package",
                name: "fs_read",
                input: {
                  path: "package.json"
                }
              }
            ],
            stop_reason: "tool_use",
            usage: {
              input_tokens: 12,
              output_tokens: 8,
              cache_read_input_tokens: 2
            }
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      })
    );

    const provider = new AnthropicMessagesProvider({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1"
    });
    const events = await collectEvents(
      provider.createResponse(
        {
          model: "claude-test",
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
            },
            {
              type: "function_call",
              toolCallId: "toolu_previous",
              name: "fs.read",
              arguments: {
                path: "README.md"
              }
            },
            {
              type: "function_call_output",
              toolCallId: "toolu_previous",
              output: "README contents"
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
          toolChoice: {
            name: "fs.read"
          },
          maxOutputTokens: 256,
          temperature: 0
        },
        {
          runId: "run_claude_test",
          sessionId: "ses_claude_test"
        }
      )
    );

    expect(captured?.url).toBe("https://api.example.test/v1/messages");
    expect(captured?.headers["x-api-key"]).toBe("test-key");
    expect(captured?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured?.body).toEqual({
      model: "claude-test",
      max_tokens: 256,
      stream: false,
      system: "Be concise.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Read package.json" }]
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_previous",
              name: "fs_read",
              input: {
                path: "README.md"
              }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_previous",
              content: "README contents"
            }
          ]
        }
      ],
      tools: [
        {
          name: "fs_read",
          description: "Read a file.",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string" }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      ],
      tool_choice: {
        type: "tool",
        name: "fs_read"
      },
      temperature: 0
    });

    expect(events[0]).toEqual({ type: "response.created", responseId: "msg_test" });
    expect(events).toContainEqual({ type: "response.output_text.delta", delta: "Reading package metadata." });
    expect(events).toContainEqual({
      type: "response.tool_call.completed",
      toolCallId: "toolu_read_package",
      name: "fs.read",
      arguments: {
        path: "package.json"
      },
      raw: {
        type: "tool_use",
        id: "toolu_read_package",
        name: "fs_read",
        input: {
          path: "package.json"
        }
      }
    });
    expect(events).toContainEqual({
      type: "response.usage",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cachedInputTokens: 2,
        totalTokens: 20,
        raw: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 2
        }
      }
    });
    expect(events.at(-1)).toEqual({ type: "response.completed", finishReason: "tool_calls" });
  });

  it("normalizes provider errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "Too many requests"
            }
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
    );

    const provider = new AnthropicMessagesProvider({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1"
    });
    const events = await collectEvents(
      provider.createResponse(
        {
          model: "claude-test",
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
          code: "rate_limit_error",
          message: "Too many requests",
          provider: "anthropic-messages",
          retryable: true,
          statusCode: 429,
          rateLimited: true,
          authenticationFailed: false,
          contextWindowExceeded: false,
          raw: {
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "Too many requests"
            }
          }
        }
      }
    ]);
  });

  it("reports missing API keys without product mock output", async () => {
    const provider = new AnthropicMessagesProvider({
      apiKey: ""
    });
    const events = await collectEvents(
      provider.createResponse(
        {
          model: "claude-test",
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
          message: "ANTHROPIC_API_KEY is required for the Anthropic Messages provider.",
          provider: "anthropic-messages",
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
