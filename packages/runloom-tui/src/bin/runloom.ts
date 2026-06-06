#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { createRunloomAgent } from "runloom-agent";
import { createRunloomTuiApp } from "../app/tui-app.js";

const workspace = process.cwd();
const model = process.env.RUNLOOM_MODEL ?? "gpt-4.1";
const stateDir = process.env.RUNLOOM_STATE_DIR || join(homedir(), ".runloom");

const agent = await createRunloomAgent({
  provider: "openai-responses",
  model,
  workspace,
  stateDir
});

await createRunloomTuiApp({ agent }).start();
