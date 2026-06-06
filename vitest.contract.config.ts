import { defineRunloomVitestConfig } from "./vitest.shared.js";

export default defineRunloomVitestConfig({
  suite: "contract",
  include: [
    "packages/**/src/**/*.contract.{test,spec}.{ts,tsx,mts,cts}",
    "packages/**/test/**/*.contract.{test,spec}.{ts,tsx,mts,cts}"
  ],
  testTimeout: 20_000,
  hookTimeout: 20_000
});
