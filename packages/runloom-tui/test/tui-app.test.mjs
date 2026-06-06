import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { createRunloomTuiApp } from "../dist/index.js";

test("approval command updates scope and default modes", async () => {
  const policy = {
    defaultMode: "ask",
    scopes: {
      shell: "ask"
    },
    updatedAt: new Date().toISOString(),
    updatedBy: "user"
  };
  let closed = false;
  const submissions = [];

  const agent = {
    subscribe() {
      return () => {};
    },
    async submit(input) {
      submissions.push(input);
      return {
        runId: "run_test",
        sessionId: "ses_test",
        status: "completed",
        outputText: ""
      };
    },
    async getApprovalPolicy() {
      return policy;
    },
    async listTools() {
      return [
        {
          name: "fs.read",
          description: "Read a file",
          inputSchema: {},
          permissions: ["filesystem.read"]
        }
      ];
    },
    async updateApprovalPolicy(patch) {
      if (patch.defaultMode) {
        policy.defaultMode = patch.defaultMode;
      }
      if (patch.scopes) {
        policy.scopes = {
          ...policy.scopes,
          ...patch.scopes
        };
      }
      return policy;
    },
    async close() {
      closed = true;
    }
  };

  const output = new MemoryOutput();
  const app = createRunloomTuiApp({ agent, output });

  await app.runCommand("/approval shell full_access");
  await app.runCommand("/approval default auto_decide");
  await app.runCommand("/tools");
  await app.runCommand("/model profile frontend_design");
  await app.submitPrompt("设计一个前端界面");
  await app.runCommand("/model set kimi:kimi-design");
  await app.submitPrompt("继续设计界面");
  await app.runCommand("/model clear");
  await app.runCommand("/quit");

  const text = output.toString();
  assert.equal(policy.scopes.shell, "full_access");
  assert.equal(policy.defaultMode, "auto_decide");
  assert.equal(closed, true);
  assert.match(text, /Approval mode for shell set to full_access/);
  assert.match(text, /Approval default mode set to auto_decide/);
  assert.match(text, /fs\.read - Read a file \[filesystem\.read\]/);
  assert.match(text, /Model profile set to frontend_design/);
  assert.match(text, /Model override set to kimi:kimi-design/);
  assert.equal(submissions[0].profile, "frontend_design");
  assert.equal(submissions[0].model, undefined);
  assert.equal(submissions[1].model, "kimi:kimi-design");
  assert.equal(submissions[1].profile, undefined);
});

class MemoryOutput extends Writable {
  chunks = [];

  _write(chunk, _encoding, callback) {
    this.chunks.push(String(chunk));
    callback();
  }

  toString() {
    return this.chunks.join("");
  }
}
