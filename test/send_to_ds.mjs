// 生产级 DeepSeek 发送器：走 relay.sendAndRead 真实路径，定向到指定会话，读回回复。
//
// 用法：
//   DS_CONV=<会话ID> node test/send_to_ds.mjs <消息文件> [--retries N] [--conv <id>]
//   node test/send_to_ds.mjs --diag            # 仅诊断：CDP/标签页/就绪状态（不发送）
//
// 设计：
//   - 失败时自动诊断并输出人话（CDP 是否可达 / 是否找到会话 / 是否就绪），不再只给错误码；
//   - 只对"发送前"的失败重试（绝不重发已可能发出的消息），每次重试打印原因分类；
//   - stdout 打印完整回复；同时提示完整记录文件路径（recordFile）；
//   - 依赖 Chromium 浏览器（Chrome / Edge）开启 --remote-debugging-port，可用 test/start-browser.mjs 一键启动。
import fs from "node:fs";
import { sendAndRead, loadRelayConfig, CDP_DEFAULT } from "./relay.mjs";
import { diagnose, explainReason } from "./relay_diagnostics.mjs";
import { resolveBackends } from "./agent_backends.mjs";

// 发送前失败（安全可重试）；发送之后（点击/读回）一律不自动重试
const PRE_SEND = new Set([
  "NO_CHATGPT_PAGE", "NO_MATCHING_CONVERSATION", "NO_READY_CONVERSATION", "CONV_PAGE_NOT_FOUND",
  "NETWORK_UNAVAILABLE", "NETWORK_TYPE_FAILED", "CONTEXT_LIMIT", "TYPE_FAILED",
]);
const isPreSend = (reason) => PRE_SEND.has(reason) || /^读取基线失败/.test(reason || "");

function parseArgs(argv) {
  const out = { file: null, conv: null, taskId: null, expect: null, retries: 0, retryDelayMs: 3000, diag: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--conv") out.conv = argv[++i];
    else if (a === "--task-id") out.taskId = argv[++i];
    else if (a === "--expect") out.expect = argv[++i];
    else if (a === "--retries") out.retries = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === "--retry-delay-ms") out.retryDelayMs = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === "--diag") out.diag = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!out.file) out.file = a;
  }
  return out;
}

const USAGE = `用法: DS_CONV=<会话ID> node test/send_to_ds.mjs <消息文件> [--retries N] [--conv <id>]
      node test/send_to_ds.mjs --diag

选项:
  --conv <id>          指定 DeepSeek 会话 ID（也可用环境变量 DS_CONV）
  --task-id <id>       可选：任务/报告引用（写入 relay 记录，便于 --recover 过滤）
  --expect <s>         可选：失败时提示的 recover 指纹（通常是 task_id/nonce）
  --retries N          仅对"发送前"失败重试（默认 0；发送后失败绝不重发）
  --retry-delay-ms N   重试间隔毫秒（默认 3000）
  --diag               只诊断 CDP/标签页/登录就绪，不发送
  -h, --help           显示本帮助

约定:
  - 消息文件按字节原样读取，不做 glob/命名规则（不存在 <CODE>_*.txt 之类隐式契约）；
  - stdout 输出 DS_ROUND JSON（含完整 replyText 与 recordFile 完整记录路径）；
  - 失败时输出 DIAG 区块（CDP 是否可达 / 是否找到会话 / 是否就绪 / 可执行建议）。
依赖: 本机 Chromium（Chrome/Edge）以 --remote-debugging-port=9222 运行；用 npm run browser 一键启动。
文档: docs/SEND_WORKFLOW.md、docs/TROUBLESHOOTING.md`;

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { console.log(USAGE); process.exit(0); }
const cfg = loadRelayConfig().config;
cfg.replyTimeoutMs = 120000; cfg.pollMs = 1500; cfg.stableNeed = 2;
const cdpHost = cfg.cdpHost || CDP_DEFAULT;

// 仅诊断模式
if (opts.diag) {
  const d = await diagnose({ cdpHost, backends: resolveBackends(cfg), convId: process.env.DS_CONV || opts.conv || null });
  console.log("DIAG " + JSON.stringify(d, null, 2));
  for (const h of d.hints || []) console.error("[DIAG] " + h);
  process.exit(d.cdp && d.cdp.up ? 0 : 3);
}

if (!opts.file) {
  console.error("用法：DS_CONV=<会话ID> node test/send_to_ds.mjs <消息文件> [--retries N]");
  console.error("      node test/send_to_ds.mjs --diag   # 只诊断不发送");
  process.exit(64);
}
const CONV = process.env.DS_CONV || opts.conv || "";
if (!/^[0-9a-fA-F-]{8,}$/.test(CONV)) {
  console.error("缺少有效的 DS_CONV（DeepSeek 会话 ID）。用法：DS_CONV=<id> node test/send_to_ds.mjs <消息文件>");
  process.exit(64);
}

const text = fs.readFileSync(opts.file, "utf8");
const log = (m) => console.error(m);
let last = null;
const attempts = opts.retries + 1;

for (let i = 1; i <= attempts; i++) {
  log(`[SEND] 第 ${i}/${attempts} 次 → 会话 ${CONV}`);
  const t0 = Date.now();
  const rr = await sendAndRead({ config: cfg, text, stateDir: "test/state", preferConvId: CONV, reportRef: opts.taskId || null, log });
  last = rr;
  log(`[SEND] 结果 ok=${rr.ok} reason=${rr.reason || "-"} 用时=${Date.now() - t0}ms backend=${rr.backend || "-"}`);
  if (rr.ok) break;
  if (!isPreSend(rr.reason)) {
    log(`[SEND] 失败发生在发送之后（状态不确定），按安全策略不重试。${rr.hint || ""}`);
    break;
  }
  if (i < attempts) {
    log(`[SEND] 发送前失败，${opts.retryDelayMs}ms 后重试。原因：${rr.reason} → ${rr.hint || explainReason(rr.reason, { cdpHost })}`);
    await new Promise((r) => setTimeout(r, opts.retryDelayMs));
  }
}

const hint = last.ok ? null : (last.hint || explainReason(last.reason, { cdpHost, replyText: last.replyText }));
console.log("DS_ROUND " + JSON.stringify({
  ok: !!last.ok, reason: last.reason || null, runId: last.runId, convId: last.convId,
  backend: last.backend || null, fallback: last.fallback ?? null, replyId: last.replyId || null,
  replyText: last.replyText || null, recordFile: last.recordFile || null, hint,
}, null, 1));

if (last.ok) {
  console.error(`[SEND] 完成。回复 ${(last.replyText || "").length} 字符${last.recordFile ? `；完整记录: ${last.recordFile}` : ""}`);
  process.exit(0);
}

// 失败：输出人类可读诊断
const d = await diagnose({ cdpHost, backends: resolveBackends(cfg), convId: CONV });
console.error("DIAG " + JSON.stringify(d, null, 2));
for (const h of d.hints || []) console.error("[DIAG] " + h);
if (hint) console.error("[DIAG] " + hint);
if (last.replyText) console.error(`[DIAG] 已捕获部分回复（见 DS_ROUND.replyText）；完整记录见 ${last.recordFile || "test/state/"}`);
if (last.runId) {
  console.error(`[DIAG] 若为发送后崩溃/超时，先只读恢复（不要直接重发）：`);
  console.error(`[DIAG]   node test/relay.mjs --recover --conv ${CONV} --run-id ${last.runId}${opts.expect ? ` --expect ${opts.expect}` : " --expect <task_id/nonce>"}`);
}
process.exit(1);
