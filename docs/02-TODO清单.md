# TODO 清单

本文档是 Runloom 的实现路线图。状态约定：

- `[ ]` 未开始。
- `[~]` 进行中。
- `[x]` 完成。
- `[!]` 需要设计确认或风险较高。

## Phase 0：项目骨架与发布底座

- [ ] 创建 monorepo 根配置：`package.json`、workspace、TypeScript、lint、test、build。
- [ ] 创建 `packages/runloom-agent`、`packages/runloom-tui`。
- [ ] 预留 `runloom-web` 设计文档和包边界说明，但不进入首期实现和发布。
- [ ] `runloom-agent`、`runloom-tui` 补齐独立 `package.json`、`README.md`、`src/index.ts`、`examples/`。
- [ ] `runloom-agent`、`runloom-tui` 输出 ESM 和 `.d.ts`。
- [ ] `runloom-agent`、`runloom-tui` 配置 `exports`，禁止用户依赖内部路径。
- [ ] 建立 Changesets 或等价版本管理。
- [ ] 建立 GitHub Actions：typecheck、test、build、pack、publish dry run。
- [ ] 建立 changelog 和 release checklist。

验收标准：

- `npm pack --dry-run` 对首期发布包均可通过。
- 从临时 Node.js 项目 import `runloom-agent`、`runloom-tui` 的 public API 不报错。
- CI 能在干净环境完成 typecheck/test/build。

## Phase 1：runloom-agent 最小 runtime

- [ ] 定义 public API：`createRunloomAgent`、`RunloomAgent`、`RunloomEvent`、`ModelProvider`、`ToolDefinition`。
- [ ] 实现 session、run、message、event 基础 store。
- [ ] 接入至少一个真实模型协议 adapter，保证最小 runtime 不依赖 mock 数据。
- [ ] 测试代码可提供 test-only provider，覆盖文本输出、tool call 和错误注入。
- [ ] 实现最小动态 loop：submit、subscribe、cancel、resume。
- [ ] 实现 todo store 和 `todo.updated` 事件。
- [ ] 实现基础工具注册和工具执行器。
- [ ] 实现 approval request/resolution。
- [ ] 实现 approval policy：完全访问、请求批准、替我决定三种模式。
- [ ] 支持按 permission scope 修改审批模式，并写入 audit trail。
- [ ] 实现 workspace path guard 和 redaction 初版。
- [ ] 实现错误类型和结构化日志接口。
- [ ] 实现 coding task 基础上下文：workspace 摘要、package 信息、git 状态和用户未提交变更提示。
- [ ] 预留横向扩展接口：workspace、terminal、diff、approval、diagnostics host adapters。

验收标准：

- 示例代码可以提交“阅读 package.json 并总结项目”。
- 测试代码覆盖文本、工具调用、approval 和取消；产品示例不使用 mock 数据。
- 所有 UI 事件都来自 `runloom-agent`。

## Phase 1.5：专业编程开发闭环

- [ ] 文件工具：list/read/search/write/patch，全部受 workspace guard 和 approval policy 控制。
- [ ] Diff 工具：生成、展示和记录 unified diff。
- [ ] Shell 验证工具：运行用户或项目配置的 typecheck/test/build 命令。
- [ ] Git 感知：读取 `git status`、当前分支、未提交 diff 和冲突风险。
- [ ] 代码修改计划：高风险修改前生成 edit plan，说明目标文件、风险和验证命令。
- [ ] 用户改动保护：修改前检测目标文件是否已有用户未提交变更，避免覆盖。
- [ ] Review 模式：支持用户要求 code review 时优先输出 bug、风险和缺失测试。
- [ ] 最终交付摘要：输出修改文件、核心变更、验证结果、失败项和剩余风险。

验收标准：

- Runloom 能完成一个真实小型 TypeScript 项目的“读代码 -> 改文件 -> 跑测试 -> 总结”闭环。
- 所有文件写入和 shell 命令进入 approval policy。
- 每次修改都有 diff、证据和可回滚线索。
- 不覆盖用户已有改动。

## Phase 2：pi-agent 集成

- [ ] 封装 `PiAgentLoopDriver`。
- [ ] 实现 `PiModelBridge`，隐藏 pi-agent/pi-ai 原始类型。
- [ ] 实现 `PiToolBridge`，确保工具调用先进入 Runloom security/approval/trace。
- [ ] 实现 `PiEventAdapter`，转换为 `RunloomEvent`。
- [ ] 提供 driver 切换能力：生产使用 pi driver，测试代码可使用 test-only driver。
- [ ] 增加 integration tests。

