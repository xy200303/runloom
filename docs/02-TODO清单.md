# TODO 清单

本文档是 Runloom 的实现路线图。状态约定：

- `[ ]` 未开始。
- `[~]` 进行中。
- `[x]` 完成。
- `[!]` 需要设计确认或风险较高。

## Phase 0：项目骨架与发布底座

- [x] 创建 monorepo 根配置：`package.json`、workspace、TypeScript、test、build。
- [x] 创建 `packages/runloom-agent`、`packages/runloom-tui`。
- [x] 预留 `runloom-web` 设计文档和包边界说明，但不进入首期实现和发布。
- [x] `runloom-agent`、`runloom-tui` 补齐独立 `package.json`、`README.md`、`src/index.ts`、`examples/`。
- [x] `runloom-agent`、`runloom-tui` 输出 ESM 和 `.d.ts`。
- [x] `runloom-agent`、`runloom-tui` 配置 `exports`，禁止用户依赖内部路径。
- [x] 增加 Vitest 分层测试配置：unit、integration、contract、security、e2e 和 shared config。
- [x] 默认测试脚本接入 unit tests，并保留现有 Node.js 集成测试入口。
- [x] 增加首批 Vitest unit、integration、contract、security、e2e 测试样例。
- [x] 建立 lint 配置和脚本。
- [x] 建立 Changesets 或等价版本管理。
- [x] 建立 GitHub Actions：typecheck、test、build、pack、publish dry run。
- [x] 建立 changelog 和 release checklist。

验收标准：

- `npm pack --dry-run` 对首期发布包均可通过。
- 从临时 Node.js 项目 import `runloom-agent`、`runloom-tui` 的 public API 不报错。
- CI 能在干净环境完成 typecheck/test/build。

## Phase 1：runloom-agent 最小 runtime

- [x] 定义 public API：`createRunloomAgent`、`RunloomAgent`、`RunloomEvent`、`ModelProvider`、`ToolDefinition`。
- [x] 实现 session、run、message、event 基础 store：已支持 in-memory 查询和 `stateDir` workspace 文件持久化。
- [x] 接入至少一个真实模型协议 adapter，保证最小 runtime 不依赖 mock 数据。
- [x] 测试代码可提供 test-only provider，覆盖文本输出、tool call 和错误注入。
- [x] 实现最小动态 loop：已实现 submit、subscribe、active run cancel、同进程 resume、approval 后续接续和 `stateDir` 持久化 run 恢复。
- [x] 实现 todo store 和 `todo.updated` 事件。
- [x] 实现基础工具注册和工具执行器。
- [x] 实现 approval request/resolution。
- [x] 实现 approval policy：完全访问、请求批准、替我决定三种模式。
- [x] 支持按 permission scope 修改审批模式，并写入 audit trail。
- [x] 实现 `~/.runloom/config.json` 全局配置读取，支持默认模型、provider 偏好和非敏感用户偏好。
- [x] 支持 workspace `.runloom/config.json` 覆盖全局配置，但禁止在仓库配置中保存 secret。
- [x] 实现任务画像模型路由：前端设计、Go 开发、原型设计、代码审查和测试修复可以命中不同模型。
- [x] 产生 `model.selection.resolved` 事件，记录 provider、model、命中规则和选择原因。
- [x] 实现 workspace path guard 和 redaction 初版。
- [x] 实现错误类型和结构化日志接口。
- [x] 实现 coding task 基础上下文：workspace 摘要、package 信息、git 状态和用户未提交变更提示。
- [x] 预留横向扩展接口：workspace、terminal、diff、approval、diagnostics host adapters。

验收标准：

- 示例代码可以提交“阅读 package.json 并总结项目”。
- 测试代码覆盖文本、工具调用、approval 和取消；产品示例不使用 mock 数据。
- 所有 UI 事件都来自 `runloom-agent`。

## Phase 1.5：专业编程开发闭环

- [x] 文件工具：list/read/search/write/patch，全部受 workspace guard 和 approval policy 控制。
- [x] Diff 工具：已实现 `diff.text`、`git.diff`、成熟 diff 库生成 patch、持久化 diff record 与宿主 diff adapter 展示。
- [x] Shell 验证工具：运行用户或项目配置的 typecheck/test/build 命令。
- [x] Git 感知：读取 `git status`、当前分支、未提交 diff 和冲突风险。
- [x] 代码修改计划：高风险修改前生成 edit plan，说明目标文件、风险和验证命令。
- [x] 用户改动保护：修改前检测目标文件是否已有用户未提交变更，避免覆盖。
- [x] Review 模式：已支持任务推断、TUI `/review` code_review 路由、专用 review 输出模板与结构化 findings 记录。
- [x] 最终交付摘要：输出修改文件、核心变更、验证结果、失败项和剩余风险。

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

