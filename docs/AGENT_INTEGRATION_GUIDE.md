# Agent 接入指南（agent-link 跨项目协作）

> 面向：任何新项目的 Agent / 开发者。
> 目标：**不需要了解 agent-link 内部实现**，仅按本文档即可完成接入、提交任务、接收 GPT 决策并继续执行。
>
> 文档状态：基于仓库真实代码与本机真实演练编写。
> 最后验证：2026-10-21，使用 `example-project` 完成跨进程接入演练（真实值见第 9 节）。
> 如代码变更，请同步更新本文档并运行 `node test/agent_integration_doc_test.mjs` 校验。

---

## 1. 系统用途与协作流程

`agent-link` 是**跨项目任务协作与消息中转机制**，不是业务框架：

- **GPT**：阅读 Agent 提交的报告，给出决策（继续/完成/阻塞）。
- **协调器（agent-link）**：负责任务登记、项目路由、消息转发、状态持久化、上下文耗尽后的对话交接与恢复。它**不替 GPT 做业务判断**。
- **项目 Agent（你）**：领取任务、在**自己的项目目录**内执行工作、提交带证据的结构化报告；收到 GPT 决策后继续执行。

你不需要自己设计协作协议，只需：

1. 按第 3 节使用真实 MCP 工具；
2. 按第 5 节模板提交报告；
3. 按 GPT 决策继续，直到任务闭环。

**上下文耗尽时**：协调器检测到真实耗尽（如“聊天上下文已用完/在新聊天中继续”）后，会保全输入框中的未发送报告、自动新建可用对话、交接全局状态与原报告、读取 GPT 决策并回传；不确定是否发送成功时**不会自动重发**，而是独立读回确认。

**已实现/未实现**（详见第 8 节）：多项目路由、MCP 领取/查询/回报、报告转发与决策解析、上下文耗尽恢复已实现；**没有“创建任务”的 MCP 工具**（任务通过 HTTP 入口创建）；`agentCommand=null`，执行仅限白名单 `node_check` / `run_project_tests`。

---

## 2. 新项目首次接入步骤

以下步骤均可直接照做（以 `example-project` 为例）。

### 步骤 1：确认 agent-link MCP 服务可用

宿主 MCP 配置见 `test/mcp.register.json`：

```json
{
  "mcpServers": {
    "agent-link": {
      "type": "stdio",
      "command": "node",
      "args": [
        "<repo>/test/mcp_server.mjs",
        "--projects", "<repo>/test/projects.json",
        "--token-file", "<repo>/test/service/token.txt"
      ]
    }
  }
}
```

确认服务可用：调用 `initialize` 应返回 `serverInfo.name = "agent-web-link"`。

### 步骤 2：让宿主发现并读取真实工具 schema

对 MCP 服务发送 JSON-RPC `tools/list`（stdio，换行分隔 JSON），即可获得**真实 schema**。当前共 6 个工具：

- `agent_link_list_projects`（发现项目与健康状态，只读）
- `agent_link_list_tasks`（按项目列任务，只读，可按 phase 过滤）
- `agent_link_list_reports`（按项目列已产出报告，只读，含摘要）
- `agent_link_claim_next_task`
- `agent_link_get_task`
- `agent_link_submit_result`

> **兼容性提示（升级自 3 工具版本时必读）**：
> 1. 工具数量从 3 → 6，若宿主/脚本对 `tools/list` 数量做硬断言需要同步更新；
> 2. 服务器现在**强制校验工具入参**（按 inputSchema）：缺必填、类型不符、未知参数一律返回
>    JSON-RPC `-32602`，不再透传给服务层；
> 3. 服务器强制**生命周期状态机**：`initialize` 必须是首个请求，初始化完成前除 `ping` 外的请求
>    返回 `-32002`，重复 `initialize` 返回 `-32600`；
> 4. 新工具（`list_*`）需**重启宿主 MCP 会话**后才会出现在 `tools/list`（stdio 进程启动时加载）。

> 不要假设存在 `agent_link_create_task`——**没有**创建任务的 MCP 工具（见步骤 6）。

