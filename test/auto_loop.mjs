// C9 无人值守自动闭环：本地 worker 执行白名单动作 → 报告 → ChatGPT 决策 → 解析下一步 → 自动下一轮
// 设计原则:
//   - 协调器不判断业务；只把 ChatGPT 的 decision / NEXT_ACTION 作为调度输入，无法安全解释则停止（不猜测）；
//   - 执行入口复用 local_service worker（agent_executor 白名单：node_check / run_project_tests），本进程不调用宿主 Agent；
//   - 每轮持久化状态（RUNNING/STOPPED），崩溃后拒绝自动重跑；动作签名去重防重复执行；
//   - 有界：maxRounds / minRounds / maxTotalMs / intervalMs。
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTaskService, DEFAULT_PROJECTS_FILE, DEFAULT_TOKEN_FILE } from "./local_service.mjs";
import { loadRelayConfig, sendAndRead } from "./relay.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATE_FILE = path.join(__dirname, "state", "auto_loop_state.json");
const PROJECT = "agent-link";

export const DECISIONS = ["CONTINUE", "FIX", "COMPLETE", "STOP", "ASK_USER"];

// 解析 ChatGPT 回复：decision + 可选 NEXT_ACTION（node_check 目标）
export function parseDecision(text) {
  const t = String(text || "");
  // 取最后一个 decision 作为结论（回复可能先叙述 CONTINUE、结尾再给出最终 ASK_USER/COMPLETE）
  const decMatches = [...t.matchAll(/decision\s*[:：]\s*(CONTINUE|FIX|COMPLETE|STOP|ASK_USER)/gi)];
  const decision = decMatches.length ? decMatches[decMatches.length - 1][1].toUpperCase() : null;
  let nextAction = null;
  // 优先显式 NEXT_ACTION
  let m = t.match(/NEXT_ACTION\s*[:：]\s*(?:node\s*--?check|node_check)\s+([^\s,;，；。）)]+)/i);
  if (m) nextAction = { op: "node_check", target: cleanTarget(m[1]) };
  if (!nextAction) {
    m = t.match(/node\s*--?check\s+([A-Za-z0-9_./\\-]+\.(?:mjs|js|cjs))/i);
    if (m) nextAction = { op: "node_check", target: cleanTarget(m[1]) };
  }
  // 记录原始 decision 片段：区分"没有给出决策"与"决策非法/写成 ?"（反馈：decision=? 无校验）
  const anyDec = [...t.matchAll(/decision\s*[:：]\s*([^\s\n#，,。;；]+)/gi)];
  const rawDecision = anyDec.length ? anyDec[anyDec.length - 1][1].trim() : null;
  return { decision, nextAction, rawDecision, valid: !!decision };
}

function cleanTarget(s) {
  return String(s || "").replace(/[`"'“”‘’。；，、,;）)]+$/g, "").replace(/^[`"'“”‘’]+/g, "").trim();
}

export function sigOf(action) {
  return `${action.op}:${String(action.target || "").replace(/\\/g, "/")}`;
}

// 提供候选目标给 ChatGPT 选择（避免其"猜测路径"）：项目内 test/*.js 且本循环尚未检查
export function listCandidateTargets(executedSignatures = [], limit = 12) {
  const root = path.resolve(__dirname, "..");
  const out = [];
  let names = [];
  try { names = fs.readdirSync(path.join(root, "test")); } catch { return out; }
  for (const n of names) {
    if (!/\.(mjs|js|cjs)$/i.test(n)) continue;
    const rel = `test/${n}`;
    if (executedSignatures.includes(`node_check:${rel}`)) continue;
    out.push(rel);
  }
  return out.sort().slice(0, limit);
}

// 默认执行入口：local_service worker（白名单动作，真实执行并写报告）
export function makeWorkerExec({ project = PROJECT, projectsFile = DEFAULT_PROJECTS_FILE, tokenFile = DEFAULT_TOKEN_FILE, log = () => {}, idleTimeoutMs = 90000 } = {}) {
  return async (action, round) => {
    const svc = createTaskService({ projectsFile, tokenFile, log });
    const taskId = `t-loop-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
    const summary = `${action.op} ${action.target}（无人值守自动闭环 第 ${round} 轮）`;
    const sub = svc.submit({ project, taskId, summary, actions: [action], mode: "worker" });
    if (!sub.ok) return { ok: false, taskId, status: "SUBMIT_FAILED", exitCode: null, evidence: { submit: sub } };
    try { await svc.awaitIdle(idleTimeoutMs); } catch (e) { return { ok: false, taskId, status: "EXEC_TIMEOUT", exitCode: null, evidence: { error: e.message } }; }
    const st = svc.status({ project, taskId });
    const rep = svc.report({ project, taskId });
    const report = rep.ok ? rep.report : null;
    const r0 = report && Array.isArray(report.results) ? report.results[0] : null;
    return {
      ok: !!(report && report.status === "ACTIONS_DONE"),
      taskId,
      status: report ? report.status : "UNKNOWN",
      exitCode: r0 ? r0.exitCode : null,
      phase: st.ok ? st.task.phase : null,
      report,
    };
  };
}

export function buildLoopReport({ round, maxRounds, minRounds, goal, action, ex, candidates = [] }) {
  const r0 = ex && ex.report && Array.isArray(ex.report.results) ? ex.report.results[0] : null;
  const stderr = r0 && r0.stderr ? String(r0.stderr).slice(0, 300) : "";
  const lines = [
    "[AGENT_REPORT]",
    `task_id: ${ex && ex.taskId ? ex.taskId : "unknown"}`,
    `round: ${round}/${maxRounds}`,
    `status: ${ex && ex.status ? ex.status : "UNKNOWN"}`,
    `goal: ${goal}`,
    "completed: false",
    `action: ${action.op} ${action.target}`,
    "evidence:",
    `- command: node --check ${action.target}`,
    `- exitCode: ${ex && ex.exitCode != null ? ex.exitCode : "null"}`,
    `- stderr: ${stderr ? JSON.stringify(stderr) : "空"}`,
    `problems: ${r0 && r0.ok ? "无" : "动作未成功或结果未知"}`,
    `next_suggestion: 无人值守自动闭环验收要求至少连续 ${minRounds} 轮自动接管；若需继续，请 decision=CONTINUE 并给出 NEXT_ACTION`,
    `available_next_targets: ${candidates.length ? candidates.join(", ") : "（本项目 test 目录下已无未检查的 JS 文件）"}`,
    "[/AGENT_REPORT]",
    "",
    `若 decision=CONTINUE 或 FIX，请从 available_next_targets 中选择一个，并在回复中包含一行：NEXT_ACTION: node_check <相对路径>。`,
    "decision 取 CONTINUE / FIX / COMPLETE / STOP / ASK_USER 之一。不要输出 AGENT_TASK_BEGIN 任务块。",
  ];
  return lines.join("\n");
}

export function loadLoopState(file) {
  if (!fs.existsSync(file)) return { status: "IDLE", rounds: [], executedSignatures: [], startedAt: null };
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { status: "CORRUPT", rounds: [], executedSignatures: [], startedAt: null }; }
}

function saveLoopState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

export function archiveLoopState(file, log = () => {}) {
  if (!fs.existsSync(file)) return null;
  const dest = file.replace(/\.json$/, `.${Date.now().toString(36)}.archived.json`);
  fs.renameSync(file, dest);
  log(`[LOOP] 旧状态已归档: ${path.basename(dest)}`);
  return dest;
}

// 纯调度核心（依赖注入，便于单测）
export async function runAutoLoop({
  seedAction,
  goal = "验证 Agent 与 ChatGPT 无人值守自动闭环",
  maxRounds = 4,
  minRounds = 2,
  maxTotalMs = 600000,
  intervalMs = 2000,
  stateFile = DEFAULT_STATE_FILE,
  execFn,
  relayFn,
  candidateLister = null,
  reset = false,
  log = () => {},
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (reset) archiveLoopState(stateFile, log);
  const state = loadLoopState(stateFile);
  if (state.status === "RUNNING") {
    return { ok: false, stopReason: "PREV_CRASH_UNRESOLVED", rounds: state.rounds || [] };
  }
  state.status = "RUNNING";
  state.startedAt = state.startedAt || new Date().toISOString();
  state.executedSignatures = Array.isArray(state.executedSignatures) ? state.executedSignatures : [];
  saveLoopState(stateFile, state);

  const rounds = [];
  let action = seedAction;
  let stopReason = null;
  const t0 = Date.now();

  for (let round = 1; round <= maxRounds; round++) {
    if (Date.now() - t0 >= maxTotalMs) { stopReason = "MAX_TOTAL_MS"; break; }
    if (!action) { stopReason = "NO_ACTION"; break; }
    const sig = sigOf(action);
    if (state.executedSignatures.includes(sig)) { stopReason = "DUPLICATE_ACTION"; break; }
    log(`[LOOP] === 第 ${round}/${maxRounds} 轮 action=${sig} ===`);

    const ex = await execFn(action, round);
    state.executedSignatures.push(sig);
    const candidates = candidateLister ? candidateLister(state.executedSignatures) : listCandidateTargets(state.executedSignatures);
    const reportText = buildLoopReport({ round, maxRounds, minRounds, goal, action, ex, candidates });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const reportFile = stateFile.replace(/\.json$/, `.round${round}.report.txt`);
    fs.writeFileSync(reportFile, reportText, "utf8");

    const relay = await relayFn({ text: reportText, round, action, ex });
    const replyText = (relay && relay.replyText) || "";
    const parsed = parseDecision(replyText);
    const rec = {
      round, action, signature: sig, taskId: ex && ex.taskId, status: ex && ex.status, exitCode: ex && ex.exitCode,
      relayOk: !!(relay && relay.ok), relayRunId: relay && relay.runId, relayReplyId: relay && relay.replyId,
      decision: parsed.decision, nextAction: parsed.nextAction, replyText: replyText.slice(0, 4000),
      at: new Date().toISOString(),
    };
    rounds.push(rec);
    state.rounds = rounds;
    saveLoopState(stateFile, state);
    log(`[LOOP] 第 ${round} 轮完成: exec=${ex && ex.status} decision=${parsed.decision} next=${parsed.nextAction ? sigOf(parsed.nextAction) : "-"}`);

    if (!relay || !relay.ok) { stopReason = "RELAY_FAILED"; break; }
    if (parsed.decision === "COMPLETE" || parsed.decision === "STOP") {
      if (round < minRounds) { stopReason = "COMPLETE_BEFORE_MIN_ROUNDS"; break; }
      stopReason = parsed.decision; break;
    }
    if (parsed.decision === "ASK_USER") { stopReason = "ASK_USER"; break; }
    if (parsed.decision === "CONTINUE" || parsed.decision === "FIX") {
      if (!parsed.nextAction) { stopReason = "NO_ACTION_IN_REPLY"; break; }
      action = parsed.nextAction;
      if (round < maxRounds) await sleepFn(intervalMs);
      continue;
    }
    stopReason = "UNPARSEABLE_DECISION"; break;
  }
  if (!stopReason) stopReason = "MAX_ROUNDS";

  state.status = "STOPPED";
  state.stopReason = stopReason;
  state.finishedAt = new Date().toISOString();
  saveLoopState(stateFile, state);
  const ok = rounds.length >= minRounds && ["COMPLETE", "STOP"].includes(stopReason);
  return { ok, stopReason, rounds, executedSignatures: state.executedSignatures, stateFile };
}

// ---- CLI ----
function parseArgs(argv) {
  const out = { maxRounds: 4, minRounds: 2, maxTotalMs: 600000, intervalMs: 2000, seed: null, goal: null, reset: false, stateFile: DEFAULT_STATE_FILE, configFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-rounds") out.maxRounds = Math.max(1, parseInt(argv[++i], 10) || 4);
    else if (argv[i] === "--min-rounds") out.minRounds = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (argv[i] === "--max-total-ms") out.maxTotalMs = Math.max(30000, parseInt(argv[++i], 10) || 600000);
    else if (argv[i] === "--interval-ms") out.intervalMs = Math.max(0, parseInt(argv[++i], 10) || 2000);
    else if (argv[i] === "--seed") out.seed = argv[++i];
    else if (argv[i] === "--goal") out.goal = argv[++i];
    else if (argv[i] === "--state-file") out.stateFile = argv[++i];
    else if (argv[i] === "--config") out.configFile = argv[++i];
    else if (argv[i] === "--reset") out.reset = true;
  }
  return out;
}

function parseSeed(s) {
  if (!s) return null;
  const m = String(s).match(/^\s*(?:node\s*--?check|node_check)\s+(\S+)\s*$/i);
  if (!m) return null;
  return { op: "node_check", target: m[1].replace(/[`"'。；，,]/g, "").trim() };
}

const __isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (__isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const seedAction = parseSeed(opts.seed);
  if (!seedAction) { console.error("缺少或非法 --seed，示例：--seed \"node_check test/mcp_server.mjs\""); process.exit(64); }
  const loaded = loadRelayConfig({ file: opts.configFile || undefined });
  if (!loaded.ok) { console.error("RELAY_CFG_ERROR " + loaded.error); process.exit(64); }
  const config = loaded.config;
  const relayFn = async ({ text }) => sendAndRead({ config, text, stateDir: path.join(__dirname, "state"), log: (m) => console.error(m) });
  const execFn = makeWorkerExec({ log: (m) => console.error(m) });
  runAutoLoop({
    seedAction, goal: opts.goal || "验证 Agent 与 ChatGPT 无人值守自动闭环",
    maxRounds: opts.maxRounds, minRounds: opts.minRounds, maxTotalMs: opts.maxTotalMs, intervalMs: opts.intervalMs,
    stateFile: opts.stateFile, execFn, relayFn, reset: opts.reset, log: (m) => console.error(m),
  }).then((res) => {
    console.log("AUTO_LOOP_RESULT " + JSON.stringify({ ok: res.ok, stopReason: res.stopReason, rounds: (res.rounds || []).map((r) => ({ round: r.round, action: r.signature, status: r.status, exitCode: r.exitCode, decision: r.decision, next: r.nextAction }) ) }, null, 2));
    process.exit(res.ok ? 0 : 1);
  }).catch((e) => { console.error("AUTO_LOOP_ERROR " + e.message); process.exit(3); });
}
