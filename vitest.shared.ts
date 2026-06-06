import { cpus } from "node:os";
import { defineConfig, type UserConfig } from "vitest/config";

export type RunloomVitestSuite = "unit" | "integration" | "contract" | "security" | "e2e";

export interface RunloomVitestOptions {
  suite: RunloomVitestSuite;
  include: string[];
  testTimeout?: number;
  hookTimeout?: number;
  isolate?: boolean;
}

const SHARED_EXCLUDE = [
  "**/dist/**",
  "**/node_modules/**",
  "**/.turbo/**",
  "**/.tsbuildinfo/**",
  "**/*.d.ts"
];

export function defineRunloomVitestConfig(options: RunloomVitestOptions): UserConfig {
  const workerCount = Math.max(1, Math.min(4, cpus().length));

  return defineConfig({
    test: {
      name: options.suite,
      environment: "node",
      globals: false,
      include: options.include,
      exclude: SHARED_EXCLUDE,
      passWithNoTests: true,
      reporters: "default",
      clearMocks: true,
      restoreMocks: true,
      mockReset: true,
      isolate: options.isolate ?? true,
      maxWorkers: workerCount,
      testTimeout: options.testTimeout ?? 10_000,
      hookTimeout: options.hookTimeout ?? 10_000,
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        reportsDirectory: `coverage/${options.suite}`
      }
    }
  });
}
