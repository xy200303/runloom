import { defineRunloomVitestConfig } from "./vitest.shared.js";

export default defineRunloomVitestConfig({
  suite: "security",
  include: [
    "packages/**/src/**/*.security.{test,spec}.{ts,tsx,mts,cts}",
    "packages/**/test/**/*.security.{test,spec}.{ts,tsx,mts,cts}"
  ],
  testTimeout: 30_000,
  hookTimeout: 30_000,
  isolate: true
});
