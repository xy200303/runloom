import { defineRunloomVitestConfig } from "./vitest.shared.js";

export default defineRunloomVitestConfig({
  suite: "e2e",
  include: [
    "packages/**/src/**/*.e2e.{test,spec}.{ts,tsx,mts,cts}",
    "packages/**/test/**/*.e2e.{test,spec}.{ts,tsx,mts,cts}"
  ],
  testTimeout: 120_000,
  hookTimeout: 120_000,
  isolate: true
});