- [x] 定义 `RunloomHostAdapter`。
- [x] 定义 `WorkspaceAdapter`，支持未来 VSCode multi-root 和 virtual workspace。
- [x] 定义 `TerminalAdapter`，隔离 shell 执行与宿主 terminal。
- [x] 定义 `DiffAdapter`，支持未来 VSCode diff editor 和 inline diff。
- [x] 定义 `ApprovalBridge`，支持跨 UI 处理 approval。
- [x] 定义 `DiagnosticsAdapter`，为 VSCode Problems/diagnostics 预留上下文入口。
- [x] 设计 future `extensions/runloom-vscode` 目录，不进入首期实现。
- [x] 确保 `runloom-agent` 不依赖 VSCode API、TUI API 或 Web API。

验收标准：

- `runloom-agent` 可以在没有 TUI 的情况下通过 host adapter 生命周期运行。
- VSCode 插件未来只需要实现 adapters 和 UI，不需要重写 runtime。
- approval、event replay、session resume/cancel 均不绑定单一 UI。
- 首期仓库没有半成品 VSCode extension runtime。

## Phase 3：模型协议适配

- [x] OpenAI-compatible Chat Completions adapter。
- [x] OpenAI Responses adapter。
- [x] Anthropic Claude Messages adapter。
- [x] Google Gemini adapter。
- [ ] 统一 messages、tools、tool calls、streaming、usage、reasoning、structured output。
- [x] provider retry、timeout、rate limit 和 error normalization。
- [x] 模型选择层不读取 provider secret，只解析 `.runloom` 中的非敏感路由配置。
- [x] provider compatibility tests：已覆盖 OpenAI Responses、Chat Completions、Claude Messages 和 Gemini contract。

验收标准：

- 同一组 Runloom messages/tools 可以投递给四类协议。
- 四类协议的 tool call 都转换为同一 `ToolCallRequestedEvent`。
- usage 和 error code 可被 UI/API 统一展示。

## Phase 4：TUI 最小产品

- [x] CLI bin：`runloom`。
- [x] 嵌入式 TUI API：`createRunloomTuiApp`。
- [~] transcript 区、输入区、todo 区、tool activity 区、status 区：已建立命令式 view-state panel、焦点切换和面板滚动；仍需完整全屏布局。
- [~] coding activity 展示：已通过命令展示 diff、测试命令、git 状态、todo 和 activity panel；仍需完整 activity panel 交互。
- [~] approval 弹窗：已实现 Approval Center、`/approvals view`、`/approve` remember/mode 选项、`/deny` reason 命令式处理；仍需弹窗/快捷键 UI。
- [~] `/permissions` 权限审批设置面板：已实现完整 scope 表和 `/permissions set` 命令式修改；仍需全屏设置 UI。
- [x] 基础命令：已实现 `/help`、`/status`、`/view`、`/transcript`、`/activity`、`/focus`、`/scroll`、`/replay`、`/permissions`、`/permissions set`、`/approval`、`/approvals`、`/approvals view`、`/approve`、`/deny`、`/tools`、`/model`、`/session`、`/todo`、`/diff`、`/review`、`/git`、`/tests`、`/stop`、`/resume`、`/skills`、`/mcp`、`/quit`。
- [~] 事件回放和滚动：已支持 `/replay` 从 stored events 重建面板，并支持 `/focus`、`/scroll` 命令式面板滚动；仍需键盘快捷键滚动。

验收标准：

- TUI 不 import `runloom-agent/src/*` 内部路径。
- TUI 只通过 public API 和事件工作。
- approval 可以在 TUI 中完成并恢复 run。
- 用户可以在 TUI 中修改权限审批模式。

## Phase 5：runloom-web 暂缓

- [x] 首期不实现 `runloom-web`。
- [x] 首期不发布 `runloom-web` npm 包。
- [x] 保留 Web 设计文档、API 边界和后期验收标准。
- [x] 明确后期技术栈：Vue 3 + TypeScript + Vite。
- [x] 后期 Web 必须复用 `runloom-agent`，不重新实现 runtime。

验收标准：

- 首期代码中没有半成品 Web runtime。
- Web 需求不阻塞 `runloom-agent` 和 `runloom-tui` 发布。
- Web 后期实现前，文档保持 Vue 技术路线和 API 边界。

## Phase 6：Skills 与 MCP

- [x] 定义 Skills/MCP public list/register API，供 TUI、Web、VSCode 等 host 横向复用。
- [x] TUI 支持 `/skills`、`/mcp` 展示当前真实注册状态；默认不注入产品 mock 数据。
- [x] Skill manifest schema。
- [x] 加载 `~/.runloom/skills/installed` 和 `generated`。
- [x] skill 触发选择器。
- [x] skill 上下文注入和事件。
- [x] Skill Forge proposal、验证和 approval。
- [x] MCP client：tools/resources/prompts discovery。
- [x] MCP server：暴露 Runloom tools、skills、memory query、agent service。
- [x] MCP 工具调用进入统一 approval/audit/trace。

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
- 用户可以在 `~/.runloom` 中配置默认模型，并为前端设计、Go 开发、原型设计等任务配置不同模型。
- 单元测试覆盖 config/model routing/provider/tool/security/event/store；集成测试覆盖真实 workspace、TUI 命令、状态目录、provider fixture 和 pack dry run。
- 自我成长不是静默修改，而是可解释、可验证、可批准、可回滚的工程过程。
