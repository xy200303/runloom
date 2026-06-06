import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "../src/skills/skill-manifest.js";

describe("skill manifests", () => {
  it("loads installed and generated skill manifests from stateDir", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "runloom-skills-"));

    try {
      await writeSkill(stateDir, "installed", "typescript-code-review", {
        name: "typescript-code-review",
        version: "0.1.0",
        description: "Review TypeScript changes.",
        triggers: ["review TypeScript"],
        requiredTools: ["fs.read", "git.diff"],
        permissions: {
          readWorkspace: true,
          writeWorkspace: false,
          shell: "ask"
        },
        validation: {
          schema: "skill-manifest@1",
          tests: ["tests/*.case.md"]
        }
      });
      await writeSkill(stateDir, "generated", "draft-skill", {
        name: "draft-skill",
        version: "0.0.1",
        description: "A generated draft skill.",
        triggers: ["draft task"],
        validation: {
          schema: "skill-manifest@1"
        }
      });

      const result = loadSkills({ stateDir });

      expect(result.diagnostics).toEqual([]);
      expect(result.skills).toHaveLength(2);
      expect(result.skills[0]?.name).toBe("draft-skill");
      expect(result.skills[0]?.source).toBe("generated");
      expect(result.skills[1]?.name).toBe("typescript-code-review");
      expect(result.skills[1]?.enabled).toBe(true);
      expect(result.skills[1]?.permissions?.shell).toBe("ask");
      expect(result.skills[1]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.skills[1]?.validation?.tests).toEqual(["tests/*.case.md"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("disables invalid manifests and reports diagnostics", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "runloom-bad-skills-"));

    try {
      await writeSkill(
        stateDir,
        "installed",
        "bad-skill",
        {
          name: "bad-skill",
          version: "0.0.1",
          description: "Missing required schema.",
          triggers: ["bad"],
          validation: {
            schema: "wrong-schema"
          }
        },
        "## 适用场景\n\nOnly one section.\n"
      );

      const result = loadSkills({ stateDir });

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]).toMatchObject({
        name: "bad-skill",
        enabled: false,
        source: "installed"
      });
      expect(result.skills[0]?.diagnostics?.[0]).toMatch(/validation\.schema/);
      expect(result.diagnostics[0]?.message).toMatch(/validation\.schema/);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

async function writeSkill(
  stateDir: string,
  source: "installed" | "generated",
  name: string,
  manifest: unknown,
  instructions = validSkillInstructions()
): Promise<void> {
  const skillDir = join(stateDir, "skills", source, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(skillDir, "SKILL.md"), instructions, "utf8");
}

function validSkillInstructions(): string {
  return [
    "## 适用场景",
    "Review tasks.",
    "## 不适用场景",
    "Unrelated tasks.",
    "## 执行步骤",
    "Read, compare, report.",
    "## 所需工具",
    "fs.read and git.diff.",
    "## 验证方式",
    "Check findings.",
    "## 输出格式",
    "Findings first.",
    "## 示例",
    "Example review."
  ].join("\n\n");
}
