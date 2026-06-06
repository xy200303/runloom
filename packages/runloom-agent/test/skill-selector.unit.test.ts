import { describe, expect, it } from "vitest";
import { selectSkillActivations } from "../src/skills/skill-selector.js";

describe("skill selector", () => {
  it("activates matching enabled skills and reports missing tool diagnostics", () => {
    const result = selectSkillActivations({
      text: "Please review TypeScript change",
      taskType: "code_review",
      language: "typescript",
      availableTools: ["fs.read", "git.diff"],
      skills: [
        {
          name: "typescript-code-review",
          description: "Review TypeScript changes.",
          enabled: true,
          source: "installed",
          version: "0.1.0",
          triggers: ["review TypeScript"],
          requiredTools: ["fs.read", "git.diff"]
        },
        {
          name: "shell-review",
          description: "Run shell review checks.",
          enabled: true,
          source: "installed",
          triggers: ["review"],
          requiredTools: ["shell.verify"]
        },
        {
          name: "disabled-review",
          description: "Disabled.",
          enabled: false,
          source: "installed",
          triggers: ["review"]
        }
      ]
    });

    expect(result.activations).toHaveLength(1);
    expect(result.activations[0]).toMatchObject({
      skillName: "typescript-code-review",
      version: "0.1.0",
      confidence: 0.92
    });
    expect(result.activations[0]?.reason).toMatch(/trigger matched user input/);
    expect(result.activations[0]?.contextBudgetTokens).toBe(1200);
    expect(result.diagnostics).toEqual([
      {
        skillName: "shell-review",
        reason: "missing required tools: shell.verify"
      }
    ]);
  });
});
