// C9 单轮执行回传：在指定对话内执行一个白名单动作 → 报告 → 读取决策 → 写入全局状态
// 用途：收到 GPT 的 NEXT_ACTION 后，由 Agent 执行并自动回报（跨对话续接的原子步骤）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRelayConfig, sendAndRead } from "./relay.mjs";
import { makeWorkerExec, parseDecision, sigOf } from "./auto_loop.mjs";
import { loadGlobalState, saveGlobalState, canStartGlobal, isDuplicateSig, GLOBAL_STATE_DEFAULT } from "./handoff.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "state");
const log = (m) => console.error("[RO] " + m);

function parseArgs(argv) {
  const o = { conv: null, action: null, extraFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--conv") o.conv = argv[++i];
    else if (argv[i] === "--action") o.action = argv[++i];
    else if (argv[i] === "--extra-file") o.extraFile = argv[++i];
  }
  return o;
}
function parseAction(s) {
  if (!s) return null;
  const m = String(s).match(/^\s*(?:node\s*--?check|node_check)\s+(\S+)\s*$/i);
  if (!m) return null;
  return { op: "node_check", target: m[1].replace(/[`"'。；，,]/g, "").trim() };
}

const args = parseArgs(process.argv.slice(2));
if (!args.conv) { console.error("缺少 --conv <对话ID>"); process.exit(64); }
const action = parseAction(args.action);
if (!action) { console.error("缺少或非法 --action \"node_check <path>\""); process.exit(64); }

const loaded = loadRelayConfig();
if (!loaded.ok) { console.error("CFG " + loaded.error); process.exit(64); }
const config = loaded.config;
const gs = loadGlobalState(GLOBAL_STATE_DEFAULT);
if (!gs) { console.error("全局状态不存在，请先运行 cross_conv_verify"); process.exit(64); }
const startable = canStartGlobal(gs);
if (!startable.ok) { console.log("ROUND_RESULT " + JSON.stringify({ ok: false, reason: startable.reason })); process.exit(1); }
if (isDuplicateSig(gs, sigOf(action))) {
  console.log("ROUND_RESULT " + JSON.stringify({ ok: false, reason: "DUPLICATE_ACTION", action: sigOf(action) }));
  process.exit(1);
}
gs.status = "RUNNING"; saveGlobalState(GLOBAL_STATE_DEFAULT, gs);

const execFn = makeWorkerExec({ log });
const ex = await execFn(action, (gs.conversations.reduce((n, c) => n + (c.rounds ? c.rounds.length : 0), 0) || 0) + 1);
gs.executedSignatures.push(sigOf(action));

const extra = args.extraFile ? fs.readFileSync(args.extraFile, "utf8").trim() : "";
const r0 = ex.report && Array.isArray(ex.report.results) ? ex.report.results[0] : null;
const stderr = r0 && r0.stderr ? String(r0.stderr).slice(0, 300) : "";
const reportText = [
  "[AGENT_REPORT]",
  `conversation: ${args.conv}`,
  `task_id: ${ex.taskId}`,
  `status: ${ex.status}`,
  `goal: ${gs.goal || "「互联」项目"}`,
  "completed: false",
  `action: ${action.op} ${action.target}`,
  "evidence:",
  `- command: node --check ${action.target}`,
  `- exitCode: ${ex.exitCode}`,
  `- stderr: ${stderr ? JSON.stringify(stderr) : "空"}`,
  `problems: ${r0 && r0.ok ? "无" : "动作未成功或状态异常"}`,
  `next_suggestion: 若需继续，请给出 NEXT_ACTION；否则给出 COMPLETE/STOP/ASK_USER`,
  ...(extra ? ["", extra] : []),
  "[/AGENT_REPORT]",
  "",
  "请给出 decision（CONTINUE / FIX / COMPLETE / STOP / ASK_USER）。若继续，请附 NEXT_ACTION: node_check <相对路径>。",
].join("\n");

const r = await sendAndRead({ config, text: reportText, stateDir: STATE_DIR, preferConvId: args.conv, log });
const d = parseDecision(r.replyText || "");

let conv = gs.conversations.find((c) => c.convId === args.conv);
if (!conv) { conv = { convId: args.conv, label: "?", createdAt: new Date().toISOString(), rounds: [] }; gs.conversations.push(conv); }
conv.rounds = conv.rounds || [];
conv.rounds.push({ action: sigOf(action), taskId: ex.taskId, exitCode: ex.exitCode, decision: d.decision || null, replyId: r.replyId || null });
gs.currentConvId = args.conv;
gs.decisions.push({ stage: "round_once", conv: args.conv, action: sigOf(action), decision: d.decision || null });
gs.status = "STOPPED"; gs.finishedAt = new Date().toISOString();
saveGlobalState(GLOBAL_STATE_DEFAULT, gs);

console.log("ROUND_RESULT " + JSON.stringify({
  ok: !!r.ok,
  conv: args.conv,
  action: sigOf(action),
  taskId: ex.taskId,
  exitCode: ex.exitCode,
  status: ex.status,
  decision: d.decision,
  nextAction: d.nextAction,
  relayRunId: r.runId,
  replyId: r.replyId,
  replyText: (r.replyText || "").slice(0, 1200),
  globalState: "test/state/global_project_state.json",
}, null, 2));
process.exit(r.ok ? 0 : 1);
