#!/usr/bin/env node
import { createRunloomAgent } from "runloom-agent";
import { createRunloomTuiApp } from "../app/tui-app.js";

const workspace = process.cwd();
const model = process.env.RUNLOOM_MODEL ?? "gpt-4.1";

const agent = await createRunloomAgent({
  provider: "openai-responses",
  model,
  workspace
});

await createRunloomTuiApp({ agent }).start();
