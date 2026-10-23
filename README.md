# agent-web-link

> 跨项目、人在环路的智能体任务路由框架：本地任务登记/服务 + MCP 服务 + 多后端网页中继（ChatGPT / DeepSeek）。
> 公开项目名 **agent-web-link**；代码内部代号 `agent-link`（登记簿目录 `.agent-link`、MCP 工具前缀 `agent_link_`，保持兼容）。

[English](#english) · 中文

---

## 它解决什么问题

当你用多个智能体（Web LLM 对话 / 本地 Worker / MCP 客户端）协作完成**跨项目、可持续多轮**的任务时，需要一个中立的「任务登记与调度中枢」：

- 任务有状态（`NEW → RUNNING → REPORTED/FAILED`），不靠口头约定；
- 不同项目各自隔离，但可被同一套机制统一路由；
- Agent 通过 **MCP** 或 **HTTP** 接口领取/提交，人类通过 **Web 对话**（ChatGPT / DeepSeek）做决策（`CONTINUE` / `COMPLETE` / `STOP`）；
- 所有发送动作都有**发送凭证**（runId / 幂等去重 / 对账），避免重复发送与假成功。

## 架构

```
                 ┌──────────────┐        MCP (stdio)        ┌────────────────┐
   外部 Agent ───▶│ mcp_server   │◀─────────────────────────▶│ example-project 等   │
   (example-project)   │  (5 tools)   │                          │ MCP 客户端      │
                 └──────┬───────┘                           └────────────────┘
                        │ 调用
                 ┌──────▼───────┐   回环 + X-Auth-Token    ┌────────────────┐
                 │ local_service│◀─────────────────────────│ 本地 Worker     │
                 │ 登记簿/队列  │                          │ (node_check 等) │
                 └──────┬───────┘                           └────────────────┘
                        │ 报告/决策
                 ┌──────▼───────┐   CDP (DevTools)         ┌────────────────┐
                 │ relay        │─────────────────────────▶│ ChatGPT/DeepSeek│
                 │ + adapters   │   输入/点击/读回决策        │ (可登录网页)    │
                 └──────────────┘                           └────────────────┘
```

## 核心概念

- **任务（task）**：每个项目有自己的登记簿 `registry.json`，任务按 `createdAt` 排序；`claimNext` 只领 `NEW` 任务并立即落盘（不会重复领取）。
- **阶段（phase）**：`NEW / QUEUED / RUNNING / REPORTED / FAILED / BLOCKED / REPORT_UNKNOWN`。
- **报告（report）**：执行结果 + 可核验证据（evidence）。`ok=true` 只代表「动作已执行且有证据（`ACTIONS_DONE`）」，**不代表任务目标完成**——是否完成由人类/调度层判断。

## MCP 服务（9 个工具）

**任务类（6 个）**

| 工具 | 只读 | 作用 |
|---|---|---|
| `agent_link_list_projects` | ✅ | 发现已注册项目与健康状态（不回显绝对路径/错误原文） |
| `agent_link_list_tasks` | ✅ | 列出某项目任务（可按 `phase` 过滤，≤100 条） |
| `agent_link_list_reports` | ✅ | 列出已产出报告的元数据（含摘要，不含路径；清理前清单） |
| `agent_link_claim_next_task` | ❌ | 领取下一个 `NEW` 任务（`NEW→RUNNING`） |
| `agent_link_get_task` | ✅ | 查询任务状态 |
| `agent_link_submit_result` | ❌ | 提交结果与证据（必填 `evidence`） |

**浏览器类（3 个，本地自用，驱动已登录的网页 LLM）**

| 工具 | 只读 | 作用 |
|---|---|---|
| `agent_link_browser_open` | ❌ | 启动带调试端口（默认 9222）的 Chromium（自动探测 Chrome/Edge）并打开 DeepSeek/ChatGPT；**登录由用户在页面内手动完成** |
| `agent_link_browser_status` | ✅ | 只读诊断通道：CDP 是否可达、有无聊天页、会话是否打开、是否就绪（不发送） |
| `agent_link_send_message` | ❌ | 向已登录的 DeepSeek/ChatGPT 发送消息并读回最新回复；失败给可读原因；绝不自动重发 |

> 浏览器类工具会操作你本机已登录的聊天账号，仅在**可信本机**启用；任何接入 agent-link 的 agent 都能调用它们，等同于以你的身份收发消息。

- 协议：stdio + JSON-RPC 2.0（换行分隔）。
- 生命周期：先 `initialize`（含 `instructions`）→ 客户端回 `notifications/initialized` → 才可调用工具。
- 入参严格按 `inputSchema` 校验（缺必填/类型/`enum`/数值范围/字符串长度 → `-32602`）。
- `tools/call` 返回 `result.isError=true` 表达业务失败；结构化输出仅协商到 `2025-06-18` 及以上时才附 `structuredContent`（旧版本只读 `content[0].text`，两者等价）。

详细接入步骤见 [`docs/AGENT_INTEGRATION_GUIDE.md`](docs/AGENT_INTEGRATION_GUIDE.md)。

## 多后端网页中继（用户自主选择智能体）

`relay.mjs` 通过 Chrome DevTools Protocol（CDP）把报告注入已登录的网页对话，并读回决策。每种网页是一个**适配器**（`agent_backends.mjs`），目前内置：

- **ChatGPT**（参考实现）
- **DeepSeek**（国内直连，已真机验证全链路）

选择优先级：`--backend`(CLI) > `preferBackend`(配置) > `conversations` 顺序 > `allowAnyReadyPage`。
偏好后端无就绪页面时按启用顺序保序回退，并写入发送凭证（`backend` / `fallback` / `requestedBackend`）。
未知/未启用的后端名一律**硬校验报错**，绝不静默忽略。

```bash
# 单次指定后端（CLI 优先于配置）
node test/relay.mjs --report-file <file> --backend deepseek
```
```jsonc
// relay.config.json（长期偏好）
{ "backends": [{"id":"chatgpt"},{"id":"deepseek"}],
  "preferBackend": "deepseek",        // null = 自动跟随打开的页面
  "failoverOnNetworkError": false }   // 网络异常按启用顺序切换一次，仅预检阶段，绝不重发
```

新增一个网页后端只需在 `agent_backends.mjs` 注册一个适配器（选择器 + 读取/发送/上下文耗尽信号），**无需改动编排层**。详见 [`docs/AGENT_BACKENDS.md`](docs/AGENT_BACKENDS.md)。

## 安全模型

- 本地 HTTP 服务仅监听回环地址（loopback），并校验 `X-Auth-Token`；`list` 端点也在令牌保护段内。
- `list_projects` 信息面白名单：不回显绝对路径、登记簿路径与配置错误原文（错误详情只在服务端日志）。
- 真实提交有**凭证 + 幂等去重 + 对账**；发送后校验输入框清空，防止「假 SENT」。
- 网络异常时**安全失败**（不输入、不点击、不重发）。
- 上下文耗尽检测多信号，但各站点文案差异较大，建议配合新会话策略。

## 要求

- Node.js ≥ 18
- 中继功能需要本机 Chromium 浏览器（Chrome / Edge）+ 已登录的目标网页对话；可用 `npm run browser` 一键启动调试浏览器。MCP / 本地服务 / 纯逻辑测试**不需要**浏览器。

## 快速开始

```bash
# 1) 启动本地任务服务（默认执行 worker；只登记不执行加 --queue-only）
node test/local_service.mjs --port 8787

# 2) 把 mcp_server 注册到你的 MCP 宿主（示例 args，路径按你的仓库调整）
#    node test/mcp_server.mjs --projects test/projects.json --token-file test/service/token.txt

# 3) 运行测试 / 自检
npm test
npm run selftest        # MCP 闭环干跑自检（list→claim→submit→resources，不需要浏览器）

# 4) 需要网页中继时：一键启动调试浏览器（自动探测 Chrome/Edge，开 9222）
npm run browser         # 打开 DeepSeek；npm run browser -- --backend chatgpt 打开 ChatGPT
npm run diag            # 诊断 CDP / 标签页 / 登录就绪状态（不发送）
```

## 开发与测试

- `npm run register -- --name <name> --root <项目路径>`：新项目自注册（生成配置并登记，幂等；`--dry-run` 预览、`--emit-report` 生成脱敏复核报告）。也可在目标项目根目录直接运行 `node <agent-web-link>/test/register_project.mjs --name <name>`。
- `npm test`：纯逻辑 + stdio 集成测试（不依赖浏览器）。
- `npm run selftest`：MCP 闭环干跑自检（不需要浏览器/会话，验证 claim→submit→resources 是否健康）。
- `npm run browser`：一键启动带 `--remote-debugging-port` 的 Chromium（Chrome/Edge），并打开目标网页。
- `npm run diag`：只诊断不发送（CDP 是否可达、有无聊天页、登录/输入框是否就绪），失败时给出可执行建议。
- `npm run cleanup:reports -- --project <name> [--before <ISO>] [--keep N] [--yes]`：清理旧报告（默认 dry-run）。
- 发送/决策/材料契约、MCP 与 relay 的关系见 [`docs/SEND_WORKFLOW.md`](docs/SEND_WORKFLOW.md)。
- `npm run test:manual:browser`：需要已登录浏览器 + 配置 `DS_CONV` 的 DeepSeek 真实往返测试（**不会**自动运行，避免误发到私人会话）。
- 测试套件各自独立，临时文件落在系统 `os.tmpdir()`，互不污染。
- 常见问题（发送失败诊断、Windows 编码、Python 引号等）见 [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。

## 命名与兼容性

- 公开项目名：**agent-web-link**。
- 内部代号 `agent-link` 保留在：登记簿目录 `.agent-link`、MCP 工具前缀 `agent_link_`、MCP `serverInfo.name`（已对外呈现为 `agent-web-link`）。这是为兼容既有集成（如 `example-project`）而刻意的，勿随意改名。

## 隐私与卫生（本仓库）

- 本仓库**不含**任何凭据、令牌、浏览器登录态或会话日志；这些运行态数据一律在 `.gitignore` 中排除。
- 示例配置中的绝对路径已脱敏为相对/占位；与账号绑定的会话 ID 等敏感值通过环境变量（如 `DS_CONV`）注入，不硬编码入库。

## 许可证

[MIT](LICENSE)

---

## English

**agent-web-link** is a cross-project, human-in-the-loop agent task-routing framework: a local task registry/service + an MCP server + a multi-backend web relay (ChatGPT / DeepSeek).

It provides a neutral task hub with explicit phases (`NEW → RUNNING → REPORTED/FAILED`), per-project isolation, MCP/HTTP intake for agents, and CDP-based relay to web LLMs for human decisions. Every send carries a delivery receipt (runId / idempotent dedupe / reconciliation) to prevent duplicate or fake sends.

- **MCP server**: 9 tools (6 task tools + 3 browser tools: `agent_link_browser_open` / `agent_link_browser_status` / `agent_link_send_message`); stdio + JSON-RPC 2.0; strict `inputSchema` validation; lifecycle state machine.
- **Relay**: pluggable web adapters (ChatGPT, DeepSeek); user-chosen backend via `--backend` / `preferBackend`.
- **Security**: loopback + `X-Auth-Token`; info-surface whitelist (no absolute paths / registry paths / error text in `list_projects`); post-send clearing verification; safe-fail on network errors.

See `docs/` for the integration and backend-adapter guides. Licensed under MIT.
