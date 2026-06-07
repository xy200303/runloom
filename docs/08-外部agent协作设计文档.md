# 外部 Agent 协作设计文档

## 定位

Codex、Claude Code 等外部 coding agent 不属于 `ModelProvider`。它们不是“一个模型 API”，而是能执行任务、调用工具、修改文件、产生日志和中间事件的 agent runtime。

Runloom 通过 `ExternalAgentAdapter`、subagent 和 A2A peer 接入它们。

当前首期已落地最小 public surface：`runloom-agent` 暴露 external agent adapter/summary/delegation 类型，以及 `registerExternalAgent(...)`、`listExternalAgents()`、`delegateExternalAgent(...)`；TUI 通过 `/external` 展示真实注册状态。委托入口已做 workspace/maxTurns 归一化，接入 `external_agents` approval policy，并写入 external agent 事件和 audit；日志串流、输出格式 contract 和 adapter 具体执行仍按本文后续设计推进。

## 设计目标

- 允许 Runloom 把受限任务委托给外部 specialist agent。
- 限制 workspace、权限、最大轮数、最长时间和输出格式。
- 接收外部 agent 的结果、事件、日志和文件变更摘要。
- 全过程进入 approval、permission policy、trace、audit trail 和 event stream。
- 外部 agent 结果回到主 loop，由 Runloom 决定是否采纳、验证或继续处理。

## ExternalAgentAdapter 接口

```ts
export interface ExternalAgentAdapter {
  id: string;
  displayName: string;
  capabilities: ExternalAgentCapabilities;
  delegate(request: ExternalAgentDelegationRequest, context: ExternalAgentContext): AsyncIterable<ExternalAgentEvent>;
  cancel?(delegationId: string): Promise<void>;
  healthCheck?(): Promise<ExternalAgentHealth>;
}
```

委托请求：

```ts
export interface ExternalAgentDelegationRequest {
  delegationId: string;
  goal: string;
  workspace: string;
  allowedRoots: string[];
  permissions: ExternalAgentPermissions;
  maxTurns?: number;
  timeoutMs?: number;
  expectedOutput: ExternalAgentOutputContract;
  context?: RunloomContextSummary;
}
```

输出契约：

```ts
export interface ExternalAgentOutputContract {
  format: "summary" | "json" | "patch" | "report";
  schema?: Record<string, unknown>;
  requireChangedFilesSummary?: boolean;
  requireVerificationNotes?: boolean;
}
```

## 协作流程

```text
Runloom loop
  -> decide delegation
  -> classify risk
  -> request approval if needed
  -> create delegation record
  -> launch adapter with constrained context
  -> stream external events into Runloom events
  -> collect result and logs
  -> validate output contract
  -> inspect file changes if any
  -> append result to main context
  -> continue main loop
```

## Approval 与权限

外部 agent 委托默认至少是 medium risk。以下情况为 high 或 critical：

- 允许写文件。
- 允许 shell。
- 允许联网。
- 允许访问 workspace 之外的路径。
- 允许修改 Runloom 自身代码。
- 允许生成或注册工具/skill。
- 允许执行发布、删除、密钥相关动作。

委托必须经过 `PermissionPolicy`：

- allowed roots。
- denied paths。
- max runtime。
- max turns。
- tool whitelist。
- environment variable allowlist。
- output schema。

## Codex Adapter

当前首期已提供 `createCodexExternalAgentAdapter(...)` public helper，用于生成可注册到
`RunloomAgent.registerExternalAgent(...)` 的 Codex CLI adapter descriptor。该 helper 只声明
`local_cli` adapter 的 name、command、capabilities、status 和 maxTurns，供 TUI/Web/VSCode
等 host 展示和配置使用；实际 delegate 执行、stdout/stderr 捕获、patch 复核和 approval/audit
衔接仍按下列职责继续实现。

Codex adapter 的职责：

- 以子进程、API 或本地服务方式启动 Codex。
- 注入受限 workspace 和任务 prompt。
- 指定最大轮数、权限、输出格式。
- 捕获 stdout/stderr、事件、patch、最终回复。
- 把 Codex 的中间状态转换为 `ExternalAgentEvent`。

