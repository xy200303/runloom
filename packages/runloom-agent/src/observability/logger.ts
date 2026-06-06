import { RunloomError } from "../errors.js";
import { redactValue } from "../security/redaction.js";
import type { RunloomLogger, RunloomLogRecord } from "../types.js";

export type RunloomLogInput = Omit<RunloomLogRecord, "timestamp" | "source"> & {
  timestamp?: string;
  source?: RunloomLogRecord["source"];
};

export function emitLog(logger: RunloomLogger | undefined, input: RunloomLogInput, workspace?: string): void {
  if (!logger) {
    return;
  }

  const record = redactValue<RunloomLogRecord>(
    {
      timestamp: input.timestamp ?? new Date().toISOString(),
      ...input,
      source: input.source ?? "runtime"
    },
    { workspace }
  );

  try {
    logger.log(record);
  } catch {
    // Logging is observational only; logger failures must not affect agent execution.
  }
}

export function errorToLogDetails(error: unknown): unknown {
  if (error instanceof RunloomError) {
    return error.toJSON();
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }
  return {
    message: String(error)
  };
}