验收标准：

- public API 不泄露 pi-agent 类型。
- pi-agent 运行时产生的文本、tool、todo、error 均能转换为 Runloom 事件。

## Phase 2.5：横向扩展与 VSCode 插件准备

- [ ] 定义 `RunloomHostAdapter`。
- [ ] 定义 `WorkspaceAdapter`，支持未来 VSCode multi-root 和 virtual workspace。
- [ ] 定义 `TerminalAdapter`，隔离 shell 执行与宿主 terminal。
- [ ] 定义 `DiffAdapter`，支持未来 VSCode diff editor 和 inline diff。
- [ ] 定义 `ApprovalBridge`，支持跨 UI 处理 approval。
- [ ] 定义 `DiagnosticsAdapter`，为 VSCode Problems/diagnostics 预留上下文入口。
- [ ] 设计 future `extensions/runloom-vscode` 目录，不进入首期实现。
- [ ] 确保 `runloom-agent` 不依赖 VSCode API、TUI API 或 Web API。

验收标准：

- `runloom-agent` 可以在没有 TUI 的情况下通过 host adapter 生命周期运行。
- VSCode 插件未来只需要实现 adapters 和 UI，不需要重写 runtime。
- approval、event replay、session resume/cancel 均不绑定单一 UI。
- 首期仓库没有半成品 VSCode extension runtime。

## Phase 3：模型协议适配

- [ ] OpenAI-compatible Chat Completions adapter。
- [ ] OpenAI Responses adapter。
- [ ] Anthropic Claude Messages adapter。
- [ ] Google Gemini adapter。
- [ ] 统一 messages、tools、tool calls、streaming、usage、reasoning、structured output。
- [ ] provider retry、timeout、rate limit 和 error normalization。
- [ ] provider compatibility tests。

验收标准：

- 同一组 Runloom messages/tools 可以投递给四类协议。
- 四类协议的 tool call 都转换为同一 `ToolCallRequestedEvent`。
- usage 和 error code 可被 UI/API 统一展示。

## Phase 4：TUI 最小产品

- [ ] CLI bin：`runloom`。
- [ ] 嵌入式 TUI API：`createRunloomTuiApp`。
- [ ] transcript 区、输入区、todo 区、tool activity 区、status 区。
- [ ] coding activity 展示：文件读取、patch、diff、测试命令、git 状态。
- [ ] approval 弹窗。
- [ ] `/permissions` 权限审批设置面板。
- [ ] 基础命令：`/help`、`/status`、`/model`、`/session`、`/todo`、`/diff`、`/git`、`/tests`、`/review`、`/skills`、`/mcp`、`/stop`、`/resume`、`/quit`。
- [ ] 事件回放和滚动。

验收标准：

- TUI 不 import `runloom-agent/src/*` 内部路径。
- TUI 只通过 public API 和事件工作。
- approval 可以在 TUI 中完成并恢复 run。
- 用户可以在 TUI 中修改权限审批模式。

## Phase 5：runloom-web 暂缓

- [ ] 首期不实现 `runloom-web`。
- [ ] 首期不发布 `runloom-web` npm 包。
- [ ] 保留 Web 设计文档、API 边界和后期验收标准。
- [ ] 明确后期技术栈：Vue 3 + TypeScript + Vite。
- [ ] 后期 Web 必须复用 `runloom-agent`，不重新实现 runtime。

验收标准：

- 首期代码中没有半成品 Web runtime。
- Web 需求不阻塞 `runloom-agent` 和 `runloom-tui` 发布。
- Web 后期实现前，文档保持 Vue 技术路线和 API 边界。

## Phase 6：Skills 与 MCP

- [ ] Skill manifest schema。
- [ ] 加载 `~/.runloom/skills/installed` 和 `generated`。
- [ ] skill 触发选择器。
- [ ] skill 上下文注入和事件。
- [ ] Skill Forge proposal、验证和 approval。
- [ ] MCP client：tools/resources/prompts discovery。
- [ ] MCP server：暴露 Runloom tools、skills、memory query、agent service。
- [ ] MCP 工具调用进入统一 approval/audit/trace。

验收标准：

- skill 能被激活并影响当前执行。
- MCP server 工具调用不会绕过 Runloom 权限。
- generated skill 未经验证和 approval 不能进入 installed/active。

## Phase 7：外部 agent 与 A2A