### 步骤 3：注册新项目并配置真实根目录与隔离状态目录

编辑 `<repo>/test/projects.json`，追加：

```json
{
  "name": "example-project",
  "config": "example-project.config.json"
}
```

`config` 为相对 `projects.json` 的路径（或绝对路径）。对应配置文件 `<repo>/test/example-project.config.json`：

```json
{
  "schemaVersion": 1,
  "name": "example-project",
  "projectRoot": "<another-project>",
  "projectTests": [],
  "agentCommand": null,
  "paths": { "stateDir": ".agent-link/state", "tasksDir": ".agent-link/tasks" }
}
```

规则（由 `test/project_config.mjs` 强制）：

- `projectRoot` 必须是**真实存在**的绝对路径（不存在 → 配置非法）。
- `stateDir` / `tasksDir` 必须位于 `projectRoot` 内（越界 → 配置非法）。
- 建议使用独立目录（如 `.agent-link/`）隔离任务状态，避免污染业务仓库。
- `projectTests` 为空、`agentCommand=null` 时，仅可执行 `node_check`（对 `projectRoot` 内 `.js/.mjs/.cjs` 做语法检查）。

### 步骤 4：重启 MCP 会话并确认新配置已加载

MCP 为 **stdio 长驻进程，配置在启动时加载**。修改 `projects.json` 后**必须重启宿主 MCP 会话**（`mcp.register.json` 已传 `--projects`，无需改启动参数）。

确认是否加载：

- 调用 `agent_link_get_task`，`project` 填新项目名，`taskId` 填任意不存在值：
  - 返回 `TASK_NOT_FOUND` → **已加载**；
  - 返回 `UNKNOWN_PROJECT` → **未加载**（仍是旧配置，需重启）。

真实对照（2026-10-21）：重启前旧进程返回 `UNKNOWN_PROJECT`；新进程返回 `TASK_NOT_FOUND`。

### 步骤 5：确认项目身份、登记簿与执行目录一致

- 调用 `agent_link_claim_next_task { project: "example-project" }`（无任务时返回 `task: null`）；
- 成功后检查 `task.project === "example-project"`；
- 登记簿应位于 `<another-project>/.agent-link/tasks/registry.json`，报告位于同目录 `reports/<taskId>.json`；
- 不应在 `<repo>/test/tasks/` 出现该项目任务。

出现 `PROJECT_ROUTE_MISMATCH` 表示任务归属与执行项目不一致，必须停止并核查，**不得绕过**。

### 步骤 6：创建一项无业务副作用的验证任务

**没有创建任务的 MCP 工具**。真实入口为本地服务 HTTP `POST /v1/tasks`（仅回环地址，需 `X-Auth-Token`）：

- 令牌文件：`<repo>/test/service/token.txt`（首行即令牌）。
- 启动本地服务：`node test/local_service.mjs --port 8787`（默认会执行 worker 任务；如只登记不执行，加 `--queue-only`）。
- 创建 agent 模式任务（由 Agent 领取执行，本地 Worker 不执行）：

```bash
curl -s -X POST http://127.0.0.1:8787/v1/tasks \
  -H "content-type: application/json" \
  -H "x-auth-token: <token.txt 内容>" \
  -d '{"project":"example-project","taskId":"onboard-1","summary":"接入演练（无副作用）","mode":"agent"}'
```

返回（真实结构）：

```json
{ "ok": true, "taskId": "onboard-1", "project": "example-project", "phase": "NEW", "execution": "agent", "queuePosition": null }
```

> 适用条件：调用方与本机服务同机（回环），且能读取服务令牌文件。
> 若你只有 MCP 通道、无法访问 HTTP 入口：**不能自行创建任务**，需由操作者/协调器创建后，你通过 `agent_link_claim_next_task` 领取。

### 步骤 7：完成认领、报告提交、GPT 决策回传与验收

