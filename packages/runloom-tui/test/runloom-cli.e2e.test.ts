import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("runloom CLI e2e", () => {
  it("starts, handles model commands, and exits without touching the real user state directory", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "runloom-e2e-state-"));

    try {
      const result = await runCli(
        [
          "/help",
          "/git",
          "/session",
          "/session list",
          "/todo",
          "/diff",
          "/review",
          "/review off",
          "/stop",
          "/resume run_missing",
          "/skills",
          "/mcp",
          "/model profile frontend_design",
          "/model",
          "/model clear",
          "/quit"
        ].join("\n") + "\n",
        stateDir
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Runloom Code");
      expect(result.stdout).toContain("Commands:");
      expect(result.stdout).toContain("[git]");
      expect(result.stdout).toContain("Session:");
      expect(result.stdout).toContain("Sessions:");
      expect(result.stdout).toContain("Todo: (none)");
      expect(result.stdout).toContain("Diff:");
      expect(result.stdout).toContain("Review mode enabled");
      expect(result.stdout).toContain("Review mode disabled");
      expect(result.stdout).toContain("Stop requested for");
      expect(result.stdout).toContain("Resume failed: Run not found");
      expect(result.stdout).toContain("Skills: (none registered)");
      expect(result.stdout).toContain("MCP servers: (none registered)");
      expect(result.stdout).toContain("Model profile set to frontend_design");
      expect(result.stdout).toContain("profile: frontend_design");
      expect(result.stdout).toContain("Model overrides cleared");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function runCli(input: string, stateDir: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const cliPath = resolve("packages/runloom-tui/dist/bin/runloom.js");
  const child = spawn(process.execPath, [cliPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      RUNLOOM_STATE_DIR: stateDir
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  const timeout = setTimeout(() => {
    child.kill();
  }, 10_000);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(input);

  return new Promise((resolvePromise, reject) => {
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolvePromise({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}
