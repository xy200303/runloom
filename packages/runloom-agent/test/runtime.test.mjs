import assert from "node:assert/strict";
import test from "node:test";
import { createRunloomAgent } from "../dist/index.js";

test("approval policy can be updated", async () => {
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });

  const policy = await agent.updateApprovalPolicy({
    scopes: {
      "filesystem.write": "ask",
      shell: "auto_decide"
    }
  });

  assert.equal(policy.scopes["filesystem.write"], "ask");
  assert.equal(policy.scopes.shell, "auto_decide");
  await agent.close();
});

test("missing OpenAI API key fails without product mock output", async () => {
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });

  const eventTypes = [];
  agent.subscribe((event) => eventTypes.push(event.type));

  const result = await agent.submit("阅读 package.json 并总结项目");

  assert.equal(result.status, "failed");
  assert.match(result.outputText, /OPENAI_API_KEY/);
  assert.ok(eventTypes.includes("coding.workspace.inspected"));
  assert.ok(eventTypes.includes("response.failed"));
  assert.ok(eventTypes.includes("run.failed"));
  await agent.close();
});
