// 与 DeepSeek 的多轮无人值守循环（复用 auto_loop 内核）：
//   每轮：真实执行 DS 上轮指派的动作（local_service worker 白名单）→ 构建真实报告 → relay 发送 →
//         DS 自主决策（CONTINUE+NEXT_ACTION / COMPLETE / STOP / FIX / ASK_USER）→ 解析 → 下一轮。
//   终止条件：DS 自己发出 COMPLETE/STOP（协调器不诱导终止、不代其决定）；maxRounds/maxTotalMs 仅为安全边界。
//   每轮回复要求附带当轮唯一 task_id（nonce），保证文本差分可靠。
// 用法：node test/ds_loop.mjs [--seed "node_check test/xxx.mjs"] [--max-rounds 6] [--state-file ...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLoopReport, makeWorkerExec, parseDecision, sigOf, listCandidateTargets, DECISIONS } from "./auto_loop.mjs";
import { loadRelayConfig, sendAndRead } from "./relay.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 目标 DeepSeek 会话需由使用者通过环境变量 DS_CONV 提供，不硬编码任何私人会话 ID。
const DS_CONV = process.env.DS_CONV;
if (!DS_CONV || !/^[0-9a-fA-F-]{8,}$/.test(DS_CONV)) {
  console.error("缺少有效的 DS_CONV（DeepSeek 会话 ID）。用法：DS_CONV=<id> node ds_loop.mjs ...");
  process.exit(64);
}
const log = (m) => console.error(m);

function parseArgs(argv) {
  const out = { seed: "node_check test/auto_loop.mjs", maxRounds: 6, maxTotalMs: 540000, intervalMs: 2000, stateFile: path.join(__dirname, "state", "ds_loop_state.json"), resume: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") out.seed = argv[++i];
    else if (argv[i] === "--max-rounds") out.maxRounds = Math.max(1, parseInt(argv[++i], 10) || 6);
    else if (argv[i] === "--max-total-ms") out.maxTotalMs = Math.max(60000, parseInt(argv[++i], 10) || 540000);
    else if (argv[i] === "--interval-ms") out.intervalMs = Math.max(0, parseInt(argv[++i], 10) || 2000);
    else if (argv[i] === "--state-file") out.stateFile = argv[++i];
    else if (argv[i] === "--resume") out.resume = true;
  }
  return out;
}
function parseSeed(s) {
  const m = String(s || "").match(/^\s*(?:node\s*--?check|node_check)\s+(\S+)\s*$/i);
  return m ? { op: "node_check", target: m[1].trim() } : null;
}

const opts = parseArgs(process.argv.slice(2));
let seedAction = parseSeed(opts.seed);
if (!seedAction) { console.error("缺少或非法 --seed"); process.exit(64); }
const config = loadRelayConfig().config;
const stateDir = path.join(__dirname, "state");
const stateFile = opts.stateFile;

// 状态持久化（RUNNING 崩溃保护，与 auto_loop 同约定）
let state = { status: "IDLE", rounds: [], executedSignatures: [] };
if (fs.existsSync(stateFile)) {
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { state = { status: "IDLE", rounds: [], executedSignatures: [] }; }
}
if (state.status === "RUNNING") {
  console.log("DS_LOOP_RESULT " + JSON.stringify({ ok: false, stopReason: "PREV_CRASH_UNRESOLVED", rounds: state.rounds || [] }));
  process.exit(1);
}
// 续跑：从上一轮 DS 指派的动作继续（保留已执行签名去重）
if (opts.resume) {
  const last = Array.isArray(state.rounds) && state.rounds.length ? state.rounds[state.rounds.length - 1] : null;
  if (last && last.nextAction) {
    seedAction = last.nextAction;
    log(`[DS_LOOP] 续跑：从 DS 上轮指派的动作继续 ${sigOf(seedAction)}（已完成 ${state.executedSignatures.length} 个签名）`);
  } else {
    console.error("无可续跑的 nextAction，请去掉 --resume 或用 --seed 重新开始");
    process.exit(64);
  }
}
state.status = "RUNNING";
state.startedAt = state.startedAt || new Date().toISOString();
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
saveState();

const execFn = makeWorkerExec({ log });
const goal = "对 agent-link 项目 test 目录的 JS 文件逐个做语法检查（node_check）；由你每轮指派下一个目标，全部检查完成后由你发出 COMPLETE 终止";
const rounds = [];
let action = seedAction;
let stopReason = null;
const t0 = Date.now();

