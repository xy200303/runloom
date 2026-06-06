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

test("built-in coding tools operate on real workspace data", async () => {
  const agent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });

  const readResult = await agent.executeTool("fs.read", { path: "package.json" });
  assert.equal(readResult.status, "completed");
  assert.match(readResult.output.content, /"name": "runloom"/);

  const searchResult = await agent.executeTool("fs.search", { query: "runloom-agent", path: "packages", maxResults: 5 });
  assert.equal(searchResult.status, "completed");
  assert.ok(searchResult.output.matches.length > 0);

  const diffResult = await agent.executeTool("diff.text", {
    before: "alpha\nbeta\n",
    after: "alpha\ngamma\n",
    filePath: "sample.txt"
  });
  assert.equal(diffResult.status, "completed");
  assert.equal(diffResult.output.filesChanged[0], "sample.txt");
  assert.match(diffResult.output.patch, /-beta/);
  assert.match(diffResult.output.patch, /\+gamma/);

  await agent.close();
});

test("shell verification is governed by approval policy", async () => {
  const defaultAgent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: ""
  });

  const waiting = await defaultAgent.executeTool("shell.verify", { command: "node", args: ["--version"] });
  assert.equal(waiting.status, "waiting_approval");
  assert.ok(waiting.approvalId);
  await defaultAgent.close();

  const fullAccessAgent = await createRunloomAgent({
    provider: "openai-responses",
    model: "gpt-4.1",
    workspace: process.cwd(),
    apiKey: "",
    approvalPolicy: {
      scopes: {
        shell: "full_access"
      }
    }
  });

  const verified = await fullAccessAgent.executeTool("shell.verify", { command: "node", args: ["--version"] });
  assert.equal(verified.status, "completed");
  assert.equal(verified.output.exitCode, 0);
  assert.match(verified.output.stdout.trim(), /^v\d+\./);
  await fullAccessAgent.close();
});
