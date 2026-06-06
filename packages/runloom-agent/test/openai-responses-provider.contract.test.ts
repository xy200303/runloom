import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses-provider.js";

describe("OpenAIResponsesProvider contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps Runloom tools to Responses function tools and emits function call events", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        requests.push({
          url,
          body: JSON.parse(String(options.body)) as Record<string, unknown>
        });
        return new Response(
          JSON.stringify({
            id: "resp_contract",
            output: [
              {
                type: "function_call",
                call_id: "call_read",
                name: "fs.read",
                arguments: "{\"path\":\"package.json\"}"
              }
            ],
            usage: {
              input_tokens: 4,
              output_tokens: 5,
              total_tokens: 9
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

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1"
    });

    const events = [];
    for await (const event of provider.createResponse(
      {
        model: "gpt-contract",
        input: [
          {
            type: "message",
            role: "system",
            content: [{ type: "text", text: "System instruction" }]
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
            description: "Read a file",
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
        metadata: {
          runtime: "runloom"
        }
      },
      {
        runId: "run_contract",
        sessionId: "ses_contract"
      }
    )) {
      events.push(event);
    }

    expect(requests[0]?.url).toBe("https://api.example.test/v1/responses");
    expect(requests[0]?.body).toMatchObject({
      model: "gpt-contract",
      instructions: "System instruction",
      metadata: {
        runtime: "runloom",
        run_id: "run_contract",
        session_id: "ses_contract"
      }
    });
    expect(requests[0]?.body.tools).toEqual([
      {
        type: "function",
        name: "fs.read",
        description: "Read a file",
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
    ]);

    expect(events).toContainEqual({
      type: "response.tool_call.completed",
      toolCallId: "call_read",
      name: "fs.read",
      arguments: { path: "package.json" },
      raw: {
        type: "function_call",
        call_id: "call_read",
        name: "fs.read",
        arguments: "{\"path\":\"package.json\"}"
      }
    });
    expect(events.at(-1)).toEqual({
      type: "response.completed",
      finishReason: "tool_calls"
    });
  });

  it("normalizes provider errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: "rate_limit_exceeded",
              message: "Too many requests"
            }
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      })
    );

    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1"
    });

    const events = [];
    for await (const event of provider.createResponse(
      {
        model: "gpt-contract",
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
      },
      {
        runId: "run_error",
        sessionId: "ses_error"
      }
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "response.failed",
        error: expect.objectContaining({
          code: "rate_limit_exceeded",
          message: "Too many requests",
          provider: "openai-responses",
          retryable: true,
          statusCode: 429,
          rateLimited: true
        })
      }
    ]);
  });
});
