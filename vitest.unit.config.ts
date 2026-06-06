import { defineRunloomVitestConfig } from "./vitest.shared.js";

export default defineRunloomVitestConfig({
  suite: "unit",
  include: [
    "packages/**/src/**/*.unit.{test,spec}.{ts,tsx,mts,cts}",
    "packages/**/test/**/*.unit.{test,spec}.{ts,tsx,mts,cts}"
  ]
});