安全要求：

- 不把 Runloom 的全部 memory 或 secret 直接交给 Codex。
- 只传任务所需上下文。
- Codex 的文件修改需要 Runloom 复核。
- Codex 结果不能直接触发 Runloom 高影响变更。

## Claude Code Adapter

当前首期已提供 `createClaudeCodeExternalAgentAdapter(...)` public helper，用于生成可注册到
`RunloomAgent.registerExternalAgent(...)` 的 Claude Code CLI adapter descriptor。该 helper 只声明
`local_cli` adapter 的 name、command、capabilities、status 和 maxTurns，供 host 展示和配置；
实际 session 创建、权限请求映射、transcript 捕获和结果复核仍按下列职责继续实现。

Claude Code adapter 的职责与 Codex 类似，但需要适配其 CLI/session 行为：

- 创建隔离 session。
- 注入受限 instructions。
- 记录 transcript。
- 处理权限请求。
- 收集 diff、命令日志和最终总结。

Runloom 仍然是主控者：

- Claude Code 的 approval 请求映射为 Runloom approval。
- Claude Code 的工具调用必须受 Runloom policy 限制。
- 最终结果作为外部证据进入主 loop。

## 其他本地 Coding Agent Adapter

Runloom 应保留通用 adapter 扩展点，用于接入其他本地 coding agent、团队内部 specialist agent 或服务化开发助手。
当前首期已提供 `createLocalCliExternalAgentAdapter(...)` public helper，用于生成任意 `local_cli`
external agent descriptor；host 仍负责确认命令可用性、展示状态，并在后续 delegate 执行接入
approval/audit 前决定是否启用。

通用要求：

- 通过 `ExternalAgentAdapter` 接口接入。
- 支持受限 workspace、权限、最大轮数、超时和输出格式。
- 中间日志、工具活动、文件变更和最终结果都转换为 Runloom external events。
- 外部 agent 结果必须回到 Runloom 主 loop，由 Runloom 验证和决定是否采纳。

## 外部事件映射

```ts
export type ExternalAgentEvent =
  | { type: "external.started"; delegationId: string }
  | { type: "external.log"; level: "debug" | "info" | "warn" | "error"; message: string }
  | { type: "external.output.delta"; text: string }
  | { type: "external.tool.started"; name: string; inputSummary: string }
  | { type: "external.tool.completed"; name: string; outputSummary: string }
  | { type: "external.files.changed"; files: ChangedFileSummary[] }
  | { type: "external.completed"; result: ExternalAgentResult }
  | { type: "external.failed"; error: ExternalAgentError };
```

Runloom 对外展示时转换为：

- `external_agent.delegated`
- `external_agent.approval_requested`
- `external_agent.approved`
- `external_agent.event`
- `external_agent.completed`
- `external_agent.failed`

## Audit Trail

每次委托记录：

- 委托来源 run/step。
- 外部 agent id 和版本。
- goal。
- 传入上下文摘要。
- workspace 和 allowed roots。
- 权限策略。
- approval 决策。
- 日志和事件位置。
- 文件变更摘要。
- 输出结果。
- 验证结论。
- 风险和回滚建议。

## 失败处理

失败场景：

- 外部 agent 不可用。
- 输出不符合 schema。
- 超时。
- 越权请求。
- 产生未授权文件修改。
- 用户拒绝 approval。
- 结果与主任务冲突。

处理原则：

- 失败不应破坏主 session。
- 主 loop 收到结构化失败结果后决定重试、改派、降级或向用户报告。
- 未授权文件改动必须进入 quarantine，不自动采纳。

## 与 A2A 的关系

`ExternalAgentAdapter` 是本地集成接口。A2A 是跨 agent 的互操作协议。一个外部 agent 可以同时以 adapter 或 A2A peer 方式接入：

- adapter 适合本机 CLI/SDK。
- A2A peer 适合服务化 discovery、capability 和 delegation。

两者都必须走同一权限和审计系统。
