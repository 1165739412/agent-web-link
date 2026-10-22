# 发送工作流（单一权威源）

本文件把「准备材料 → 启动浏览器 → 诊断 → 发送 → 读回 → 决策 → PASS/FIX 循环」串起来。若与其他脚本的注释冲突，以本文件为准。

## 0. 两条通道：MCP 与 relay 的关系

| 通道 | 入口 | 用途 | 何时用 |
|---|---|---|---|
| **MCP** | `test/mcp_server.mjs`（stdio JSON-RPC） | 任务队列：发现项目、列任务/报告、领取（NEW→RUNNING）、查询、提交结果（含证据） | 你的 Agent 以「领取-执行-提交」方式协作时 |
| **relay** | `test/relay.mjs` / `test/send_to_ds.mjs` | 网页中继：把一段文本真正发到 ChatGPT/DeepSeek 并读回回复 | 需要让网页版模型评审/决策时 |

**它们不是二选一的对立通道**：典型姿势是 MCP 管任务生命周期，relay 负责「把报告发给对手模型、拿回决策」。也可以只用 relay（像本仓库的 `ds_loop` 那样自建任务 id），但那样任务态不在 MCP 队列里，无法用 `claim/get/submit` 复核。**建议：需要可审计的领取-提交闭环时走 MCP；只是文本往返时可直接用 relay。**

## 0.5 首次接入：项目自注册（本地 CLI）

在目标项目根目录执行，不需要找人改 JSON：

```bash
node <agent-web-link>/test/register_project.mjs --name my-project
# 或显式指定：node test/register_project.mjs --name my-project --root "D:/work/my-project"
```

- 生成 `<root>/.agent-link/project.config.json`（projectTests 为空、agentCommand=null、状态/任务目录在项目内）；
- 幂等登记到 `test/projects.json`；同名同配置不重复，同名不同配置需 `--force`；
- `--dry-run` 只预览；`--emit-report <file>` 生成**脱敏**复核报告（不含绝对路径）；
- 复核：`DS_CONV=<会话ID> node test/send_to_ds.mjs <复核报告>`；再用 `npm run selftest` 验证闭环；
- **刻意不做成 MCP 工具**：注册会写任意路径，必须由人执行，否则白名单边界形同虚设。

## 1. 材料契约（我们这版）

`send_to_ds.mjs` 只接受**一个文件路径**，按字节原样读取：

```bash
DS_CONV=<会话ID> node test/send_to_ds.mjs path/to/report.txt
```

**没有** glob 规则、也不需要 `STEP<N>_report.txt` 之类命名。旧脚本 `ds-send.py` 的 `<CODE>_*.txt`（排除 `_reply`）是**它自己的约定**，已不建议沿用；若必须沿用，请在其 `--help` 里显式声明（见 §7）。

## 2. 启动浏览器（依赖显式化）

```bash
npm run browser                 # 默认 9222 + DeepSeek（自动探测 Chrome/Edge/Chromium）
npm run browser -- --backend chatgpt
```

- 独立 profile：`test/browser-profile/`（已 gitignore，含登录态）。
- 首次需在该窗口登录目标网页。
- 若 9222 已在监听，只新开标签页。

## 3. 先诊断，再发送

```bash
npm run diag                                 # 不发送：CDP/标签页/登录就绪
node test/relay.mjs --probe --conv <会话ID>  # 与真实发送同路径的就绪探测
```

输出中的 `hints[]` 是可直接照做的动作。**不要把 `--probe`（不带 `--conv`）当作发送前置门**——它走的是就绪门，与 `sendAndRead(preferConvId)` 的直连路径不同。

## 4. 发送与输出契约

```bash
DS_CONV=<会话ID> node test/send_to_ds.mjs <消息文件> [--retries N]
```

- stdout：一行 `DS_ROUND <json>`，含**完整** `replyText`、`recordFile`（完整记录路径）、`backend`、`reason`、`hint`。
- 失败：额外输出 `DIAG <json>` 与人话 `[DIAG] ...`。
- 重试：仅对「发送前」失败（未输入/未点击）重试，并逐次打印原因；**发送后失败绝不重发**。
- 崩溃/中断后：护栏会阻断后续发送（`SENDING`/`SENT`/`UNKNOWN` 都视为"可能已发出"）。先只读恢复：
  `node test/relay.mjs --recover --conv <会话ID> --expect <task_id/nonce>`
  - 必须**唯一**命中一条待确认记录；多条时用 `--run-id <id>` 指定（否则 `RECOVER_AMBIGUOUS`）；
  - 回复必须包含 `--expect` 指纹（否则 `RECOVER_NO_MATCH`）；确需无校验加 `--allow-unverified`；
  - 成功后写 `RECOVERED`（附 `recoveredFrom`/`matchedBy`）并解除护栏，不发送。
