import type { RunloomErrorCategory } from "./types.js";

export interface RunloomErrorOptions {
  code: string;
  category: RunloomErrorCategory;
  retryable?: boolean;
  statusCode?: number;
  details?: unknown;
  cause?: unknown;
}

export class RunloomError extends Error {
  readonly code: string;
  readonly category: RunloomErrorCategory;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly details?: unknown;

  constructor(message: string, options: RunloomErrorOptions) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      statusCode: this.statusCode,
      details: this.details
    };
  }
}

export class ProviderError extends RunloomError {
  constructor(message: string, options: Omit<RunloomErrorOptions, "category">) {
    super(message, { ...options, category: "provider" });
  }
}

export class ToolError extends RunloomError {
  constructor(message: string, options: Omit<RunloomErrorOptions, "category">) {
    super(message, { ...options, category: "tool" });
  }
}

export class ApprovalError extends RunloomError {
  constructor(message: string, options: Omit<RunloomErrorOptions, "category">) {
    super(message, { ...options, category: "approval" });
  }
}

export class StoreError extends RunloomError {
  constructor(message: string, options: Omit<RunloomErrorOptions, "category">) {
    super(message, { ...options, category: "store" });
  }
}

export class SecurityError extends RunloomError {
  constructor(message: string, options: Omit<RunloomErrorOptions, "category">) {
    super(message, { ...options, category: "security" });
  }
}

export class RuntimeError extends RunloomError {
  constructor(message: string, options: Omit<RunloomErrorOptions, "category">) {
    super(message, { ...options, category: "runtime" });
  }
}

export class EvolutionError extends RunloomError {
  constructor(message: string, options: Omit<RunloomErrorOptions, "category">) {
    super(message, { ...options, category: "evolution" });
  }
}