1. 认领：调用 `agent_link_claim_next_task { project: "example-project" }` → `task.taskId`。
2. 执行：在 `projectRoot` 内完成实际工作（遵守白名单；不得越界）。
3. 提交：调用 `agent_link_submit_result`（`project`、`taskId`、`ok`、非空 `evidence`）。
4. 报告交给协调器转发 GPT（见第 5 节模板）；等待 GPT 决策。
5. 收到决策后按 `CONTINUE/COMPLETE/BLOCKED` 处理；`COMPLETE` 仅代表本任务或指定阶段，**不代表整个互联项目完成**。

### 步骤 8：常见错误排查

| 错误码 | 含义 | 处理 |
|---|---|---|
| `UNKNOWN_PROJECT` | 项目未注册（或 MCP 未加载新配置） | 检查 `projects.json`；重启 MCP；用步骤 4 验证 |
| `PROJECT_CONFIG_INVALID` | 项目配置非法（JSON/字段/路径） | 按 `project_config.mjs` 规则修正 |
| `PROJECT_ROOT_MISSING` | `projectRoot` 不存在 | 填真实路径；不要猜路径 |
| `PROJECT_ROOT_INVALID` | `projectRoot` 不是目录 | 修正配置 |
| `PROJECT_ROUTE_MISMATCH` | 任务归属与项目/执行器根不一致 | 停止，核查登记簿与配置，禁止绕过 |
| `TASK_NOT_FOUND` | 该项目的登记簿中无此 `taskId` | 核对 `project` 与 `taskId`；勿跨项目查找 |
| `INVALID_STATE` | 任务 phase 不允许提交结果 | 先 `claim`（NEW/RUNNING 才可提交） |
| `EVIDENCE_REQUIRED` | 证据为空 | 提供非空 `evidence` |
| `UNAUTHORIZED` | HTTP 缺少/错误令牌 | 使用 `test/service/token.txt` |

---

## 3. MCP 工具的实际使用方法

传输：stdio，JSON-RPC 2.0，换行分隔。生命周期：先 `initialize`（服务器返回协商版本 + `instructions`），
客户端回 `notifications/initialized`，此后才可 `tools/list` / `tools/call`。
所有工具入参按 `inputSchema` 严格校验（缺必填/类型错误/未知参数/enum/数值范围/字符串长度 → `-32602`）；
工具业务失败以 `result.isError=true` 返回（双通道错误机制）。
**结构化输出版本约定**：`outputSchema` 随 `tools/list` 对所有版本可见；但 `result.structuredContent`
仅在协商到 `2025-06-18` 及以上时返回，旧版本客户端只读 `content[0].text`（两者内容等价）。
**`content[0].text` 恒为 JSON 字符串**（`JSON.parse` 即得结果对象），不要按人类可读文本处理。
另：`claim/get/submit` 三工具的 `outputSchema` 未加 `additionalProperties:false`，是为 task/report
形状不完全可控的**刻意放宽**（list 两工具为严格白名单）。

**MCP 错误码映射约定**：工具/资源读取的业务失败以 `result.isError=true` 返回；协议层失败
（未知工具/参数校验/生命周期/资源不存在或超限）为 JSON-RPC `error`，其中资源读取失败**统一映射为
`-32602`**，消息前缀携带稳定服务层 code（如 `REPORT_TOO_LARGE`、`UNKNOWN_PROJECT`、
`REGISTRY_CORRUPT`）——不要按 HTTP 413/404 理解 MCP 通道的状态。

**已知限制 / 后续计划**（v2026-10-21，经 DeepSeek 五轮评审确认）：
- `resources/list.truncated` 为**非标准扩展字段**（规范形状只有 `resources`）；严格校验响应形状的
  宿主如报错，以 `_meta` 承载是更规范的替代（后续可迁）；
