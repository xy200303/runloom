import { defineRunloomVitestConfig } from "./vitest.shared.js";

export default defineRunloomVitestConfig({
  suite: "integration",
  include: [
    "packages/**/src/**/*.integration.{test,spec}.{ts,tsx,mts,cts}",
    "packages/**/test/**/*.integration.{test,spec}.{ts,tsx,mts,cts}"
  ],
  testTimeout: 30_000,
  hookTimeout: 30_000
});
