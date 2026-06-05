# TUI 界面设计文档

## 定位

`runloom-tui` 是 Runloom 的终端交互界面。它既提供 CLI bin，也提供可嵌入 TUI app。TUI 不实现 agent 逻辑，只消费 `runloom-agent` 的 public API 和事件。

## 设计目标

- 像 Claude Code / xclaw 一样支持持续 transcript、输入、工具活动和状态反馈。
- 让用户清楚看到 agent 当前在做什么、用过什么工具、todo 进度和审批请求。
- 支持长任务运行、取消、恢复、事件回放和 session 切换。
- 展示 Skills、MCP、外部 agent、本地成长和 eval 状态。
- 保持键盘优先，适合本地开发者长期使用。

## CLI 与嵌入式 API

CLI：

```bash
runloom
runloom --workspace .
runloom --session <session-id>
```

嵌入式：

```ts
import { createRunloomAgent } from "runloom-agent";
import { createRunloomTuiApp } from "runloom-tui";

const agent = await createRunloomAgent({ workspace: process.cwd() });
const app = createRunloomTuiApp({ agent });

await app.start();
```

## 主布局

```text
+--------------------------------------------------------------------------------+
| Header: Runloom | workspace | model | session | run status | token/latency       |
+--------------------------------------------------------------------------------+
| Transcript                                                                     |
| - user messages                                                                |
| - assistant deltas                                                             |
| - reasoning summary                                                            |
| - tool calls and results                                                       |
| - external agent activity                                                      |
| - eval/growth notices                                                          |
+--------------------------------------+-----------------------------------------+
| Todo Panel                           | Activity Panel                          |
| - pending/in progress/completed      | - running tools                         |
| - blocked items                      | - approvals                             |
|                                      | - MCP/A2A/external agent status         |
+--------------------------------------+-----------------------------------------+
| Input: prompt / slash command / approval response                               |
+--------------------------------------------------------------------------------+
```

小屏幕终端可折叠右侧面板，用快捷键在 `Transcript`、`Todo`、`Activity` 间切换。

## 事件渲染

TUI 渲染只依赖 `RunloomEvent`：

| 事件 | 渲染 |
| --- | --- |
| `run.started` | transcript 中显示新 run |
| `model.output_text.delta` | 追加 assistant 文本 |
| `model.reasoning.delta` | 默认折叠为 reasoning summary |
| `tool.call.requested` | activity 中显示待执行工具 |
| `tool.call.started` | 显示 running |
| `tool.call.completed` | 显示结果摘要，可展开 |
| `approval.requested` | 打开 approval 面板 |
| `todo.updated` | 更新 Todo Panel |
| `skill.activated` | activity 中显示 skill 名称和原因 |
| `mcp.*` | MCP 状态区 |
| `a2a.*` | 外部协作状态区 |
| `evolution.proposal.created` | 成长提案区 |
| `eval.run.updated` | eval 状态区 |

TUI 不解析供应商原始 streaming event。

## 输入与命令

基础命令：

- `/help`：显示命令。
- `/status`：runtime、model、tool、store、权限状态。
- `/model`：显示当前 provider/model。
- `/model set <provider/model>`：切换模型。
- `/session`：显示当前 session。
- `/session list`：列出 session。
- `/session switch <id>`：切换 session。
- `/todo`：显示 todo。
- `/tools`：显示可用工具。
- `/permissions`：查看和修改权限审批模式。
- `/approval`：同 `/permissions`，聚焦 approval policy。
- `/skills`：显示 skills。
- `/skills reload`：重新加载 skills。
- `/mcp`：显示 MCP server 状态。
- `/a2a`：显示 A2A peers。
- `/external`：显示外部 agent adapters。
- `/memory`：显示成长层摘要。
- `/evolution`：显示改进提案。
- `/evals`：显示 eval runs。
- `/stop`：取消当前 run。
- `/resume`：恢复可恢复 run。
- `/clear`：清空当前视图，不删除 session。
- `/quit`：退出。

命令处理只调用 agent API，不直接操作内部 store。

## 快捷键

- `Enter`：提交输入。
- `Shift+Enter`：换行。
- `Ctrl+C`：中止当前 run 或二次退出。
- `Esc`：关闭弹窗。
- `Ctrl+L`：清屏。
- `PgUp/PgDn`：滚动 transcript。
- `Alt+1`：聚焦 transcript。
- `Alt+2`：聚焦 todo。
- `Alt+3`：聚焦 activity。

## Approval 交互

Approval 面板展示：

- action。
- scope。
- risk。
- 当前审批模式：完全访问、请求批准、替我决定。
- summary。
- details。
- affected paths。
- command/tool 参数摘要。
- policy reason。
- timeout。

操作：

- approve once。
- deny。
- approve for session。
- set scope to 完全访问。
- set scope to 请求批准。
- set scope to 替我决定。
- edit constraints，如果该 approval 支持。

结果通过：

```ts
agent.resolveApproval(approvalId, decision)
```

TUI 不直接执行被审批动作。

## 权限审批设置

`/permissions` 打开权限审批设置面板：

```text
Scope                  Mode
filesystem.read        完全访问
filesystem.write       请求批准
shell                  替我决定
mcp.tools              请求批准
external_agents        请求批准
identity.write         请求批准
```

三种模式：

- 完全访问：在 hard deny 和 configured guardrails 内自动放行。
- 请求批准：每次命中该 scope 都弹出审批。
- 替我决定：Runloom 按风险策略自动允许、拒绝或升级为请求批准。

用户修改模式后，TUI 调用 `agent.updateApprovalPolicy(...)`。每次变更都需要在 transcript/activity 中显示，并写入 audit trail。

## Todo 展示

Todo panel 展示：

- 当前 `in_progress`。
- pending 列表。
- blocked 原因。
- completed 最近项。

原则：

- todo 来源是 agent store。
- 用户可通过命令要求 agent 修改 todo，但 TUI 不私自改。
- todo 更新必须能在 transcript 中追溯。

## Tool Activity

工具活动展示：

- 工具名。
- 输入摘要。
- 权限状态。
- runtime。
- 输出摘要。
- 错误。
- approval 状态。

支持展开查看详细输出，但默认要 redaction 后展示。

## Skills/MCP/A2A/成长状态

右侧 Activity 或弹层展示：

- 当前激活 skills。
- MCP server connected/disconnected。
- MCP tools/resources/prompts 数量。
- A2A peers 和委托状态。
- external agent delegation。
- growth proposals。
- eval gate 状态。

这些都是 runtime 状态，TUI 只展示和提交用户决定。

## Session 与事件回放

启动时：

1. 加载最近 session。
2. 回放 event records 构建 transcript/todo/activity。
3. 如果有未完成 run，显示可恢复状态。
4. 用户可 `/resume` 或 `/stop`。

长任务断线后重新进入 TUI，应能看到历史事件和当前 run 状态。

## 错误体验

错误展示要区分：

- provider error。
- tool error。
- security denied。
- approval denied。
- store error。
- runtime cancelled。
- eval gate failed。

每个错误展示 human message 和 next action，不直接倾倒 raw stack。

## 非目标

TUI 不做：

- agent loop。
- provider adapter。
- tool executor。
- MCP client/server 直接调用。
- 本地成长文件读写。
- npm 发布。

这些都属于 `runloom-agent` 或 CI。