- [ ] `ExternalAgentAdapter` 接口。
- [ ] Codex adapter。
- [ ] Claude Code adapter。
- [ ] 其他本地 coding agent adapter 扩展点。
- [ ] 外部委托的 workspace、权限、最大轮数、输出格式限制。
- [ ] 委托事件、日志和 audit trail。
- [ ] A2A discovery、capability、delegation、result exchange。

验收标准：

- 外部 agent 不作为 `ModelProvider` 注册。
- 每次委托都有 approval、trace、audit 和可回放事件。
- 外部 agent 结果能进入 Runloom 上下文并被主 loop 继续处理。

## Phase 8：本地成长层

- [ ] 初始化 `~/.runloom` 目录结构。
- [ ] identity 文件：`soul.md`、`thinking.md`、`user-preferences.md`、`lessons.md`。
- [ ] episodic memory store。
- [ ] semantic memory store。
- [ ] reflection runner。
- [ ] memory curation。
- [ ] preference learning proposal。
- [ ] identity update proposal 和审批。

验收标准：

- 任务结束后可以生成 reflection。
- 具体经历不会无筛选地污染长期上下文。
- 修改关键 identity 文件必须产生 proposal 和 approval。

## Phase 9：Tool Forge、Skill Forge、自我演化与 Eval Gate

- [ ] Tool Forge 生成 `tool.json`、`tool.ts`、`README.md`、`tests/`。
- [ ] 工具 schema 校验、测试、权限分析和 sandbox 验证。
- [ ] 工具注册 proposal 和 rollback metadata。
- [ ] self-improvement proposal。
- [ ] code modification plan。
- [ ] eval benchmark runner。
- [ ] baseline/candidate score 对比。
- [ ] accepted/rejected 状态机。
- [ ] 升级和回滚。

验收标准：

- 新工具、新 skill、自我代码修改都必须通过 eval gate。
- 未达阈值的演化结果进入 rejected。
- accepted 结果具备完整来源、证据、风险、日志和回滚方式。

## Phase 10：runloom-web Vue 实现（后期）

- [ ] 创建 `packages/runloom-web`。
- [ ] 使用 Vue 3 + TypeScript + Vite。
- [ ] `createRunloomWebServer`。
- [ ] HTTP API：session、submit、events、approvals、todos。
- [ ] HTTP API：approval-policy 读取和修改。
- [ ] SSE 事件流。
- [ ] 可选 WebSocket。
- [ ] Vue 组件：Transcript、TodoPanel、ToolActivity、ApprovalDialog、ApprovalPolicySettings、SessionList。
- [ ] 可嵌入 server 挂载。
- [ ] 独立 README、examples、exports、types 和 npm 发布配置。

验收标准：

- Web server 复用 `runloom-agent`，不重新实现 runtime。
- Vue 前端刷新后可恢复 session 和事件。
- approval 弹窗能驱动 agent 继续执行。
- Web 可以修改权限审批方式，并展示策略变更审计。
- `runloom-web` 可独立 build、typecheck、pack dry run。

## Phase 11：VSCode 插件实现（后期）

- [ ] 创建 `extensions/runloom-vscode`。
- [ ] 使用 VSCode Extension API + TypeScript。
- [ ] 实现 workspace、terminal、diff、approval、diagnostics adapters。
- [ ] 提供 Runloom sidebar/chat view。
- [ ] 提供 Todo Tree、Tool Activity、Approval Center。
- [ ] 集成 VSCode diff editor、Problems、integrated terminal、command palette。
- [ ] 支持命令：Open Chat、Fix Selection、Review Workspace Changes、Run Tests and Fix、Show Diff、Approval Settings。
- [ ] 支持 Workspace Trust，未信任 workspace 默认禁用写文件、shell、MCP tools 和自我演化。

验收标准：

- VSCode 插件只调用 `runloom-agent` public API。
- VSCode 插件不重新实现模型、工具、session、approval 或 agent loop。
- VSCode 中的文件写入、shell、diff、approval 都可审计和回放。

## 长期验收标准

- Runloom 能稳定执行多轮本地 coding 任务。
- 用户首期可以选择 TUI 或自定义 Node.js 应用接入，后期可以选择 Vue Web 接入。
- 已发布 npm 包 public API 清晰稳定，README 和 examples 足以独立使用；`runloom-web` 后期发布时遵守同等标准。
- 模型、工具、Skills、MCP、A2A、外部 agent 都受统一事件、权限、审批和审计约束。
- 自我成长不是静默修改，而是可解释、可验证、可批准、可回滚的工程过程。
