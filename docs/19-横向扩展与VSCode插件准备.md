# 横向扩展与 VSCode 插件准备

## 定位

Runloom 需要支持横向扩展，未来可以接入 VSCode 插件、其他 IDE、CI bot、本地 daemon、团队网关和更多 UI 形态。这个能力必须从首期架构开始准备，而不是等到开发 VSCode 插件时再临时改造。

核心原则：

- `runloom-agent` 永远保持 headless，不依赖 VSCode、TUI、Web 或其他 UI SDK。
- 所有 UI 和宿主环境都通过 public API、事件流、approval bridge 和 workspace adapter 接入。
- VSCode 插件不重新实现 agent loop、工具执行、approval、session、todo 或模型协议。
- 横向扩展优先服务专业编程开发工具体验：文件、diff、terminal、git、diagnostics、测试、review 和交付摘要。

## 横向扩展目标

未来接入形态：

| 形态 | 说明 |
| --- | --- |
| TUI | 首期主入口，键盘优先的本地 coding agent |
| VSCode Extension | 后期重点扩展，提供 IDE 内 chat、diff、approval、terminal、diagnostics 集成 |
| Vue Web | 后期 Web 工作台，使用 Vue 3 + TypeScript + Vite |
| Local Daemon | 后台 runtime service，供多个 UI 或 IDE 连接 |
| CI Bot | 在 CI/PR 环境执行 review、test repair、变更摘要 |
| Other IDE | JetBrains、Neovim、Zed 等后续可通过相同 host adapter 接入 |

## Host Adapter

Runloom 需要定义宿主环境抽象：

```ts
export interface RunloomHostAdapter {
  kind: "tui" | "vscode" | "web" | "daemon" | "ci" | "custom";
  workspace: WorkspaceAdapter;
  terminal?: TerminalAdapter;
  diff?: DiffAdapter;
  notifications?: NotificationAdapter;
  approvals?: ApprovalBridge;
  diagnostics?: DiagnosticsAdapter;
  secrets?: SecretAdapter;
}
```

`runloom-agent` 调用这些抽象能力，不能直接调用 VSCode API。VSCode 插件负责把 VSCode extension host 能力适配为这些接口。

## Workspace Adapter

Workspace adapter 统一文件和 workspace 语义：

```ts
export interface WorkspaceAdapter {
  root: string;
  listFiles(query: WorkspaceFileQuery): Promise<WorkspaceFile[]>;
  readFile(path: string): Promise<WorkspaceFileContent>;
  applyPatch(patch: UnifiedPatch, options?: ApplyPatchOptions): Promise<PatchResult>;
  stat(path: string): Promise<WorkspaceFileStat>;
  getGitStatus?(): Promise<GitStatusSummary>;
}
```

要求：

- 支持本地文件系统。
- 为 VSCode multi-root workspace 预留 root selection。
- 为 VSCode virtual workspace 预留只读或受限能力。
- 文件写入仍走 Runloom approval policy。
- 不覆盖用户未保存或未提交改动。

## Terminal Adapter

Terminal adapter 统一命令执行：

```ts
export interface TerminalAdapter {
  run(command: RunloomCommand, options: TerminalRunOptions): AsyncIterable<TerminalEvent>;
}
```

VSCode 插件中可以映射到：

- VSCode integrated terminal。
- Extension host child process。
- 用户选择的 shell。

约束：

- shell 命令必须经过 permission scope，例如 `shell`。
- 命令、cwd、env 都要进入 audit trail。
- secret 和 token 输出需要 redaction。

## Diff Adapter

Diff adapter 让不同 UI 以自己的方式展示修改：

```ts
export interface DiffAdapter {
  showDiff(diff: RunloomDiffSummary, options?: ShowDiffOptions): Promise<void>;
  showPatchPreview?(patch: UnifiedPatch): Promise<DiffDecision>;
}
```

VSCode 插件中可映射到：

- VSCode diff editor。
- inline decorations。
- source control view。
- webview diff panel。

Runloom 内部仍保存统一 diff summary 和 patch record。

## Approval Bridge

Approval bridge 负责把 `approval.requested` 变成宿主环境中的交互：

