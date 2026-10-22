# 智能体/网页适配器层（agent_backends.mjs）

## 目的

把"具体网页的 DOM 选择器"从中转逻辑中抽离。协议层（report/decision 文本模板）、调度层
（auto_loop）、执行层（local_service）、持久化/对账层（pending_reports + 发送凭证）均与网页无关，
新增一个网页/智能体只需登记一个后端对象。

## 后端对象字段

| 字段 | 说明 |
|---|---|
| `id` / `urlPattern` | 标识与 URL 路由（`selectBackend` 按此选择） |
| `composer` | 输入框选择器（textarea 与 contenteditable 均支持） |
| `sendButton` | 发送控件选择器（可为 `div[role=button]`） |
| `stopButton` | 生成中停止按钮（读回稳定性判断用） |
| `user` / `assistant` | 消息容器选择器 |
| `assistantIdAttr` | 助手消息稳定 id 属性；**为空时读取器回退为位置化 id，`readNewReply` 自动改用文本差分** |
| `convIdPattern` / `newConvUrl` | 会话 id 提取与新建对话地址 |
| `limitPatterns` / `newChatButtonPattern` | 上下文耗尽文案（支持 `/pattern/flags` 形式）/ 耗尽专用按钮；**为空禁用**（空正则会匹配一切） |
| `preClickSettleMs` | 点击前静置（Node 侧执行，等待框架状态同步） |
| `verifyClearAfterSend` | 发送后校验输入框已清空，防止假 SENT |
| `unverified` | 选择器是否未经真机校准 |

## 已校准后端

### chatgpt（参考实现，原逻辑等价迁移）

### deepseek（2026-10-21 真机校准，探针 `test/deepseek_probe*.mjs`）

- 输入框：`textarea`（placeholder「给 DeepSeek 发送消息」）
- 发送：`div[role='button'].ds-button--primary.ds-button--filled`
- 助手正文：`.ds-markdown.ds-assistant-message-main-content`（天然排除「已思考」推理块）
- 消息容器：`.ds-message`；会话 URL：`/a/chat/s/<uuid>`
- **行为约束（真实缺陷驱动）**：
  1. 输入事件后立即点击会被忽略 → `preClickSettleMs: 800`（必须放在 Node 侧，见下）；
  2. 提交会触发上下文重建（CDP `Promise was collected`）→ 页面内求值必须"点了就返回"，长挂起
     的页面内 Promise 会被回收导致误判失败；
  3. 虚拟列表（`ds-virtual-list`）会把旧消息移出 DOM → 位置化 id 错位 → 必须文本差分；
  4. 侧边栏「开启新对话」常驻 → 不能作为耗尽信号 → `newChatButtonPattern` 留空；
  5. 历史回复可能重复相同决策行 → **报告必须要求决策行附带唯一 task_id（nonce）**，
     否则文本差分漏检。

## 用户自主选择后端（2026-10-21 与 DS 协作实施，DS 两轮决策均 COMPLETE）

选择优先级：`--backend`(CLI) > `preferBackend`(配置) > conversations 顺序 > allowAnyReadyPage。

```jsonc
// relay.config.json
{ "backends": [{"id":"chatgpt"},{"id":"deepseek"}],
  "preferBackend": "deepseek",         // null=自动跟随打开的页面（旧行为）
  "failoverOnNetworkError": false }    // 网络异常时按启用顺序切换一次；仅预检阶段生效，绝不重发
```
```bash
node test/relay.mjs --report-file <file> --backend deepseek   # 单次覆盖配置
```

- 未知/未启用的后端名一律**硬校验报错**（配置加载与 CLI 均 exit 64），不静默忽略。
- preferBackend 无就绪页面 → 按启用顺序**保序回退**，实际命中后端写入选择结果（`backendId`）、
  发送凭证（`backend`/`fallback`/`requestedBackend`）并输出告警日志。
- 测试点见 `relay_test.mjs` R13–R18；对话全程见 `test/log/DS_DIALOGUE_BACKEND_SELECT.md`。

## 新增后端步骤

1. 在 `test/agent_backends.mjs` 登记后端对象（先用探针脚本抓真实 DOM 校准选择器）；
2. 在 `test/relay.config.json` 的 `backends` 中加入 `{"id":"<id>"}`（仅启用列表，选择器来自注册表）；
3. 写一个 `<id>_adapter_test.mjs`：纯逻辑路由断言 + 真实页 `isPageReady` + 输入回显 +
   生产路径 `relay.sendAndRead` 真实全链路（回复带唯一 nonce）；
4. 跑全量回归，确认 `relay_test`/`relay_failure_test`/`context_limit_detect_test` 无退化。

## 发送前诊断与浏览器启动（2026-10-22）

- 一键启动调试浏览器：`npm run browser`（自动探测 Chrome/Edge/Chromium，开 9222，profile=`test/browser-profile/`，已 gitignore）。
- 只诊断不发送：`npm run diag`（= `node test/send_to_ds.mjs --diag`）；按会话探测：`node test/relay.mjs --probe --conv <id>`。
- 失败返回新增 `hint`（人话 + 可执行建议）；`send_to_ds` 只对"发送前"失败重试，发送之后一律不自动重发。
- 语义提醒：`--probe`（无 `--conv`）走**就绪门**；`sendAndRead(preferConvId)` 按会话**直连**、不强制就绪门。二者结论不一致属正常，"probe 为 false"不代表不能发送。

## 已知限制

- DeepSeek 耗尽文案（`limitPatterns`）尚未在真实耗尽场景验证（无法按需复现），模式偏保守；
- 一次发送 = 一条真实消息，冒烟测试会在真实会话中留下记录（用户知情并同意真实测试）。