- 真官方 MCP Inspector 人工复核未做（弱网），已用等价脚本 `mcp_inspector_equiv.mjs` 覆盖同序列；
- `notifications/resources/updated` 订阅（subscribe）未实现，留待单独轮次设计状态来源；
- 限流未做（回环 + 令牌 + 1MB 报告上限为当前天然保护）。请求示例：

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agent_link_get_task","arguments":{"project":"example-project","taskId":"onboard-1"}}}
```

工具返回位于 `result.content[0].text`（JSON 字符串）；失败时 `result.isError=true`。

### 3.1 `agent_link_claim_next_task`

- **用途/时机**：领取该项目下一项 `NEW` 任务（置 `RUNNING`，不会重复领取）。
- **参数**：`project`（可选；省略则按注册顺序扫描全部项目——**多项目环境务必显式传 project**）。
- **成功返回（真实结构）**：

```json
{
  "ok": true,
  "task": {
    "taskId": "onboard-1",
    "project": "example-project",
    "summary": "接入演练（无副作用）",
    "actions": [],
    "createdAt": "2026-10-21T06:17:05.561Z",
    "submittedAt": "2026-10-21T06:17:05.561Z",
    "source": "api",
    "claimToken": "a1b2c3d4",
    "leaseExpiresAt": "2026-10-22T14:30:00.000Z",
    "leaseTtlMs": 1800000
  },
  "instructions": "在任务所属项目内完成实际工作，然后用 agent_link_submit_result 提交可核验证据（证据不得为空；建议回传 claimToken）。"
}
```

- **租约**：领取返回 `claimToken` + `leaseExpiresAt`（TTL 默认 30 分钟，`AGENT_LINK_LEASE_TTL_MS` 可调）。超时 `RUNNING` 会被回收为 `NEW` 并换发 token；**TTL 必须大于最大任务执行时间**，长任务请调大 TTL。
- **无任务**：`{ "ok": true, "task": null, "message": "没有待处理任务（安全空闲，不重复执行）" }`
- **失败**：`UNKNOWN_PROJECT` / `PROJECT_CONFIG_INVALID` / `PROJECT_ROOT_MISSING` / `PROJECT_ROUTE_MISMATCH` / `REGISTRY_CORRUPT`
- **常见误用**：省略 `project` 导致领到其他项目任务；把 `task:null` 当失败反复轮询（应等待）。
- **不具备**：创建任务；指定任意路径/命令。

### 3.2 `agent_link_get_task`

- **用途/时机**：查询任务状态（`phase`、`reportAvailable`、`running` 等）。
- **必填**：`project`、`taskId`。
- **成功返回（真实结构）**：

```json
{
  "ok": true,
  "task": {
    "taskId": "onboard-1",
    "project": "example-project",
    "phase": "REPORTED",
    "execution": "agent",
    "claimedBy": "mcp",
    "summary": "接入演练（无副作用）",
    "actions": [],
    "createdAt": "2026-10-21T06:17:05.561Z",
    "updatedAt": "2026-10-21T06:17:05.566Z",
    "submittedAt": "2026-10-21T06:17:05.561Z",
    "startedAt": null,
    "finishedAt": "2026-10-21T06:17:05.566Z",
    "reportAvailable": true,
    "queuePosition": null,
    "running": false
  }
}
```

- **失败**：`UNKNOWN_PROJECT` / `TASK_NOT_FOUND`
- **常见误用**：用错误 `project` 查任务（不同项目登记簿隔离，必然 `TASK_NOT_FOUND`）。
- **不具备**：跨项目按 `taskId` 全局搜索。

### 3.3 `agent_link_submit_result`

- **用途/时机**：领取并完成工作后，提交结果与证据。
- **必填**：`project`、`taskId`、`ok`（布尔）、`evidence`（非空：字符串/对象/数组）。
- **可选**：`summary`、`note`、`claimToken`（领取时返回；用于租约校验与幂等重放）。
- **成功返回（真实结构节选）**：

```json
{
  "ok": true,
  "phase": "REPORTED",
  "report": {
    "taskId": "onboard-1",
    "project": "example-project",
    "status": "ACTIONS_DONE",
    "goalAchieved": false,
    "taskComplete": false,
    "reportToken": "C3R-example",
    "results": [],
    "evidence": { "rehearsal": true }
  }
}
```

- **失败**：`EVIDENCE_REQUIRED`(400) / `INVALID_OK`(400) / `INVALID_STATE`(409) / `PROJECT_ROUTE_MISMATCH`(409) / `CLAIM_TOKEN_MISMATCH`(409) / `LEASE_EXPIRED`(409) / `ALREADY_SUBMITTED`(409) / `ORPHAN_WRITE_FAILED`(500) / `TASK_NOT_FOUND` / `UNKNOWN_PROJECT`
- **幂等与孤儿**：已终态且携带首次 `claimToken` → 返回首次报告（`idempotent:true`，不覆盖）；否则 `ALREADY_SUBMITTED`。token 不匹配/租约过期时，结果写入项目 `tasksDir/orphan/` 并审计（不静默丢弃），返回 `orphanFile`。
- **常见误用**：把 `ok=true` 当任务完成——它只表示“动作已执行且有证据”（`ACTIONS_DONE`），`goalAchieved=false`、`taskComplete=false`。
- **不具备**：判定目标是否达成；代替 GPT 决策；提交空证据。

### 3.4 `agent_link_list_projects`（只读）

- **用途/时机**：接入前发现已注册项目与健康状态。
- **参数**：无。
- **返回**：`projects: [{ name, hasRegistry }]`、`configErrors: [{ project, code }]`（只回结构化错误码，如
  CONFIG_MISSING / PROJECT_ROOT_INVALID；原文只进服务端日志）、`configErrorCount`、`queueDepth`、`running`、`version`。
- **信息面白名单**：不回显绝对路径、登记簿路径与配置错误原文。

### 3.5 `agent_link_list_tasks`（只读）

- **用途/时机**：查看某项目的任务列表，决定领取策略或核对状态分布。
- **必填**：`project`。**可选**：`phase`（NEW/RUNNING/REPORTED/FAILED/BLOCKED/REPORT_UNKNOWN）、`limit`（默认 20，≤100）。
- **返回**：按创建时间倒序的 `tasks: [{ taskId, phase, createdAt, submittedAt, claimedBy, claimedAt, execution, hasReport, summary(截断 200 字) }]` + `total`/`returned`。
- **失败**：`UNKNOWN_PROJECT` / `REGISTRY_CORRUPT`。

### 3.6 `agent_link_list_reports`（只读）

- **用途/时机**：识别 MCP 资源里 `agent-link://report/...` 到底是什么、以及清理旧报告前的清单。
- **必填**：`project`。**可选**：`limit`（默认 20，≤100）。
- **返回**：按完成时间倒序的 `reports: [{ taskId, phase, summary(截断 200 字), finishedAt, createdAt }]` + `total`/`returned`；**不含文件路径与令牌**。
- **清理**：MCP 不提供删除工具（破坏性操作不进协议）。用 `npm run cleanup:reports -- --project <name> --before <ISO> [--keep N] [--yes]`，默认 dry-run。
- **失败**：`UNKNOWN_PROJECT` / `PROJECT_CONFIG_INVALID` / `REGISTRY_CORRUPT`。

