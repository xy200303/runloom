# npm 包 API 与发布设计文档

## 发布目标

Runloom 长期规划中的三个包都必须能作为 npm package 被第三方独立复用。首期只发布 `runloom-agent` 和 `runloom-tui`，`runloom-web` 后期使用 Vue 3 + TypeScript + Vite 实现后再发布：

- `runloom-agent`：Node.js 应用直接 import 的 headless runtime。
- `runloom-tui`：CLI bin 和可嵌入终端组件。
- `runloom-web`：后期发布的独立 Web server、可挂载 server/API 层和 Vue 组件层，首期不实现和发布。

所有已发布包只发布 ESM 和 TypeScript 类型声明。

## runloom-agent Public API

最小入口：

```ts
import { createRunloomAgent } from "runloom-agent";

const agent = await createRunloomAgent({
  provider: "openai-responses",
  model: "gpt-4.1",
  workspace: process.cwd(),
});

agent.subscribe((event) => {
  console.log(event);
});

await agent.submit("阅读 package.json 并总结项目");
```

建议导出：

```ts
export function createRunloomAgent(options: CreateRunloomAgentOptions): Promise<RunloomAgent>;

export interface RunloomAgent {
  submit(input: string | RunloomInput, options?: SubmitOptions): Promise<RunResult>;
  subscribe(listener: RunloomEventListener, options?: SubscribeOptions): Unsubscribe;
  listSessions(options?: ListSessionsOptions): Promise<RunloomSession[]>;
  getSession(sessionId: string): Promise<RunloomSession>;
  resume(runId: string): Promise<RunResult>;
  cancel(runId: string): Promise<void>;
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  getApprovalPolicy(): Promise<ApprovalPolicyConfig>;
  updateApprovalPolicy(patch: ApprovalPolicyPatch): Promise<ApprovalPolicyConfig>;
  registerTool(tool: ToolDefinition): Promise<void>;
  registerProvider(provider: ModelProvider): Promise<void>;
  close(): Promise<void>;
}
```

关键类型：

- `CreateRunloomAgentOptions`
- `RunloomEvent`
- `RunloomSession`
- `RunloomTodoItem`
- `ApprovalMode`
- `ApprovalPolicyConfig`
- `ApprovalPolicyPatch`
- `ApprovalRequest`
- `ApprovalDecision`
- `ModelProvider`
- `ToolDefinition`
- `ToolContext`
- `ExternalAgentAdapter`
- `SkillManifest`
- `McpServerConfig`
- `A2APeerConfig`
- `MemoryRecord`
- `EvolutionProposal`
- `EvalBenchmark`

## runloom-agent exports

建议首期：

```json
{
  "name": "runloom-agent",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md", "examples"]
}
```

后续如需子路径：

- `runloom-agent/testing`：test-only provider、recorded fixtures、memory store test helpers，仅测试代码使用。
- `runloom-agent/node`：Node.js 默认工具和 store。

子路径必须保持稳定并进入文档。

## Approval Policy API

Runloom 支持三种用户可配置审批模式：

```ts
export type ApprovalMode = "full_access" | "ask" | "auto_decide";
```

含义：

- `full_access`：完全访问。在 configured guardrails 内自动放行，仍保留 hard deny、redaction、trace 和 audit。
- `ask`：请求批准。命中该 scope 的动作必须等待用户确认。
- `auto_decide`：替我决定。Runloom 根据风险、上下文、用户偏好和历史决策自动允许、拒绝或升级为请求批准。

建议配置：

```ts
export interface ApprovalPolicyConfig {
  defaultMode: ApprovalMode;
  scopes: Partial<Record<PermissionScope, ApprovalMode>>;
  updatedAt: string;
  updatedBy: "user" | "host_app" | "migration";
}

export interface ApprovalPolicyPatch {
  defaultMode?: ApprovalMode;
  scopes?: Partial<Record<PermissionScope, ApprovalMode>>;
}
```

最小示例：

```ts
await agent.updateApprovalPolicy({
  defaultMode: "ask",
  scopes: {
    "filesystem.read": "full_access",
    "filesystem.write": "ask",
    "shell": "auto_decide"
  }
});
```

审批策略变更必须产生事件和审计记录。更改默认权限模式、放宽某个 scope 或把 `ask` 改成 `full_access` 属于安全敏感变更。

## runloom-tui Public API

CLI：

```bash
npx runloom-tui
```

或安装后：

```bash
runloom
```

嵌入式 API：

```ts
import { createRunloomAgent } from "runloom-agent";
import { createRunloomTuiApp } from "runloom-tui";

const agent = await createRunloomAgent({ workspace: process.cwd() });
const app = createRunloomTuiApp({ agent });

await app.start();
```

建议导出：

```ts
export function createRunloomTuiApp(options: CreateRunloomTuiAppOptions): RunloomTuiApp;

export interface RunloomTuiApp {
  start(): Promise<void>;
  stop(): Promise<void>;
  render(event?: unknown): void;
}
```