for (let round = 1; round <= opts.maxRounds; round++) {
  if (Date.now() - t0 >= opts.maxTotalMs) { stopReason = "MAX_TOTAL_MS"; break; }
  if (!action) { stopReason = "NO_ACTION"; break; }
  const sig = sigOf(action);
  if (state.executedSignatures.includes(sig)) { stopReason = "DUPLICATE_ACTION"; break; }
  log(`[DS_LOOP] === 第 ${round}/${opts.maxRounds} 轮 action=${sig} ===`);

  const ex = await execFn(action, round);
  state.executedSignatures.push(sig);
  const candidates = listCandidateTargets(state.executedSignatures);
  let reportText = buildLoopReport({ round, maxRounds: opts.maxRounds, minRounds: 2, goal, action, ex, candidates });
  // DS 循环专用回复格式：decision 行附带当轮唯一 task_id（nonce），保证逐轮回复可差分；
  // 明确"是否结束由 DS 决定"，不诱导终止。
  const nonce = ex && ex.taskId ? ex.taskId : `ds-loop-round${round}`;
  reportText += "\n\n【回复格式（本循环专用，务必遵守）】\n"
    + `decision 行末尾必须原样附带本报告的 task_id（${nonce}），例如：decision: CONTINUE # ${nonce}\n`
    + "若 decision=CONTINUE 或 FIX，再给一行：NEXT_ACTION: node_check <从 available_next_targets 选择的路径>\n"
    + "本循环会持续多轮：每轮我都真实执行你指派的动作并回报结果；是否结束由你决定——只有当你判断目标已完成时才发出 decision: COMPLETE。";
  const reportFile = stateFile.replace(/\.json$/, `.round${round}.report.txt`);
  fs.writeFileSync(reportFile, reportText, "utf8");

  // 读回硬化：等待上限 90s（默认 180s 太久，观感如"卡死"）；超时但页面已有可见回复文本时
  // 采纳其决策（打 unconfirmed 标记），避免无谓长等。
  const cfgRound = { ...config, replyTimeoutMs: 90000 };
  let relay = await sendAndRead({ config: cfgRound, text: reportText, stateDir, preferConvId: DS_CONV, preferBackend: "deepseek", log });
  let unconfirmed = false;
  if (!relay.ok && relay.reason === "REPLY_TIMEOUT" && relay.replyText) {
    relay = { ...relay, ok: true, unconfirmedReply: true };
    unconfirmed = true;
    log(`[DS_LOOP] 读回超时但已捕获可见回复，采纳（unconfirmed）`);
  }
  const replyText = (relay && relay.replyText) || "";
  const parsed = parseDecision(replyText);
  // nonce 回显校验（防串话/截断）：回复应原样包含本轮 nonce（task_id）。
  // 未回显时只告警不中断（决策仍可能有效），但记录到 nonceVerified 便于事后审计。
  const nonceVerified = replyText.includes(nonce);
  if (!nonceVerified) log(`[DS_LOOP] 警告：回复未回显 task_id=${nonce}（可能存在串话/截断/历史回复干扰）`);
  const rec = {
    round, action, signature: sig, taskId: ex && ex.taskId, status: ex && ex.status, exitCode: ex && ex.exitCode,
    relayOk: !!(relay && relay.ok), relayRunId: relay && relay.runId, relayReplyId: relay && relay.replyId,
    unconfirmedReply: unconfirmed || !!(relay && relay.unconfirmedReply),
    backend: relay && relay.backend, fallback: !!(relay && relay.fallback),
    decision: parsed.decision, nextAction: parsed.nextAction, nonceVerified, replyText: replyText.slice(0, 4000),
    at: new Date().toISOString(),
  };
  rounds.push(rec);
  state.rounds = rounds;
  saveState();
  log(`[DS_LOOP] 第 ${round} 轮完成: exec=${ex && ex.status} decision=${parsed.decision} next=${parsed.nextAction ? sigOf(parsed.nextAction) : "-"}`);

  if (!relay || !relay.ok) { stopReason = "RELAY_FAILED"; break; }
  if (parsed.decision === "COMPLETE" || parsed.decision === "STOP") { stopReason = parsed.decision; break; } // DS 自己的终止信号
  if (parsed.decision === "ASK_USER") { stopReason = "ASK_USER"; break; }
  if (parsed.decision === "CONTINUE" || parsed.decision === "FIX") {
    if (!parsed.nextAction) {
      log(`[DS_LOOP] decision=${parsed.decision} 但缺少可解析的 NEXT_ACTION（回复片段: ${replyText.slice(0, 120)}）`);
      stopReason = "NO_ACTION_IN_REPLY"; break;
    }
    action = parsed.nextAction;
    if (round < opts.maxRounds) await new Promise((r) => setTimeout(r, opts.intervalMs));
    continue;
  }
  log(`[DS_LOOP] 决策无法解析：raw=${JSON.stringify(parsed.rawDecision)}（有效值: ${DECISIONS.join("/")}）`);
  stopReason = "UNPARSEABLE_DECISION"; break;
}
if (!stopReason) stopReason = "MAX_ROUNDS";

state.status = "STOPPED";
state.stopReason = stopReason;
state.finishedAt = new Date().toISOString();
saveState();
const ok = ["COMPLETE", "STOP"].includes(stopReason);
console.log("DS_LOOP_RESULT " + JSON.stringify({
  ok, stopReason,
  rounds: rounds.map((r) => ({ round: r.round, action: r.signature, status: r.status, exitCode: r.exitCode, decision: r.decision, next: r.nextAction, backend: r.backend, runId: r.relayRunId })),
}, null, 2));
process.exit(ok ? 0 : 1);
