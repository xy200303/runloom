import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProviderJson } from "../src/providers/provider-http.js";
import type { NormalizedProviderError } from "../src/index.js";

describe("provider HTTP policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries retryable HTTP errors before returning successful JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
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
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "response_after_retry" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchProviderJson({
      url: "https://api.example.test/v1/responses",
      init: {
        method: "POST",
        body: "{}"
      },
      provider: "test-provider",
      normalizeError,
      maxRetries: 1,
      retryBaseDelayMs: 0
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: true,
      statusCode: 200,
      json: {
        id: "response_after_retry"
      }
    });
  });

  it("normalizes provider-owned timeouts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = options.signal as AbortSignal;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          })
      )
    );

    const result = await fetchProviderJson({
      url: "https://api.example.test/v1/responses",
      init: {
        method: "POST",
        body: "{}"
      },
      provider: "test-provider",
      normalizeError,
      timeoutMs: 1,
      maxRetries: 0
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "timeout",
        message: "Provider request timed out after 1ms.",
        provider: "test-provider",
        retryable: true,
        raw: {
          timeoutMs: 1,
          cause: {
            name: "Error",
            message: "Provider request timed out after 1ms."
          }
        }
      }
    });
  });

  it("normalizes network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    const result = await fetchProviderJson({
      url: "https://api.example.test/v1/responses",
      init: {
        method: "POST",
        body: "{}"
      },
      provider: "test-provider",
      normalizeError,
      maxRetries: 0
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "network_error",
        message: "fetch failed",
        provider: "test-provider",
        retryable: true,
        raw: {
          name: "TypeError",
          message: "fetch failed"
        }
      }
    });
  });
});

function normalizeError(statusCode: number, json: Record<string, unknown>, provider: string): NormalizedProviderError {
  const error = isRecord(json.error) ? json.error : json;
  return {
    code: typeof error.code === "string" ? error.code : `http_${statusCode}`,
    message: typeof error.message === "string" ? error.message : `Provider request failed with status ${statusCode}.`,
    provider,
    retryable: statusCode === 429 || statusCode >= 500,
    statusCode,
    rateLimited: statusCode === 429,
    raw: json
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