exports：

```json
{
  "name": "runloom-tui",
  "type": "module",
  "bin": {
    "runloom": "./dist/bin/runloom.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

## runloom-web Public API

`runloom-web` 是后期实现包。实现时使用 Vue 3 + TypeScript + Vite，并且必须复用 `runloom-agent`，不重新实现 runtime。以下 API 是后期设计目标，不进入首期发布验收。

独立 server：

```ts
import { createRunloomAgent } from "runloom-agent";
import { createRunloomWebServer } from "runloom-web/server";

const agent = await createRunloomAgent({ workspace: process.cwd() });
const server = createRunloomWebServer({ agent });

await server.listen({ port: 3120 });
```

挂载到已有服务：

```ts
import { createRunloomWebRouter } from "runloom-web/server";

const router = createRunloomWebRouter({ agent });
app.use("/runloom", router);
```

组件层：

```ts
import { RunloomTranscript, RunloomTodoPanel } from "runloom-web/components";
```

建议 exports：

```json
{
  "name": "runloom-web",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./server": {
      "types": "./dist/server/index.d.ts",
      "import": "./dist/server/index.js"
    },
    "./components": {
      "types": "./dist/components/index.d.ts",
      "import": "./dist/components/index.js"
    },
    "./client": {
      "types": "./dist/client/index.d.ts",
      "import": "./dist/client/index.js"
    }
  }
}
```

## TypeScript 与构建

要求：

- `module` 使用 ESM。
- `declaration: true`。
- `declarationMap: true`。
- `sourceMap: true`。
- public API 从 `src/index.ts` 和明确子路径导出。
- 使用 `tsup`、`rollup`、`unbuild` 或等价工具均可，但输出结构必须稳定。

根脚本建议：

```json
{
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "pack:dry": "pnpm -r pack --dry-run",
    "changeset": "changeset",
    "release": "pnpm build && changeset publish"
  }
}
```

## Semver 策略

在 `1.0.0` 之前：

- public API 仍可调整，但每次 breaking change 必须写 changelog。
- 文档中的稳定 API 应尽量少改。
- `0.x` 阶段仍按 semver 语义表达风险。

`1.0.0` 之后：

- patch：bug fix、文档修正、内部优化、兼容性增强。
- minor：新增向后兼容 API、新 provider、新可选功能。
- major：删除或改变 public API、事件字段语义变化、默认安全策略放宽或存储格式不兼容。

安全策略：

- 放宽权限默认值视为 breaking change。
- 更严格的安全默认值通常是 minor 或 major，取决于是否破坏现有使用。
- event type 删除或 payload 必填字段变化视为 breaking change。

## Changelog

建议使用 Changesets：

- 每个 PR 如影响发布包，必须包含 changeset。
- changelog 按包生成。
- release PR 自动更新版本和 changelog。

每条 changelog 应说明：

- 影响包。
- 变更类型。
- 用户可见行为。
- 迁移方式。
- 安全或权限影响。

## npm Publish CI

发布流程：

1. 合并 changeset release PR。
2. GitHub Actions 在 tag 或 release branch 上运行。
3. 安装依赖。
4. typecheck、test、build。
5. `npm pack --dry-run`。
6. provenance publish。
7. 创建 GitHub Release。

发布保护：

- 只允许 main 分支发布。
- npm token 使用 trusted publishing 或最小权限 automation token。
- 发布前检查 `files` 白名单。
- 禁止把 `.env`、本地数据库、`~/.runloom` 内容和测试密钥打包。

## 最小示例要求

`runloom-agent`：

```ts
import { createRunloomAgent } from "runloom-agent";

const agent = await createRunloomAgent({
  provider: "openai-responses",
  model: "gpt-4.1",
  workspace: process.cwd(),
});

agent.subscribe((event) => console.log(event.type));
await agent.submit("阅读 package.json 并总结项目");
await agent.close();
```

`runloom-tui`：

```ts
import { createRunloomAgent } from "runloom-agent";
import { createRunloomTuiApp } from "runloom-tui";

const agent = await createRunloomAgent({ workspace: process.cwd() });
await createRunloomTuiApp({ agent }).start();
```

`runloom-web`：

后期实现，使用 Vue 3 + TypeScript + Vite。

```ts
import { createRunloomAgent } from "runloom-agent";
import { createRunloomWebServer } from "runloom-web/server";

const agent = await createRunloomAgent({ workspace: process.cwd() });
const server = createRunloomWebServer({ agent });
await server.listen({ port: 3120 });
```

## API 兼容承诺

Runloom 对外承诺稳定的是：

- npm exports。
- public TypeScript 类型。
- `RunloomEvent` 事件名称和语义。
- approval/todo/session API。
- provider/tool/external agent adapter 接口。

不承诺稳定的是：

- `src/internal`。
- 未在 exports 声明的路径。
- 实验性 feature flag。
- debug-only trace payload。
