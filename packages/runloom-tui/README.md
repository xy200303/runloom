# runloom-tui

`runloom-tui` is the terminal entrypoint for Runloom. It consumes `runloom-agent` public APIs and events.

## CLI

```bash
runloom
```

Set `OPENAI_API_KEY` before submitting real model requests.

## Embedded Usage

```ts
import { createRunloomAgent } from "runloom-agent";
import { createRunloomTuiApp } from "runloom-tui";

const agent = await createRunloomAgent({
  provider: "openai-responses",
  model: "gpt-4.1",
  workspace: process.cwd()
});

await createRunloomTuiApp({ agent }).start();
```
