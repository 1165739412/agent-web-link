# 网络异常备案（断网 / 错误页 / 回复超时）

> 适用：协调器向 ChatGPT 投递报告或读取回复时，出现断网、`chrome-error://` 错误页、网络错误提示、回复超时。
> 原则：**先对账、后决定；不确定就绝不重发。**

## 1. 如何识别网络异常（与上下文耗尽区分）

协调器 `detectNetworkIssue` 会检查：

- `navigator.onLine === false`（离线）
- 页面 URL 为 `chrome-error://…`（导航失败）
- 页面文本包含：`网络错误`、`连接中断`、`无法连接`、`请检查网络`、`Check your connection`、`Network error`、`ERR_INTERNET_DISCONNECTED`、`ERR_NETWORK_CHANGED`、`ERR_CONNECTION` 等

发送流程中的分类：
- 发送前不可用 → `NETWORK_UNAVAILABLE`（**未输入、未点击**）
- 输入失败 → `NETWORK_TYPE_FAILED`（未点击）
- 点击失败 → `NETWORK_CLICK_FAILED`（未点击）
- 已点击但读不到回复 → `NETWORK_REPLY_TIMEOUT`（**可能已发送**）
- 上下文耗尽 → `CONTEXT_LIMIT`（与网络错误不同，走新建对话恢复）

## 2. 状态含义（严禁混淆）

| 状态 | 含义 | 能否重发 |
|---|---|---|
| `PENDING` | 已持久化，未发送 | 可以（网络恢复后） |
| `SENDING` | 已认领，发送中（进程可能被杀） | **不可以**，需对账 |
| `SENT` | 消息已发出，尚无回复 | **不可以**，只能读回 |
| `REPLY_RECEIVED` | 已读到回复，但未解析出决策词 | **不可以**，交 Agent/人工判断原文 |
| `DECISION_RETURNED` | 已解析出决策并回传 | **不可以** |
| `SEND_UNCONFIRMED` | 已点击但结果不确定 | **不可以**，先对账 |

> 进程崩溃/被取消时，`SENDING` 在下次加载会自动转为 `SEND_UNCONFIRMED`，不会自动重发。

## 3. 断网时的正确操作（不要点重发）

1. **保留现场**：不要清空输入框、不要删除 `test/state/pending_reports/` 与 `context_handoff_checkpoint.json`。
2. **只读对账**（不发任何消息）：

```bash
node test/context_recovery.mjs --reconcile --report <reportId> --conv <conversationId>
```

返回：
- `found: true` → 报告已在对话中（已发送）。只读最新助手回复；若有决策词则已回传；若无，则等待或稍后 `--resume` 再读。
- `found: false` → 报告未发送（`PENDING`）。网络恢复后再投递。

3. 若输入框仍残留**已发送**报告的重复文本：仅在确认 `found:true` 后清除，避免误点重复发送：

```bash
node test/clear_composer_if_sent.mjs <conversationId> <reportHash>
```

## 4. 网络恢复后的续接

1. 确认页面可用（不是 `chrome-error://`）、ChatGPT 已登录。
2. 若检查点存在且未完成：`node test/context_recovery.mjs --resume`（只读读回，不重发）。
3. 若对账为 `PENDING`（未发送）：`node test/context_recovery.mjs --deliver-file <pending文件> --conv <conversationId>`。
4. 上下文耗尽仍走 `--recover`（检测耗尽→新建可用对话→交接+投递）。
5. 若 MCP 工具报 `UNKNOWN_PROJECT`：按 `AGENT_INTEGRATION_GUIDE.md` 确认配置并**重启 MCP 会话**。

## 5. 浏览器/进程相关

- 出现 `chrome-error://` 标签属导航失败，不影响其他对话页；不要用它做投递目标。
- 多个 `mcp_server.mjs` 进程的父进程均为 `CodeBuddy CN.exe`（宿主管理），**不要手动 kill**；如需刷新配置，重启宿主 MCP 会话。

## 5.1 发送凭证与 CDP 不可用（重要）

弱网/断网时 DOM 可能为空或虚拟化，**不能只凭 DOM 判断是否已发送**。对账优先级：

1. **relay 发送记录**（`test/state/relay_*.json`）：
   - 新记录带 `reportRef=<报告hash>`，精确匹配；
   - 旧记录（无 `reportRef`）仅当 `textLen ≈ 报告长度 + 30`（容差 40）时匹配，避免误配交接消息。
   - 记录 `status=SENT/REPLY_RECEIVED/UNKNOWN` → 视为**已发送**，标 `SENT`（或按记录回复解析），**绝不重投**。
2. DOM 读回（仅作补充）：
   - 明确看到报告消息之后的新助手回复，才解析决策；
   - DOM 不可读/为空时不推断。

CDP 本身不可用（`9222` 未监听、`fetch failed`）时，`--reconcile` 仍可用发送凭证给出 `SENT` 结论，不会触发重发；待浏览器/网络恢复后再 `--resume` 读取回复。

## 6. 已知限制

- 断网期间无法验证投递，只能对账与等待；不得伪报成功。
- 若 GPT 回复不是 `CONTINUE/FIX/COMPLETE/STOP/ASK_USER`（例如 `RAISE`），协调器**不猜测**，状态停在 `REPLY_RECEIVED`，需 Agent/人工按原文处理。
- 弱网下"回复归因"可能不确定：只有 relay 记录为 `REPLY_RECEIVED` 且含 `replyText` 时才解析决策；否则状态停在 `SENT`，需恢复后人工/`--resume` 读回确认。
- 真实网络故障不可按需复现；本轮为真实网络异常后的对账与恢复，非模拟。