- 发送串行：`sendAndRead` 用 `relay.lock`（O_EXCL，一次写入 pid/token）+ 进程存活判定：持有者 pid 存活且未超硬阈值（`AGENT_LINK_LOCK_HARD_STALE_MS`，默认 2h）不回收；pid 不存活才回收（无 pid 时按 `AGENT_LINK_LOCK_STALE_MS` 兜底）。并发返回 `RELAY_BUSY`；锁被回收后原进程恢复会在发送前/点击前两次校验中拿到 `RELAY_LOCK_LOST`，不会二次发送。
- WAL 原子性：所有 `relay_*.json` 与 `relay_latest.json` 都用 temp+rename 写；正常发送流程扫描 WAL，遇**损坏**记录返回 `WAL_CORRUPT_BLOCK` 并阻断；`SENDING/lock-acquired`（尚未输入）放行，`SENDING/typing` 及 `SENT/UNKNOWN` 阻断。损坏文件：`node test/relay.mjs --repair-wal` 移入 `stateDir/quarantine/` 并写 UNKNOWN 占位（默认仍阻断）；确认风险后 `--repair-wal --force` 直接放行；`--recover` 成功读回后自动消除占位。
- 会话作用域：护栏在**目标解析之后**执行（targetId/convId 已定型），按 CDP tab 优先、会话标识（ChatGPT `/c/<id>`、DeepSeek `/s/<id>`）精确匹配；无法确定时**保守阻断**（fail-safe）；新会话首发不会被其他会话旧 pending 误挡（有测试覆盖）。
- 租约：`claim` 返回 `claimToken`/`leaseExpiresAt`/`leaseTtlMs`；TTL 必须大于最大任务执行时间（默认 30 分钟，`AGENT_LINK_LEASE_TTL_MS` 可调）。超时任务会被回收并换发 token；旧 token 提交返回 `CLAIM_TOKEN_MISMATCH`/`LEASE_EXPIRED`，结果写入项目 `tasksDir/orphan/` 并审计，不静默丢弃。
- 发送期间勿手动操作目标页面（切会话/关标签页）：护栏依据的 targetId/convId 与点击落点可能不一致（窄窗口，仅提示）。

## 5. 决策格式与校验

回复中应包含一行：

```
decision: CONTINUE|FIX|COMPLETE|STOP|ASK_USER
```

- `CONTINUE`/`FIX` 还需 `NEXT_ACTION: node_check <path>`。
- 解析大小写不敏感；取**最后一个** `decision` 作为结论。
- **非法/缺失决策**（例如写成 `decision: ?`）：`ds_loop` 会打印 `决策无法解析：raw=...` 并终止（`UNPARSEABLE_DECISION`），不会静默继续。
- `CONTINUE/FIX` 但缺少可解析动作：打印告警并终止（`NO_ACTION_IN_REPLY`）。

## 6. nonce（防串话）

多轮循环要求在 `decision` 行回显本轮 `task_id`（nonce）。未回显时 `ds_loop` 打印警告并记录 `nonceVerified:false`，但**不影响发送**。

## 7. 自检与自助

- `npm run selftest`：MCP 闭环干跑（不需要浏览器/会话）。
- `npm run diag` / `send_to_ds --diag`：环境健康。
- `node test/relay.mjs --recover --conv <会话ID> --expect <task_id/nonce>`：只读恢复（读回最后回复、指纹校验、解除发送护栏，不发送）。
- `node test/send_to_ds.mjs --help`、`node test/relay.mjs --help`、`node test/start-browser.mjs --help`：各自契约。
- 旧脚本接入：用环境变量或相对发现，不要硬编码绝对路径：
  ```python
  import os, pathlib
  RELAY = os.environ.get("AGENT_WEB_LINK_RELAY") or str(pathlib.Path(__file__).resolve().parent / "relay.mjs")
  ```

## 8. 为什么工具只能在「已注册项目」内操作（白名单）

MCP 工具不接收命令、可执行文件、shell 或任意文件路径，只接受**项目名**，且该项目必须已在 `test/projects.json` 注册。原因：

1. **最小攻击面**：若接受任意路径，等于把「读/写任意文件」暴露给远端 Agent（目录穿越、UNC、符号链接）。
2. **可审计与可回滚**：任务只落在该项目自己的 `tasksDir/registry.json`，报告写入固定目录，便于对账与清理。
3. **执行器一致性**：项目配置里的 `projectRoot` 与实际执行器根必须一致，防止「A 项目任务在 B 目录执行」。
4. **不静默回退**：未注册/配置非法的项目在提交/领取/回报时**显式失败**，不会偷偷落到别的项目。

因此「先注册」不是官僚流程，而是安全边界。若只是想临时用，注册一个最小项目即可（见 `AGENT_INTEGRATION_GUIDE.md` 步骤 3）。

## 9. 资源读取与审计

- `resources/read`（`agent-link://report/{project}/{taskId}`）按登记簿精确查找；任务不属于该项目则拒绝；
- 每次读取写 `read-report` 审计（项目 stateDir/audit.log）；
- **注意**：MCP 入口当前是**单一 token**，持有该 token 的本地调用方可读所有已注册项目的报告。若需要"按 agent/任务隔离读取"，需上层部署多实例/多 token；本仓库不做伪隔离。

## 10. 相关文档

- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)：失败原因表、Windows 编码、Python 引号。
- [`AGENT_INTEGRATION_GUIDE.md`](AGENT_INTEGRATION_GUIDE.md)：MCP 接入与工具契约。
- [`AGENT_BACKENDS.md`](AGENT_BACKENDS.md)：后端选择与适配器校准。