---

## 4. 项目 Agent 的标准工作流程

```
发现 MCP 工具 → 确认项目注册 → 创建或接收任务 → 核对任务归属与执行目录
→ 认领任务 → 执行工作 → 提交结构化报告 → 等待 GPT 决策 → 按决策继续 → 确认闭环
```

**禁止**：

- 只在报告正文写项目名，却不验证任务 `project` 归属；
- 通过其他项目的登记簿绕过项目隔离；
- 把“任务提交成功”等同“任务完成”；
- 未收到 GPT 决策就擅自把需决策任务标记完成；
- 上下文耗尽后丢弃未处理报告，或重复执行已完成任务。

---

## 5. 标准消息模板

### 5.1 Agent → GPT 报告

```
[AGENT_REPORT]
project: <项目名>
taskId: <任务ID>
status: <ACTIONS_DONE | FAILED | BLOCKED>
summary: <一句话说明这次做了什么>
evidence:
- <命令/退出码/输出摘要/文件>
- <...>
completed: <true|false>
pending: <未完成事项/需要裁定的事项>
risks: <风险或无>
decisionRequired: <true|false>
reportToken: <系统生成，若有则原样保留>
[/AGENT_REPORT]
```

字段来源：
- `project`、`taskId`、`status`、`reportToken` 通常由 `agent_link_submit_result` 的报告**系统生成**；转发时应原样保留。
- `summary`、`evidence`、`completed`、`pending`、`risks`、`decisionRequired` 由 **Agent 填写**。

