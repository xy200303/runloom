# Runloom

Runloom is a local coding agent runtime for professional software development.

The first implementation phase ships:

- `runloom-agent`: headless TypeScript runtime.
- `runloom-tui`: terminal CLI that consumes the runtime.

`runloom-web` is intentionally deferred and will use Vue 3 + TypeScript + Vite later.

## Install

```bash
pnpm install
```

## Build

```bash
pnpm build
```

## CLI

```bash
pnpm --filter runloom-tui dev
```

Set `OPENAI_API_KEY` before submitting real model requests.
