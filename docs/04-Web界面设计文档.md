# Web 界面设计文档

## 定位

`runloom-web` 是后期实现的 Web 包，首期不进入实现和发布。后期实现时使用 Vue 3 + TypeScript + Vite，提供 Web server/API/SSE/WebSocket 展示层和可复用 Vue 组件。它复用 `runloom-agent`，不重新实现 agent 逻辑。

## 实现阶段

- 首期：不实现 `runloom-web`，只保留本文档作为设计约束。
- 后期：创建 `packages/runloom-web` 并使用 Vue 3 + TypeScript + Vite 实现。
- 发布：`runloom-web` 后期单独满足 README、examples、exports、types、build、pack dry run 和 npm publish 要求。

## 使用方式

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

app.use("/runloom", createRunloomWebRouter({ agent }));
```

Vue 组件层：

```ts
import {
  RunloomTranscript,
  RunloomTodoPanel,
  RunloomApprovalDialog
} from "runloom-web/components";
```

## Server API

建议路由：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/sessions` | 列出 session |
| `GET` | `/api/sessions/:id` | 获取 session |
| `POST` | `/api/sessions` | 创建 session |
| `POST` | `/api/runs` | 提交用户目标 |
| `GET` | `/api/runs/:id` | 获取 run 状态 |
| `POST` | `/api/runs/:id/cancel` | 取消 run |
| `POST` | `/api/runs/:id/resume` | 恢复 run |
| `GET` | `/api/runs/:id/events` | SSE 事件流和回放 |
| `GET` | `/api/approvals` | 列出待审批请求 |
| `POST` | `/api/approvals/:id` | 提交审批决定 |
| `GET` | `/api/approval-policy` | 读取权限审批策略 |
| `PATCH` | `/api/approval-policy` | 修改权限审批策略 |
| `GET` | `/api/todos` | 当前 session todo |
| `GET` | `/api/tools` | 可用工具 |
| `GET` | `/api/skills` | skills 状态 |
| `GET` | `/api/mcp` | MCP 状态 |
| `GET` | `/api/a2a` | A2A peer 状态 |
| `GET` | `/api/memory` | 本地成长摘要 |
| `GET` | `/api/evolution/proposals` | 改进提案 |
| `GET` | `/api/evals/runs` | eval 运行记录 |

所有 API 都通过 `runloom-agent` public API 读写。

## SSE 与 WebSocket

SSE：

- 首选用于 run events。
- 支持 `Last-Event-ID` 或 `cursor` 回放。
- 事件格式使用 `RunloomEvent` 的 JSON 版本。
- 可选提供 OpenAI Responses compatible stream 投影，便于接入已有 Responses 风格前端或评测器。

WebSocket：

- 可选。
- 适合双向交互、实时 typing、复杂 approval 协作。
- 仍然不能绕过 agent API。

事件流要求：

- sequence 单调递增。
- 支持断线恢复。
- redaction 后发送。
- 错误事件结构化。
- 内部事件存储始终使用完整 `RunloomEvent` envelope；OpenAI Responses compatible stream 只是输出层转换。

## 前端布局

Web 第一屏应是实际工作台，不做营销 landing page。

```text
+--------------------------------------------------------------------------------+
| Top Bar: project/session/model/run status                                       |
+----------------------+--------------------------------------+------------------+
| Session List         | Transcript                           | Inspector        |
|                      | Input                                | Todo             |
|                      |                                      | Tool Activity    |
|                      |                                      | Approvals        |
+----------------------+--------------------------------------+------------------+
```

响应式：

- 桌面：三栏工作台。
- 平板：session list 可折叠。
- 手机：底部 tabs：Transcript、Todo、Activity、Sessions。

## 组件

建议组件：

- `RunloomAppShell`
- `RunloomSessionList`
- `RunloomTranscript`
- `RunloomInputBox`
- `RunloomTodoPanel`
- `RunloomToolActivity`
- `RunloomApprovalDialog`
- `RunloomApprovalPolicySettings`
- `RunloomSkillStatus`
- `RunloomMcpStatus`
- `RunloomA2AStatus`
- `RunloomExternalAgentStatus`
- `RunloomMemoryBrowser`
- `RunloomEvolutionProposalPanel`
- `RunloomEvalRunPanel`

组件输入类型来自 `runloom-agent` public types。

组件实现要求：

- 使用 Vue 3 Composition API。
- 使用 TypeScript。
- 使用 Vite 构建。
- 组件 props 和 emitted events 使用 `runloom-agent` public types。
- 不引入 React/TSX 作为默认实现路线。

## Approval 弹窗

弹窗展示：

- scope。
- 风险等级。
- 当前审批模式：完全访问、请求批准、替我决定。
- 动作摘要。
- 参数摘要。
- 影响文件。
- policy reason。
- 可选 decision。

操作：

- approve。
- deny。
- approve for session。
- set scope to 完全访问。
- set scope to 请求批准。
- set scope to 替我决定。
- modify constraints，如果支持。

所有决定调用 `/api/approvals/:id`。

## 权限审批设置

Web 提供 `RunloomApprovalPolicySettings`，用于让用户修改权限审批方式。

设置粒度：

- default mode。
- filesystem read/write/delete。
- shell。
- network/browser/gui。
- MCP tools。
- external agents。
- A2A delegation。
- memory/identity writes。
- tool/skill registration。
- evolution apply。
- npm publish。

三种模式：

- 完全访问：在 configured guardrails 内自动放行，仍保留 hard deny、redaction、trace 和 audit。
- 请求批准：命中该 scope 时弹窗等待用户确认。
- 替我决定：Runloom 根据风险策略自动处理，必要时升级为请求批准。

修改策略调用 `PATCH /api/approval-policy`，并产生 `approval.policy.updated` 事件。UI 需要明确提示：放宽权限是安全敏感操作。

## Memory Browser

Web 可以比 TUI 展示更多成长层信息：

- identity 文件摘要。
- user preferences。
- lessons。
- episodic memory 列表。
- semantic memory 列表。
- memory candidate。
- proposal diff。

敏感信息默认折叠和 redacted。直接编辑必须转化为 proposal，不直接写文件。

## Skills/MCP 管理

Web 支持：

- skills 列表。
- skill 详情。
- generated skill proposal。
- MCP server 状态。
- MCP tools/resources/prompts 列表。
- 启用/禁用请求。

启用高风险 MCP server 或 skill 需要 approval。

## 外部 Agent / A2A 展示

展示：

- 可用 adapters。
- A2A peers。
- 当前 delegation。
- status events。
- logs。
- output contract。
- verification notes。

外部 agent 输出不能直接作为最终事实展示，需要标明来源和验证状态。

## 安全

Web server 默认：

- 绑定 `127.0.0.1`。
- 不启用公网访问。
- CORS 默认关闭。
- 需要可选 auth middleware。
- SSE 输出 redacted。
- API 不暴露 raw secret 和内部路径。

宿主应用挂载时可注入：

- authentication。
- authorization。
- CSRF。
- rate limit。
- custom logger。

## 非目标

`runloom-web` 不做：

- provider SDK 调用。
- tool 执行。
- workspace 文件直接修改。
- memory 文件直接编辑。
- agent loop。

这些必须由 `runloom-agent` 完成。