```ts
export interface ApprovalBridge {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  onPolicyUpdated?(policy: ApprovalPolicyConfig): void;
}
```

VSCode 插件中可映射到：

- Quick Pick。
- Modal confirmation。
- Side panel。
- Command palette。
- Status bar pending approval。

审批方式仍支持：

- 完全访问。
- 请求批准。
- 替我决定。

宿主 UI 不能绕过 `runloom-agent` 的 approval policy。

## VSCode 插件设计准备

未来 VSCode 插件建议目录：

```text
extensions/
  runloom-vscode/
    package.json
    src/
      extension.ts
      agent/
      adapters/
        workspace-adapter.ts
        terminal-adapter.ts
        diff-adapter.ts
        approval-bridge.ts
      views/
      commands/
      webview/
      telemetry/
```

VSCode 插件职责：

- 启动或连接 `runloom-agent`。
- 提供 chat/sidebar 工作台。
- 展示 transcript、todo、tool activity、diff、测试结果和 git 状态。
- 把 VSCode workspace、terminal、diff editor、diagnostics、secrets 适配给 Runloom。
- 提供 approval UI 和权限设置 UI。
- 提供 command palette 命令。
- 监听 VSCode 文件保存、git 状态、diagnostics 变化并作为上下文信号。

VSCode 插件不负责：

- 模型 provider。
- agent loop。
- 工具权限决策。
- session store 业务逻辑。
- 自我演化。
- MCP/A2A 协议实现。

## VSCode 用户体验目标

建议命令：

- `Runloom: Open Chat`
- `Runloom: Explain Current File`
- `Runloom: Fix Selection`
- `Runloom: Review Workspace Changes`
- `Runloom: Run Tests and Fix`
- `Runloom: Show Todo`
- `Runloom: Show Diff`
- `Runloom: Approval Settings`

建议视图：

- Activity Bar: Runloom。
- Chat sidebar。
- Todo tree。
- Tool activity log。
- Approval center。
- Diff/review panel。
- Memory/proposal panel，后期可选。

建议上下文入口：

- 当前文件。
- 当前选区。
- 当前 diagnostics。
- 当前 git diff。
- 最近 terminal output。
- 当前 test failure。

## 事件桥接

VSCode 插件消费完整 `RunloomEvent`：

```text
runloom-agent event stream
  -> VSCode event bridge
  -> chat view / todo tree / diff editor / status bar / output channel
```

映射示例：

| RunloomEvent | VSCode 展示 |
| --- | --- |
| `response.output_text.delta` | Chat 流式文本 |
| `todo.updated` | Todo Tree |
| `tool.call.started` | Tool Activity |
| `coding.diff.created` | Diff Editor |
| `coding.verification.completed` | Output Channel + Problems summary |
| `approval.requested` | Approval Center |
| `approval.policy.updated` | Settings UI |

## Local Daemon 准备

为未来多 UI 同时接入，可设计 local daemon：

```text
runloom daemon
  -> exposes local HTTP/SSE or IPC
  -> owns sessions/store/events
  -> TUI, VSCode, Web can attach
```

首期不必实现 daemon，但 API 需要避免绑定单一 UI 生命周期：

- session 可恢复。
- event 可回放。
- run 可取消和恢复。
- approval 可跨 UI 处理。
- store 不依赖 TUI 进程。

## Security

VSCode 插件集成必须遵守：

- Workspace Trust。
- allowed roots。
- approval policy。
- shell command guard。
- secret redaction。
- audit trail。
- 用户未保存文件和未提交 diff 保护。

如果 VSCode workspace 不可信，默认禁用写文件、shell、external agents、自我演化和 MCP tools。

## 首期需要预留的能力

首期不实现 VSCode 插件，但 `runloom-agent` 应预留：

- `RunloomHostAdapter` 类型。
- workspace/terminal/diff/approval/diagnostics adapter 接口。
- coding events。
- event replay。
- approval policy API。
- session resume/cancel。
- 不依赖 TUI 的 runtime lifecycle。

这些能力会让后期 VSCode 插件变成“宿主适配器 + UI”，而不是重新开发一个 agent。