### 5.2 GPT → Agent 决策

```
[GPT_DECISION]
project: <项目名>
taskId: <任务ID>
decision: <CONTINUE | COMPLETE | BLOCKED>
reason: <原因>
nextActions: <下一步具体动作>
acceptanceCriteria: <验收标准>
constraints: <约束>
evidenceRequired: <需要的证据>
[/GPT_DECISION]
```

兼容性说明（**必须遵守**，否则协调器无法自动解析）：
- 协调器 `parseDecision` 当前识别：`decision: CONTINUE | FIX | COMPLETE | STOP | ASK_USER`，以及 `NEXT_ACTION: node_check <相对路径>`。
- **`BLOCKED` 不是解析器已识别的决策词**：若 GPT 输出 `decision: BLOCKED`，协调器会按“无法安全解释”**停止并保留原文**，需人工处理。若希望自动暂停，请改用 `decision: ASK_USER`（并在 `reason` 说明阻塞）。
- `COMPLETE` 仅代表**本任务或明确指定阶段**完成，不代表整个互联项目全局完成。

---

## 6. 新项目 Agent 启动提示词（可直接复制）

```
你是「<项目名>」项目的执行 Agent。请遵守以下规则，独立完成接入与执行，不要依赖任何历史对话：

1. 先阅读 <repo>/docs/AGENT_INTEGRATION_GUIDE.md，按其步骤工作。
2. 通过 MCP tools/list 读取 agent-link 的**真实**工具 schema；只使用真实存在的工具（list_projects / list_tasks / list_reports / claim_next_task / get_task / submit_result）。不存在 create_task 工具。
3. 检查本项目是否已在 <repo>/test/projects.json 注册，且 projectRoot 指向真实目录；若未注册，先报告所需配置（不要猜路径）。
4. 所有任务操作必须显式传 project="<项目名>"；核对返回的 task.project 与本项目一致；只在 projectRoot 内执行白名单操作（node_check / run_project_tests），绝不越界。
5. 领取任务用 agent_link_claim_next_task；执行后用 agent_link_submit_result 提交**非空证据**；ok=true 只表示动作已执行，不代表目标完成。
6. 报告使用第 5.1 节 [AGENT_REPORT] 模板，交给协调器转发 GPT；等待 GPT 的 [GPT_DECISION]，按其 decision 继续执行。
7. 若 GPT 决策为 COMPLETE，仅视为本任务/指定阶段完成；不得据此宣布整个项目完成。
8. 上下文不足或对话耗尽时，保留未完成报告与状态，交由协调器交接；不得丢弃报告或重复执行已完成任务。
9. 遇到 UNKNOWN_PROJECT / PROJECT_ROOT_MISSING / PROJECT_ROUTE_MISMATCH / TASK_NOT_FOUND 等错误，先报告证据与所需配置，不得伪报成功、不得绕过项目隔离。
```

---

## 7. 错误码与排查（汇总）

见第 2 节步骤 8 表格。补充：
- `DUPLICATE_TASK`(409)：同项目 `taskId` 已存在。
- `INVALID_TASK_ID`(400)：`taskId` 仅允许字母数字 `._:-`，≤120。
- `OP_NOT_ALLOWED` / `ACTION_REJECTED`(400)：动作不在白名单或目标越界。
- `AGENT_NOT_CONFIGURED`(400)：`agentCommand=null` 时不允许 `agent_dispatch`。
- `REGISTRY_CORRUPT`(500)：登记簿损坏，需人工处理，不会自动重建。

---

## 8. 已实现能力 / 未验证能力 / 限制

