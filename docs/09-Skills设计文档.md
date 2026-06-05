# Skills 设计文档

## 定位

Skills 用于沉淀可复用的工作方法、领域知识和流程规范。它们不是工具，不直接执行动作，而是影响 agent 如何理解任务、选择步骤、使用工具、验证结果和沟通。

Runloom 支持：

- 加载用户本地安装的 skills。
- 根据任务和上下文选择激活 skill。
- 在成长过程中提出新的 skill 或修改已有 skill。
- 对 generated skill 做校验、测试、审批和注册。

## 目录结构

```text
~/.runloom/
  skills/
    installed/
      <skill-name>/
        skill.json
        SKILL.md
        examples/
        tests/
    generated/
      <skill-name>/
        skill.json
        SKILL.md
        examples/
        tests/
```

`installed` 来自用户安装或可信来源。`generated` 来自 Runloom 自己提出并通过验证的 skill。

## Manifest

建议 `skill.json`：

```json
{
  "name": "typescript-code-review",
  "version": "0.1.0",
  "description": "Review TypeScript changes for bugs, tests, and public API risks.",
  "triggers": [
    "用户要求 review",
    "PR 修改 TypeScript 代码",
    "发布前检查"
  ],
  "requiredTools": ["fs.read", "search", "shell"],
  "permissions": {
    "readWorkspace": true,
    "writeWorkspace": false,
    "shell": "ask"
  },
  "validation": {
    "schema": "skill-manifest@1",
    "tests": ["tests/*.case.md"]
  }
}
```

`SKILL.md` 必须包含：

- 适用场景。
- 不适用场景。
- 执行步骤。
- 所需工具。
- 验证方式。
- 输出格式。
- 示例。

## 加载流程

```text
SkillRegistry.load()
  -> scan installed/generated
  -> validate manifest
  -> validate required files
  -> compute content hash
  -> mark enabled/disabled
  -> emit skills.loaded
```

加载规则：

- 同名 skill 以用户显式配置优先。
- manifest 无效则禁用并产生诊断事件。
- symlink、越界路径和可疑文件默认拒绝。
- skill 内容进入上下文前需要 redaction。

## 触发与选择

Skill 选择器输入：

- 用户输入。
- 当前 workspace 类型。
- package manifests。
- 最近任务历史。
- 已激活 memory。
- tool availability。
- 用户偏好。

输出：

```ts
export interface SkillActivation {
  skillName: string;
  version: string;
  reason: string;
  confidence: number;
  contextBudgetTokens: number;
}
```

规则：

- 低置信度 skill 不自动激活，可只作为候选。
- 高影响 skill 需要用户允许或配置白名单。
- 激活 skill 必须产生 `skill.activated` 事件。
- 同时激活多个 skill 时需要合并冲突规则。

## 上下文注入

Skill 不应完整无脑注入。建议分层：

- `summary`：短说明，总是可注入。
- `instructions`：触发后注入。
- `examples`：仅任务需要时按预算注入。
- `validation`：执行末尾用于检查。

上下文预算由 runtime 控制。skill 不能绕过 context compression。

## Skill Forge

Skill Forge 用于把稳定经验沉淀成 skill。

触发来源：

- 多次任务 reflection 出现相同经验。
- 用户明确要求“以后都这样做”。
- 某类任务重复失败后形成修正流程。
- 工具生成后需要配套使用方法。

生成流程：

```text
collect evidence
  -> draft skill manifest and SKILL.md
  -> validate schema
  -> run skill tests
  -> risk assessment
  -> create approval request
  -> install into generated if approved
  -> emit skill.generated / skill.installed
```

## 验证

每个 skill 至少验证：

- manifest schema。
- 必填文件存在。
- trigger 不过宽。
- permissions 不扩大默认权限。
- instructions 不包含越权要求。
- examples 可解析。
- tests 通过。

高影响 skill 还要进入 eval benchmark，例如权限遵守、危险操作拒绝和用户偏好遵守。

## 修改已有 Skill

修改 skill 需要 proposal：

```ts
export interface SkillChangeProposal {
  id: string;
  skillName: string;
  changeType: "create" | "update" | "disable" | "delete";
  reason: string;
  evidence: string[];
  diff: string;
  validation: ValidationResult;
  risk: RiskAssessment;
}
```

用户安装的 skill 默认不被静默修改。Runloom 只能提出 patch，经 approval 后应用。

## TUI/Web 展示

UI 需要展示：

- 已安装 skills。
- 当前任务激活的 skills。
- skill 触发原因。
- skill 权限需求。
- generated skill proposal。
- skill 验证结果。
- 启用/禁用状态。

UI 不解析 skill 目录，所有数据来自 `runloom-agent` API。
