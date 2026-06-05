# CI/CD 设计说明

## 目标

Runloom 的 CI/CD 要保证三个 npm 包可独立发布、类型声明完整、exports 正确、测试通过，并且发布过程有 changelog、版本和 npm provenance。

## CI 流水线

触发：

- pull request。
- push to main。

步骤：

1. Checkout。
2. Setup Node.js。
3. Enable pnpm。
4. Install dependencies with lockfile。
5. Typecheck。
6. Test。
7. Build。
8. Pack dry run。
9. Check docs links，可后续增加。
10. Check changeset，当 PR 影响 package 时。

建议 workflow：

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - run: pnpm pack:dry
```

## Package Checks

每个 package 必须检查：

- `package.json` 有 `name`、`version`、`type`、`exports`、`types`、`files`。
- ESM 输出存在。
- `.d.ts` 输出存在。
- README 存在。
- examples 存在。
- 不发布源码外的敏感文件。
- 不发布本地数据库、`.env`、`~/.runloom` 数据。

可后续增加脚本：

```bash
pnpm check:packages
```

## Release 流程

建议使用 Changesets。

开发流程：

1. PR 添加 changeset。
2. 合并到 main。
3. Changesets GitHub Action 创建 release PR。
4. release PR 更新 package versions 和 changelog。
5. 合并 release PR。
6. publish workflow 发布 npm。

## Publish Workflow

触发：

- release PR 合并后 push main。
- 或手动 workflow dispatch。

步骤：

1. Checkout。
2. Setup Node.js and pnpm。
3. Install。
4. Typecheck/test/build。
5. Pack dry run。
6. Publish with provenance。
7. Create GitHub Release。

建议使用 npm trusted publishing。如果使用 token，必须是 automation token，并放在 GitHub Actions secret。

## 版本策略

长期可以采用 linked version 或 independent version。首期只考虑 `runloom-agent` 和 `runloom-tui`，`runloom-web` 后期 Vue 实现完成后再纳入。

首期建议 linked version：

- `runloom-agent` 和 `runloom-tui` 版本一致。
- 文档和 examples 更容易维护。
- 发布节奏简单。
- `runloom-web` 首期不发布，后期 Vue 实现完成后再纳入发布策略。

稳定后可考虑 independent version：

- `runloom-agent` 可能变更更频繁。
- `runloom-tui` 和 `runloom-web` 可独立发布 UI 改进。

## Changelog

Changelog 要按包说明：

- Added。
- Changed。
- Fixed。
- Deprecated。
- Removed。
- Security。

必须标出：

- public API 变化。
- event schema 变化。
- 默认权限策略变化。
- 存储格式变化。
- provider 行为变化。
- migration notes。

## Eval Gate in CI

普通 PR：

- typecheck。
- unit tests。
- package build。

高影响 PR：

- 运行相关 eval benchmark。
- 上传 eval report artifact。
- 如果 critical case 失败，CI fail。

高影响 PR 包括：

- provider adapter。
- tool executor。
- permission/approval。
- memory/growth。
- self-evolution。
- MCP/A2A/external agent。
- release/publish。

## 安全扫描

建议增加：

- dependency audit。
- secret scan。
- package contents scan。
- license check。
- provenance。

默认不应在 CI 中使用真实模型 API key。provider 测试代码可以使用 recorded fixtures、test-only provider 和 local test server；产品构建、examples 和 demo 不使用 mock 数据。

## 发布保护

要求：

- main 分支保护。
- 至少一名 reviewer。
- release PR 必须通过 CI。
- npm publish 只在 main 执行。
- 禁止 fork PR 获取 npm token。
- package provenance 开启。
- publish 前检查 `npm pack --json` 输出。

## 回滚

发布失败：

- 如果未发布，修复后重跑。
- 如果部分包发布，按 npm version 不可覆盖原则发布 patch 修复。
- 如果严重问题，deprecate 问题版本，并发布回滚版本。

运行时演化失败：

- 通过 evolution rollback 机制禁用或恢复本地 tool/skill/prompt。
- 记录 rollback audit。
