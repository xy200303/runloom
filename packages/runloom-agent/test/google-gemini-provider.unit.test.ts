import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleGeminiProvider } from "../src/index.js";
import type { ModelProviderEvent } from "../src/index.js";

describe("Google Gemini provider", () => {
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
            responseId: "gemini_response",
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      text: "Reading package metadata."
                    },
                    {
                      functionCall: {
                        name: "fs_read",
                        args: {
                          path: "package.json"
                        }
                      }
                    }
                  ]
                },
                finishReason: "STOP"
              }
            ],
            usageMetadata: {
              promptTokenCount: 15,
              candidatesTokenCount: 6,
              totalTokenCount: 21,
              cachedContentTokenCount: 3
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

    const provider = new GoogleGeminiProvider({
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.example.test/v1beta"
    });
    const events = await collectEvents(
      provider.createResponse(
        {
          model: "gemini-test",
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
              toolCallId: "gemini_call_previous",
              name: "fs.read",
              arguments: {
                path: "README.md"
              }
            },
            {
              type: "function_call_output",
              toolCallId: "gemini_call_previous",
              output: "{\"status\":\"completed\",\"output\":\"README contents\"}"
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
          responseFormat: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                summary: { type: "string" }
              },
              required: ["summary"]
            }
          },
          maxOutputTokens: 128,
          temperature: 0
        },
        {
          runId: "run_gemini_test",
          sessionId: "ses_gemini_test"
        }
      )
    );

    expect(captured?.url).toBe("https://generativelanguage.example.test/v1beta/models/gemini-test:generateContent");
    expect(captured?.headers["x-goog-api-key"]).toBe("test-key");
    expect(captured?.body).toEqual({
      contents: [
        {
          role: "user",
          parts: [{ text: "Read package.json" }]
        },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "fs_read",
                args: {
                  path: "README.md"
                }
              }
            }
          ]
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "fs_read",
                response: {
                  status: "completed",
                  output: "README contents"
                }
              }
            }
          ]
        }
      ],
      systemInstruction: {
        parts: [{ text: "Be concise." }]
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: "fs_read",
              description: "Read a file.",
              parameters: {
                type: "object",
                properties: {
                  path: { type: "string" }
                },
                required: ["path"],
                additionalProperties: false
              }
            }
          ]
        }
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: ["fs_read"]
        }
      },
      generationConfig: {
        maxOutputTokens: 128,
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            summary: { type: "string" }
          },
          required: ["summary"]
        }
      }
    });

    expect(events[0]).toEqual({ type: "response.created", responseId: "gemini_response" });
    expect(events).toContainEqual({ type: "response.output_text.delta", delta: "Reading package metadata." });
    expect(events).toContainEqual({
      type: "response.tool_call.completed",
      toolCallId: "gemini_call_1",
      name: "fs.read",
      arguments: {
        path: "package.json"
      },
      raw: {
        functionCall: {
          name: "fs_read",
          args: {
            path: "package.json"
          }
        }
      }
    });
    expect(events).toContainEqual({
      type: "response.usage",
      usage: {
        inputTokens: 15,
        outputTokens: 6,
        reasoningTokens: undefined,
        cachedInputTokens: 3,
        totalTokens: 21,
        raw: {
          promptTokenCount: 15,
          candidatesTokenCount: 6,
          totalTokenCount: 21,
          cachedContentTokenCount: 3
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
            error: {
              code: 429,
              message: "Quota exceeded.",
              status: "RESOURCE_EXHAUSTED"
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

    const provider = new GoogleGeminiProvider({
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.example.test/v1beta"
    });
    const events = await collectEvents(
      provider.createResponse(
        {
          model: "gemini-test",
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
          code: "resource_exhausted",
          message: "Quota exceeded.",
          provider: "google-gemini",
          retryable: true,
          statusCode: 429,
          rateLimited: true,
          authenticationFailed: false,
          contextWindowExceeded: false,
          raw: {
            error: {
              code: 429,
              message: "Quota exceeded.",
              status: "RESOURCE_EXHAUSTED"
            }
          }
        }
      }
    ]);
  });

  it("reports missing API keys without product mock output", async () => {
    const provider = new GoogleGeminiProvider({
      apiKey: ""
    });
    const events = await collectEvents(
      provider.createResponse(
        {
          model: "gemini-test",
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
          message: "GEMINI_API_KEY or GOOGLE_API_KEY is required for the Google Gemini provider.",
          provider: "google-gemini",
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
