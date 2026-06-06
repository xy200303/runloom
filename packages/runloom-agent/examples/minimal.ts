import { createRunloomAgent } from "runloom-agent";

const agent = await createRunloomAgent({
  provider: "openai-responses",
  model: "gpt-4.1",
  workspace: process.cwd()
});

agent.subscribe((event) => {
  console.log(`[${event.sequence}] ${event.type}`);
});

await agent.submit("阅读 package.json 并总结项目");
await agent.close();