**已实现（有测试/真实证据）**
- MCP 三工具：领取、查询、提交（真实跨进程演练通过）。
- 多项目注册与路由隔离（`agent-link` 与 `example-project` 各自登记簿/报告目录）。
- 项目上下文一致性校验：注册/根目录/执行器根/任务归属（错误码明确）。
- 配置更新需重启 MCP；新进程可正确加载（已用新进程验证）。
- 报告转发、决策解析（CONTINUE/FIX/COMPLETE/STOP/ASK_USER + NEXT_ACTION）。
- 上下文耗尽恢复：真实耗尽检测、草稿保全、新建可用对话、交接+原报告投递、决策回传、幂等/崩溃恢复。

**未验证 / 限制**
- 真实上下文耗尽无法按需稳定复现；仅对已真实发生的故障做过一次恢复验证（非模拟）。
- 无 MCP 创建任务工具；创建依赖 HTTP `POST /v1/tasks`（需回环+令牌）或受信任本地脚本。
- `agentCommand=null`：不能执行任意命令/代码修改，仅 `node_check` / `run_project_tests`。
- `BLOCKED` 决策未被自动解析（会安全停止，需人工或用 `ASK_USER`）。
- 全自动无人值守循环依赖外部 Agent 入口；协调器不替 GPT 决策。

---

## 8.1 网络异常备案（断网 / 错误页 / 回复超时）

详见 `<repo>/docs/NETWORK_FALLBACK.md`。要点：

- 状态区分：`PENDING`（未发送）/ `SENT`（已发出）/ `REPLY_RECEIVED`（已回复）/ `DECISION_RETURNED`（决策已解析）/ `SEND_UNCONFIRMED`（已发出但未确认）。
- 网络异常时**禁止重发**；先只读对账：
  `node test/context_recovery.mjs --reconcile --report <reportId> --conv <convId>`
- `found=true` → 已发送，只读最新回复，不重发；`found=false` → 可稍后用 `--deliver-file` 重投。
- 崩溃/被杀导致 `SENDING` → 加载即转 `SEND_UNCONFIRMED`，不自动重发。

## 9. 演练证据（示例占位值）

> 以下为示例运行结果（占位值），用于说明字段与流程，不代表任何真实项目或会话。
> 本机运行证据：`<repo>/test/state/onboard_rehearsal_evidence.json`（gitignored）

- 健康检查：`200`，`projects=["agent-link","example-project"]`
- `tools/list`：`agent_link_claim_next_task`、`agent_link_get_task`、`agent_link_submit_result`
- 创建（HTTP，agent 模式）：`202`，`taskId=onboard-1`，`phase=NEW`
- 领取（MCP）：`taskId=onboard-1`，`project=example-project`
- 提交（MCP）：`phase=REPORTED`，`report.project=example-project`，`status=ACTIONS_DONE`，`reportToken=C3R-example`
- 状态核对：`phase=REPORTED`
- 未注册项目：`UNKNOWN_PROJECT`（`项目未注册: not-registered`）

> 说明：上文 3.1/3.2/3.3 的返回示例若与本次 `taskId` 不同，属**示例数据**；以第 9 节与证据文件的实际值为准。

---

## 10. 附录：关键文件与路径

| 用途 | 路径 |
|---|---|
| MCP 服务 | `<repo>/test/mcp_server.mjs` |
| MCP 宿主注册 | `<repo>/test/mcp.register.json` |
| 项目注册表 | `<repo>/test/projects.json` |
| agent-link 配置 | `<repo>/test/project.config.json` |
| example-project 配置 | `<repo>/test/example-project.config.json` |
| 服务令牌 | `<repo>/test/service/token.txt` |
| 本地服务 HTTP | `<repo>/test/local_service.mjs` |
| 任务/报告（agent-link） | `<repo>/test/tasks/` |
| 任务/报告（example-project） | `<another-project>/.agent-link/tasks/` |
| 接入演练脚本 | `<repo>/test/onboard_rehearsal.mjs` |
| 文档一致性测试 | `<repo>/test/agent_integration_doc_test.mjs` |
