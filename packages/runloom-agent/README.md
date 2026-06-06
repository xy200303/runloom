# runloom-agent

`runloom-agent` is the headless Runloom runtime. It is designed for professional coding tasks: project inspection, todo tracking, guarded file/tool activity, event streaming, approvals, and model-provider abstraction.

The package does not use product mock data. Test-only providers and recorded fixtures should live in testing code only.

## Minimal Usage

```ts
import { createRunloomAgent } from "runloom-agent";

const agent = await createRunloomAgent({
  provider: "openai-responses",
  model: "gpt-4.1",
  workspace: process.cwd()
});

agent.subscribe((event) => {
  console.log(event.type, event.payload);
});

await agent.submit("阅读 package.json 并总结项目");
await agent.close();
```

Set `OPENAI_API_KEY` or pass `apiKey` when using the built-in OpenAI Responses provider.

## Built-In Coding Tools

All built-in tools execute through Runloom's event stream and approval policy.

```ts
const read = await agent.executeTool("fs.read", {
  path: "package.json"
});

const verification = await agent.executeTool("shell.verify", {
  command: "pnpm",
  args: ["test"]
});
```

Default read-only filesystem tools are allowed inside the workspace. Shell and write operations request approval unless the user changes the approval policy.
