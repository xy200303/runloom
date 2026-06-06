import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpServerConfigs } from "../src/mcp/mcp-config.js";

describe("mcp config", () => {
  it("loads MCP server config from stateDir", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "runloom-mcp-config-"));

    try {
      await mkdir(join(stateDir, "mcp"), { recursive: true });
      await writeFile(
        join(stateDir, "mcp", "servers.json"),
        JSON.stringify({
          servers: {
            workspace: {
              transport: "custom",
              enabled: true,
              permissions: {
                tools: "ask",
                resources: "allow",
                prompts: "allow",
                allowedToolNames: ["echo"]
              }
            }
          }
        }),
        "utf8"
      );

      const configs = loadMcpServerConfigs({ stateDir });

      expect(configs).toEqual([
        {
          name: "workspace",
          enabled: true,
          transport: "custom",
          command: undefined,
          args: undefined,
          url: undefined,
          permissions: {
            tools: "ask",
            resources: "allow",
            prompts: "allow",
            allowedToolNames: ["echo"],
            deniedToolNames: undefined
          }
        }
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid MCP stdio servers without a command", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "runloom-bad-mcp-config-"));

    try {
      await mkdir(join(stateDir, "mcp"), { recursive: true });
      await writeFile(
        join(stateDir, "mcp", "servers.json"),
        JSON.stringify({
          servers: {
            filesystem: {
              transport: "stdio",
              enabled: true
            }
          }
        }),
        "utf8"
      );

      expect(() => loadMcpServerConfigs({ stateDir })).toThrow(/requires command/);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
