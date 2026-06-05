# MCP 设计文档

## 定位

MCP 用于接入外部工具、资源和 prompts 生态。Runloom 应同时支持：

- 作为 MCP client 连接外部 MCP server。
- 作为 MCP server 暴露自己的本地工具、skills、memory 查询和 agent 能力。

MCP 工具调用必须进入统一 approval、audit trail、trace 和事件系统，不能绕过 Runloom 的权限护栏。

## 本地配置

```text
~/.runloom/
  mcp/
    servers.json
```

示例：

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true,
      "permissions": {
        "tools": "ask",
        "resources": "allow",
        "prompts": "allow"
      }
    }
  }
}
```

## MCP Client

职责：

- 加载 server 配置。
- 建立 transport。
- discovery tools/resources/prompts。
- 将 MCP tools 映射为 Runloom `ToolDefinition`。
- 将 MCP resources 映射为可检索上下文资源。
- 将 MCP prompts 映射为可选 prompt fragments。
- 处理连接状态、重连、超时和错误。

工具映射：

```text
MCP tool
  -> Runloom ToolDefinition
  -> PermissionPolicy check
  -> Approval if needed
  -> ToolExecutor
  -> MCP callTool
  -> normalize result
  -> emit tool events
```

## MCP Tool 命名

为了避免冲突，MCP 工具在 Runloom 内部命名为：

```text
mcp.<serverName>.<toolName>
```

展示层可显示短名称，但 audit trail 必须记录完整名称和 server id。

## MCP Resources

Resources 读取流程：

```text
select resource
  -> permission check
  -> readResource
  -> redaction
  -> context budget check
  -> inject or summarize
```

资源不应自动全部进入上下文。模型可以请求读取，或 skill/prompt 策略可建议读取，但 runtime 负责预算和权限。

## MCP Prompts

Prompts 处理原则：

- prompt 不是 system prompt 的最高优先级。
- 外部 prompt 需要标明来源。
- prompt 内容需要 redaction 和 prompt-injection 风险检查。
- 高影响 prompt 需要 approval 或白名单。

## MCP Server

Runloom 作为 MCP server 时，可暴露：

- 本地安全工具。
- skill 列表和读取。
- memory query。
- eval benchmark list/run。
- agent delegation capability。
- session summary。

暴露原则：

- 默认只监听 localhost。
- 默认只读。
- 高影响工具默认 disabled 或 ask。
- 外部调用也要创建 audit trail。

建议能力：

```text
tools/list
tools/call
resources/list
resources/read
prompts/list
prompts/get
```

## 权限模型

MCP 权限包含两层：

- server 级：是否启用、transport、可访问 roots、环境变量 allowlist。
- tool/resource/prompt 级：allow、ask、deny。

策略示例：

```ts
export interface McpPermissionPolicy {
  serverName: string;
  tools: "allow" | "ask" | "deny";
  resources: "allow" | "ask" | "deny";
  prompts: "allow" | "ask" | "deny";
  allowedToolNames?: string[];
  deniedToolNames?: string[];
}
```

## 事件

MCP 相关事件：

- `mcp.server.connected`
- `mcp.server.disconnected`
- `mcp.discovery.completed`
- `mcp.tool.registered`
- `mcp.tool.call.requested`
- `mcp.tool.call.completed`
- `mcp.resource.read`
- `mcp.prompt.activated`
- `mcp.error`

UI 通过事件展示状态，不直接访问 MCP SDK。

## 安全风险

风险：

- MCP server 暴露危险工具。
- prompt injection。
- resource 泄露 secret。
- stdio server 运行未受信命令。
- 工具 schema 过宽。

控制：

- 默认 ask。
- server 配置需要显式启用。
- command allowlist。
- workspace/path guard。
- redaction。
- schema validation。
- trace 和 audit。
- high risk 工具需要二次确认。

## 测试

需要覆盖：

- stdio server discovery。
- tool schema mapping。
- resource read permission。
- prompt activation redaction。
- server disconnect/reconnect。
- malicious server fixture。
- approval denied path。
- audit record completeness。
