import type { NormalizedProviderError } from "../types.js";

export interface ProviderHttpPolicyOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export interface FetchProviderJsonOptions extends ProviderHttpPolicyOptions {
  url: string;
  init: RequestInit;
  provider: string;
  signal?: AbortSignal;
  normalizeError(statusCode: number, json: Record<string, unknown>, provider: string): NormalizedProviderError;
}

export type FetchProviderJsonResult =
  | {
      ok: true;
      statusCode: number;
      json: Record<string, unknown>;
    }
  | {
      ok: false;
      error: NormalizedProviderError;
    };

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 30_000;

export async function fetchProviderJson(options: FetchProviderJsonOptions): Promise<FetchProviderJsonResult> {
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  let lastError: NormalizedProviderError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }

    const attemptSignal = createAttemptSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(options.url, {
        ...options.init,
        signal: attemptSignal.signal
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.ok) {
        return {
          ok: true,
          statusCode: response.status,
          json
        };
      }

      lastError = options.normalizeError(response.status, json, options.provider);
      if (shouldRetry(lastError, attempt, maxRetries, options.signal)) {
        await waitForRetry(retryDelayMs(response.headers, attempt, options.retryBaseDelayMs), options.signal);
        continue;
      }

      return {
        ok: false,
        error: lastError
      };
    } catch (error) {
      if (options.signal?.aborted) {
        throw abortReason(options.signal, error);
      }

      lastError = attemptSignal.timedOut
        ? normalizeTimeoutError(options.provider, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, error)
        : normalizeNetworkError(options.provider, error);
      if (shouldRetry(lastError, attempt, maxRetries, options.signal)) {
        await waitForRetry(retryDelayMs(undefined, attempt, options.retryBaseDelayMs), options.signal);
        continue;
      }

      return {
        ok: false,
        error: lastError
      };
    } finally {
      attemptSignal.cleanup();
    }
  }

  return {
    ok: false,
    error: lastError ?? normalizeNetworkError(options.provider, new Error("Provider request failed."))
  };
}

function createAttemptSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; timedOut: boolean; cleanup(): void } {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal) {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Provider request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup() {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

function shouldRetry(
  error: NormalizedProviderError,
  attempt: number,
  maxRetries: number,
  signal: AbortSignal | undefined
): boolean {
  return error.retryable && attempt < maxRetries && !signal?.aborted;
}

function retryDelayMs(headers: Headers | undefined, attempt: number, baseDelayMs: number | undefined): number {
  const retryAfter = parseRetryAfter(headers?.get("retry-after"));
  if (retryAfter !== undefined) {
    return retryAfter;
  }

  const base = Math.max(0, baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
  return Math.min(base * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }

  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.min(Math.max(0, timestamp - Date.now()), MAX_RETRY_DELAY_MS);
  }

  return undefined;
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeoutId);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function normalizeNetworkError(provider: string, error: unknown): NormalizedProviderError {
  return {
    code: "network_error",
    message: error instanceof Error ? error.message : "Provider network request failed.",
    provider,
    retryable: true,
    raw: errorToDetails(error)
  };
}

function normalizeTimeoutError(provider: string, timeoutMs: number, error: unknown): NormalizedProviderError {
  return {
    code: "timeout",
    message: `Provider request timed out after ${timeoutMs}ms.`,
    provider,
    retryable: true,
    raw: {
      timeoutMs,
      cause: errorToDetails(error)
    }
  };
}

function abortReason(signal: AbortSignal | undefined, fallback?: unknown): unknown {
  return signal?.reason ?? fallback ?? new Error("Provider request aborted.");
}

function errorToDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }
  return error;
}
