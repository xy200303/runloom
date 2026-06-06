import { createRunloomAgent } from "runloom-agent";
import { createRunloomTuiApp } from "runloom-tui";

const agent = await createRunloomAgent({
  provider: "openai-responses",
  model: "gpt-4.1",
  workspace: process.cwd()
});

await createRunloomTuiApp({ agent }).start();
