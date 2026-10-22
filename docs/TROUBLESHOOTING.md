# 排障手册（Troubleshooting）

面向在本机使用网页中继（ChatGPT / DeepSeek）和 MCP 工具时最常见的问题。原则：**先诊断，再发送；发送之后的失败不自动重试**（避免重复消息）。

> 所有 CLI 都自带 `--help`：`node test/send_to_ds.mjs --help`、`node test/relay.mjs --help`、`node test/start-browser.mjs --help`、`node test/cleanup_reports.mjs --help`。

## 1. 发送失败：三步定位

不要一上来就猜"没登录"。按顺序执行，每步都会给出可执行建议：

```bash
# ① 环境诊断（不发送）：CDP 是否可达 / 有没有聊天页 / 是否就绪
npm run diag
#    等价于：node test/send_to_ds.mjs --diag

# ② 按会话探测（与真实发送同一条路径，避免"探的是另一个标签页"）
node test/relay.mjs --probe --conv <会话ID>

# ③ 真实发送（失败会自动打印 DIAG 区块）
DS_CONV=<会话ID> node test/send_to_ds.mjs <消息文件> --retries 2
```

`DIAG` 输出包含 `cdp.up`、`chatPages`、`convFound`、`hints[]`。`hints` 是可直接照做的动作，例如：

- `CDP 不可达` → 浏览器没开或没带调试端口 → `npm run browser`
- `没有打开任何 ChatGPT / DeepSeek 聊天页` → 同上，并完成登录
- `没有包含会话 <id> 的标签页` → 打开该会话，或新建对话后把新 ID 传给 `DS_CONV`
- `composer=false` → 未登录 / 仍在加载 / 页面结构变化
- `limit=true` → 上下文耗尽，新建对话
- `REPLY_TIMEOUT` → 已发出但回复慢/被限流；**不会重发**，可稍后手动重试

### 常见失败原因码

| reason | 含义 | 处理 |
|---|---|---|
| `NO_CHATGPT_PAGE` | 没有聊天页标签页 | `npm run browser` |
| `CONV_PAGE_NOT_FOUND` | 指定会话的标签页不存在 | 打开该会话 / 换 `DS_CONV` |
| `NO_READY_CONVERSATION` | 找到页面但未就绪 | 人工确认已登录、输入框可用 |
| `NETWORK_UNAVAILABLE` / `NETWORK_*` | 离线 / 错误页 | 恢复网络、刷新页面 |
| `CONTEXT_LIMIT` | 上下文耗尽 | 网页新建对话 |
| `TYPE_FAILED` | 输入框写入失败 | 检查选择器 / 页面类型 |
| `CLICK_NO_EFFECT` | 点击后输入框未清空，判定未提交 | 检查发送按钮选择器 |
| `REPLY_TIMEOUT` | 已发送但读回超时 | 不自动重发；稍后手动重试 |

## 2. `--probe` 与"能不能发"不是一回事

- `relay --probe`（不带 `--conv`）走的是**就绪门**：要求目标页的输入框存在、无上下文耗尽、无加载错误。
- `send_to_ds` / `sendAndRead(preferConvId)` 走的是**按会话直连**：只要找到含该会话 ID 的标签页就发送，不再强制就绪门。

因此可能出现"probe 说 ready=false，但发送成功"——这是两条路径的差异，不是 probe 一定错。要判断"真实发送路径"的状态，用 `--probe --conv <id>`（与发送同路径）。**不要把 probe 当作发送的前置拦截。**

## 3. 启动浏览器（依赖不再隐式）

```bash
npm run browser                      # 默认 9222 + DeepSeek
npm run browser -- --backend chatgpt # 打开 ChatGPT
npm run browser -- --port 9222 --url https://chat.deepseek.com/
```

- 自动探测 **Edge / Chrome / Chromium**（Windows / macOS / Linux）。
- 使用独立 profile：`test/browser-profile/`（已 gitignore，含登录态 cookie，绝不入库）。
- 可用环境变量覆盖：`AGENT_WEB_LINK_BROWSER`（浏览器可执行文件）、`AGENT_WEB_LINK_PROFILE`（profile 目录）、`CDP_PORT`。
- 若 9222 已在监听，脚本只新开标签页，不重复启动。

> 注意：远程调试用的是**新 profile**，首次需要在该窗口里登录目标网页。

## 4. 回复被截断 / 想看全文

`send_to_ds` 的 stdout 会打印**完整** `replyText`，并提示完整记录文件路径 `recordFile`（位于 `test/state/relay_<runId>.json`）。若你的上层脚本只打印前 N 个字符，请改为读取 `DS_ROUND.replyText` 或 `recordFile`，不要依赖终端截断。

## 5. nonce（防串话）语义

多轮循环（`ds_loop.mjs`）要求 DeepSeek 在 `decision` 行回显本轮 `task_id`（nonce）。回复未回显时会：

- 打印 `[DS_LOOP] 警告：回复未回显 task_id=...`；
- 在轮次记录里写 `nonceVerified: false`。

**nonce 只用于可靠差分与串话检测，不影响发送。** 若你的实现不要求回显，可忽略该字段；若要启用，请确保报告模板里明确要求回显。

## 6. MCP：`configErrorCount` 现在可诊断

`agent_link_list_projects` 现在返回 `configErrors: [{ project, code }]`，只给**结构化错误码**（如 `CONFIG_MISSING`、`PROJECT_ROOT_INVALID`、`DUPLICATE_NAME`），不回传原始 message（避免路径/用户名/主机名泄露）。定位到具体项目后，查看服务端 stderr 日志获取完整原因。

资源列表（`resources/list`）的 `description` 现在带任务摘要（前 80 字），便于辨认 `agent-link://report/...` 到底是哪个任务。

要系统查看某项目有哪些报告，用只读工具 `agent_link_list_reports`（含摘要/令牌/完成时间，不含路径）；清理旧报告用：

```bash
npm run cleanup:reports -- --project <name>                        # dry-run 预览
npm run cleanup:reports -- --project <name> --before 2026-10-01T00:00:00Z --yes
npm run cleanup:reports -- --project <name> --keep 20 --yes        # 保留最新 20 份
```

清理只删除「登记簿记录、且位于项目 tasksDir 内」的报告文件，并清空 `reportFile/reportToken`（任务记录保留）；不提供 MCP 删除工具，破坏性操作不进协议。

闭环健康自检（不依赖浏览器）：

```bash
npm run selftest
```

## 7. Windows 编码（PowerShell 5.1 BOM）

PowerShell 5.1 的 `Set-Content -Encoding UTF8` 实际写 **UTF-8 with BOM**，会导致 Python 报 `SyntaxError: invalid non-printable character U+FEFF`。

- PowerShell 7+：`Set-Content -Encoding utf8NoBOM`
- PowerShell 5.1：
  ```powershell
  [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
  ```
- 或用 Node 写文件：`fs.writeFileSync(p, s, "utf8")`（本仓库脚本均如此）。

## 8. `python -c` 引号地狱

Windows 命令行对多层引号转义极不友好。建议：**把脚本写成临时文件再执行**（`python tmp_script.py`），不要用 `python -c "..."` 拼长串。本仓库的诊断与自检都提供了 `.mjs` 脚本入口，避免该问题。

## 9. 关于 `write_to_file` 间歇性报 `missing required argument filePath`

这是 **Agent 宿主（IDE）工具层**的问题，不属于本仓库代码，无法在仓库内修复。规避方式：对既有文件优先用定点替换（`replace_in_file`）；批量写入失败时重试，并核对文件是否已写入。
