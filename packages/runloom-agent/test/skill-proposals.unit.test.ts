import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunloomAgent } from "../src/index.js";
import type { ModelProviderEvent, ModelRequest } from "../src/index.js";

describe("skill proposals", () => {
  it("keeps invalid generated skill proposals out of approvals and active skills", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "runloom-invalid-skill-proposal-"));
    const agent = await createRunloomAgent({
      provider: "openai-responses",
      model: "gpt-4.1",
      workspace: process.cwd(),
      apiKey: "",
      stateDir
    });

    try {
      const proposal = await agent.proposeSkill({
        changeType: "create",
        reason: "Capture repeated review guidance.",
        manifest: {
          name: "unsafe-generated-review",
          description: "Unsafe generated review guidance.",
          triggers: ["generated review"],
          validation: {
            schema: "wrong-schema" as "skill-manifest@1"
          }
        },
        instructions: validSkillInstructions()
      });

      expect(proposal.status).toBe("invalid");
      expect(proposal.validation.valid).toBe(false);
      expect(proposal.validation.diagnostics[0]).toMatch(/validation\.schema/);
      expect(await agent.listApprovals()).toEqual([]);
      expect(await agent.listSkills()).toEqual([]);
    } finally {
      await agent.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("waits for approval before installing and activating generated skills", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "runloom-skill-proposal-"));
    const provider = new RecordingProvider();
    const agent = await createRunloomAgent({
      provider,
      model: "gpt-4.1",
      workspace: process.cwd(),
      stateDir
    });

    try {
      const proposal = await agent.proposeSkill({
        changeType: "create",
        reason: "Repeated generated review tasks need the same checklist.",
        evidence: ["reviewed generated skill tasks twice"],
        manifest: {
          name: "generated-review",
          version: "0.1.0",
          description: "Review generated skill proposals.",
          triggers: ["generated review"],
          requiredTools: ["fs.read"],
          permissions: {
            readWorkspace: true,
            writeWorkspace: false,
            shell: "ask"
          },
          validation: {
            schema: "skill-manifest@1",
            tests: ["skills/generated-review.test.md"]
          }
        },
        instructions: validSkillInstructions()
      });

      expect(proposal.status).toBe("waiting_approval");
      expect(proposal.approvalId).toBeTruthy();
      expect(await agent.listSkills()).toEqual([]);
      const approvals = await agent.listApprovals();
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.scope).toBe("skills.register");
      expect(approvals[0]?.action).toBe(`skill.proposal:${proposal.id}`);

      if (!proposal.approvalId) {
        throw new Error("Expected skill proposal approval id.");
      }
      await agent.resolveApproval(proposal.approvalId, { decision: "approved" });

      const proposals = await agent.listSkillProposals();
      expect(proposals[0]).toMatchObject({
        id: proposal.id,
        status: "installed",
        skillName: "generated-review"
      });
      const skills = await agent.listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({
        name: "generated-review",
        enabled: true,
        source: "generated"
      });

      const manifest = JSON.parse(
        await readFile(join(stateDir, "skills", "generated", "generated-review", "skill.json"), "utf8")
      ) as { name?: string };
      expect(manifest.name).toBe("generated-review");

      const result = await agent.submit("please run the generated review checklist");
      const userMessage = provider.requests[0]?.input?.find((item) => item.type === "message" && item.role === "user");

      expect(result.status).toBe("completed");
      expect(userMessage?.content[0]?.text).toMatch(/Activated skills:/);
      expect(userMessage?.content[0]?.text).toMatch(/generated-review@0\.1\.0/);
    } finally {
      await agent.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

class RecordingProvider {
  id = "skill-proposal-provider";
  protocol = "custom" as const;
  capabilities = {
    streaming: false,
    tools: true
  };
  requests: ModelRequest[] = [];

  async *createResponse(request: ModelRequest): AsyncIterable<ModelProviderEvent> {
    this.requests.push(request);
    yield { type: "response.created", responseId: "resp_skill_proposal" };
    yield { type: "response.output_text.delta", delta: "done" };
    yield { type: "response.completed", finishReason: "stop" };
  }
}

function validSkillInstructions(): string {
  return [
    "## 适用场景",
    "Generated review work.",
    "## 不适用场景",
    "Non-review tasks.",
    "## 执行步骤",
    "Read the task, inspect the generated skill, and report findings first.",
    "## 所需工具",
    "fs.read.",
    "## 验证方式",
    "Confirm findings and affected files.",
    "## 输出格式",
    "Findings first, then risks.",
    "## 示例",
    "Review a generated skill proposal."
  ].join("\n\n");
}
