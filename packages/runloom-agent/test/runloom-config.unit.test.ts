import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRunloomConfig, selectModel } from "../src/config/runloom-config.js";

describe("runloom config model routing", () => {
  it("selects explicit model, profile, route, and default in priority order", () => {
    const config = {
      model: {
        default: "openai:gpt-default",
        profiles: {
          frontend_design: "kimi:kimi-design"
        },
        routes: [
          {
            when: { language: "go" },
            model: "go:go-code"
          }
        ]
      }
    };

    const baseInput = {
      text: "普通任务",
      workspace: process.cwd(),
      defaultProviderId: "openai-responses",
      providerAliases: {
        openai: "openai-responses"
      }
    };

    expect(selectModel(config, { ...baseInput, explicitModel: "custom:model" })).toMatchObject({
      providerId: "custom",
      model: "model",
      source: "explicit"
    });
    expect(selectModel(config, { ...baseInput, profile: "frontend_design" })).toMatchObject({
      providerId: "kimi",
      model: "kimi-design",
      source: "profile"
    });
    expect(selectModel(config, { ...baseInput, language: "go" })).toMatchObject({
      providerId: "go",
      model: "go-code",
      source: "route"
    });
    expect(selectModel(config, baseInput)).toMatchObject({
      providerId: "openai-responses",
      model: "gpt-default",
      source: "default"
    });
  });

  it("loads global config and lets workspace config override non-sensitive values", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "runloom-unit-state-"));
    const workspace = await mkdtemp(join(tmpdir(), "runloom-unit-workspace-"));

    try {
      await writeFile(
        join(stateDir, "config.json"),
        JSON.stringify({
          model: {
            default: "openai:gpt-global",
            profiles: {
              frontend_design: "kimi:kimi-global"
            }
          }
        })
      );
      await mkdir(join(workspace, ".runloom"));
      await writeFile(
        join(workspace, ".runloom", "config.json"),
        JSON.stringify({
          model: {
            default: "openai:gpt-workspace"
          }
        })
      );

      const config = loadRunloomConfig({ stateDir, workspace });

      expect(config.model?.default).toBe("openai:gpt-workspace");
      expect(config.model?.profiles?.frontend_design).toBe("kimi:kimi-global");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
