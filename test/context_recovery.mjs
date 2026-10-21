// C9 上下文耗尽自动续接：检测真实耗尽 → 保全草稿 → 新建可用对话 → 交接+原报告投递 → 读决策 → 检查点/恢复
// 原则：不把"新建对话成功"当完成；区分 已发送 / 已回复 / 决策已回传；SENDING 崩溃后不自动重发。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WSClient } from "./cdp_ws_client.mjs";
import { readConversation } from "./read_conversation.mjs";
import { sendAndRead, createNewConversation, detectContextLimit, readComposerText, isPageReady } from "./relay.mjs";
import { loadGlobalState, buildHandoff, GLOBAL_STATE_DEFAULT } from "./handoff.mjs";
import { parseDecision } from "./auto_loop.mjs";
import * as PR from "./pending_reports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CHECKPOINT = PR.CHECKPOINT_DEFAULT;
const CDP_DEFAULT = "http://127.0.0.1:9222";

export async function findExhaustedPage(config) {
  const cdp = config.cdpHost || CDP_DEFAULT;
  const list = await (await fetch(cdp + "/json/list")).json();
  const pages = list.filter((t) => t.type === "page" && /chatgpt\.com/.test(t.url));
  const out = [];
  for (const p of pages) {
    const c = await WSClient.connect(p.webSocketDebuggerUrl);
    let info = null, limit = null, draft = null;
    try { info = await isPageReady(c); limit = await detectContextLimit(c); draft = await readComposerText(c); }
    finally { await c.close("scan-limit"); }
    out.push({ page: p, url: p.url, info, limit, draft });
  }
  const exhausted = out.filter((x) => x.limit && x.limit.limit);
  return { pages: out, exhausted };
}

export async function capturePendingFromExhausted(stateDir, scan) {
  const cand = scan.exhausted.find((x) => x.draft && x.draft.found && x.draft.text.includes("[AGENT_REPORT]")) || scan.exhausted[0];
  if (!cand) return { ok: false, reason: "NO_EXHAUSTED_PAGE" };
  const text = cand.draft && cand.draft.text ? cand.draft.text : "";
  if (!text.trim()) return { ok: false, reason: "NO_DRAFT", url: cand.url };
  const project = (text.match(/project:\s*([A-Za-z0-9_.-]+)/) || [])[1] || null;
  const sourceConvId = (cand.url.match(/\/c\/([0-9a-fA-F-]+)/) || [])[1] || null;
  const r = PR.persistPendingReport({ dir: path.join(stateDir, "pending_reports"), text, project, sourceConvId });
  return { ok: true, page: cand.page, url: cand.url, limit: cand.limit, report: r.report, existing: r.existing, file: r.file };
}

async function defaultReadFromConv(config, convId) {
  const cdp = config.cdpHost || CDP_DEFAULT;
  let list;
  try { list = await (await fetch(cdp + "/json/list")).json(); }
  catch (e) { return { ok: false, reason: "CDP_UNAVAILABLE", error: e.message }; }
  const page = list.find((t) => t.type === "page" && String(t.url || "").includes(convId));
  if (!page) return { ok: false, reason: "TARGET_CONV_NOT_OPEN" };
  try {
    const c = await WSClient.connect(page.webSocketDebuggerUrl);
    try { const snap = await readConversation(c); return { ok: true, snap }; }
    finally { await c.close("resume-read"); }
  } catch (e) {
    return { ok: false, reason: "CDP_UNAVAILABLE", error: e.message };
  }
}

// 点击前失败（未真正发出）→ 保持 PENDING；点击后不确定 → SEND_UNCONFIRMED
function isPreSendFailure(reason) {
  return ["CONTEXT_LIMIT", "NETWORK_UNAVAILABLE", "NETWORK_TYPE_FAILED", "NETWORK_CLICK_FAILED", "NETWORK_AND_CONTEXT_LIMIT"].includes(reason);
}

// 发送凭证：优先使用 relay 记录（含 reportRef；兼容旧记录按目标+长度匹配），避免 DOM 虚拟化/断网造成假阴性
function relaySendEvidence(stateDir, report, convId) {
  let best = null;
  try {
    for (const f of fs.readdirSync(stateDir)) {
      if (!/^relay_.+\.json$/.test(f) || f === "relay_latest.json") continue;
      let r; try { r = JSON.parse(fs.readFileSync(path.join(stateDir, f), "utf8")); } catch { continue; }
      const sameRef = r.reportRef && r.reportRef === report.hash;
      // 旧记录（无 reportRef）仅在"投递消息长度≈报告长度+report_ref 行"时匹配，避免误配交接消息
      const expectedDeliverLen = report.text.length + 30;
      const legacy = !r.reportRef && String(r.targetUrl || "").includes(String(convId)) && ["SENT", "REPLY_RECEIVED", "UNKNOWN"].includes(r.status)
        && typeof r.textLen === "number" && Math.abs(r.textLen - expectedDeliverLen) <= 40;
      if (!sameRef && !legacy) continue;
      if (!best || (r.status === "REPLY_RECEIVED" && best.status !== "REPLY_RECEIVED")) best = r;
    }
  } catch {}
  return best;
}

// 只读对账：判断报告是否已出现在目标对话（网络恢复后先做，避免重复投递）
export async function reconcilePendingReport({ config, stateDir, reportId, convId, log = () => {}, checkpointFile = null, deps = {} }) {
  checkpointFile = checkpointFile || path.join(stateDir, "context_handoff_checkpoint.json");
  const dir = path.join(stateDir, "pending_reports");
  const loadRep = deps.loadPendingReport || PR.loadPendingReport;
  const saveRep = deps.savePendingReport || PR.savePendingReport;
  const saveCp = deps.saveCheckpoint || PR.saveCheckpoint;
  const report = loadRep(dir, reportId);
  if (!report) return { ok: false, reason: "REPORT_MISSING", reportId };
  PR.normalizeOnLoad(report);
  const target = convId || report.targetConvId;
  if (!target) { saveRep(dir, report); return { ok: false, reason: "NO_TARGET_CONV", reportId, status: report.status }; }
  const evidence0 = relaySendEvidence(stateDir, report, target);
  const rd = await (deps.readFromConv || defaultReadFromConv)(config, target);
  if (!rd.ok) {
    if (evidence0) {
      const lastA0 = evidence0.status === "REPLY_RECEIVED" && evidence0.replyText ? { text: evidence0.replyText, id: evidence0.replyId || null } : null;
      const d0 = parseDecision(lastA0 ? lastA0.text : "");
      const st = lastA0 ? (d0.decision ? PR.STATUS.DECISION_RETURNED : PR.STATUS.REPLY_RECEIVED) : PR.STATUS.SENT;
      report.targetConvId = target;
      report.replyText = lastA0 ? lastA0.text : report.replyText;
      report.replyId = lastA0 ? (lastA0.id || report.replyId) : report.replyId;
      report.decision = d0.decision || null;
      PR.setStatus(report, st, `reconcile(dom-unavailable) evidence=${evidence0.status} decision=${d0.decision || "-"}`);
      saveRep(dir, report);
      saveCp(checkpointFile, { reportId, status: st, sourceConvId: report.sourceConvId, newConvId: target, decision: report.decision || null, replyId: report.replyId || null });
      return { ok: true, domUnavailable: true, reportId, convId: target, found: true, status: st, decision: d0.decision || null, replyText: (lastA0 ? lastA0.text : "").slice(0, 1200) };
    }
    saveRep(dir, report);
    return { ok: false, reason: rd.reason, reportId, status: report.status };
  }
  const snap = rd.snap || { msgs: [] };
  const msgs = snap.msgs || [];
  const idx = msgs.findIndex((m) => m.role === "user" && String(m.text || "").includes(report.hash));
  const domFound = idx >= 0;
  const after = domFound ? msgs.slice(idx + 1).filter((m) => m.role === "assistant") : [];
  const domLastA = after.slice(-1)[0] || null;
  const evidence = evidence0;

  // 发送凭证优先（网络/虚拟化下 DOM 不可靠）；无凭证才回退 DOM
  let found = false, lastA = null;
  if (evidence) {
    found = ["SENT", "REPLY_RECEIVED", "UNKNOWN"].includes(evidence.status);
    if (evidence.status === "REPLY_RECEIVED" && evidence.replyText) lastA = { text: evidence.replyText, id: evidence.replyId || null };
  } else {
    found = domFound;
    lastA = domLastA;
  }
  const d = parseDecision(lastA ? lastA.text : "");
  let status;
  if (found) {
    report.replyText = lastA ? lastA.text : report.replyText;
    report.replyId = lastA ? (lastA.id || report.replyId) : report.replyId;
    if (lastA && d.decision) { report.decision = d.decision; status = PR.STATUS.DECISION_RETURNED; }
    else if (lastA) { report.decision = null; status = PR.STATUS.REPLY_RECEIVED; }
    else { report.decision = null; status = PR.STATUS.SENT; } // 已发出，回复未确认（不重发）
  } else {
    status = PR.STATUS.PENDING; // 无发送凭证且 DOM 未见 → 可安全稍后投递
  }
  report.targetConvId = target;
  PR.setStatus(report, status, `reconcile found=${found} decision=${d.decision || "-"}`);
  saveRep(dir, report);
  saveCp(checkpointFile, { reportId, status, sourceConvId: report.sourceConvId, newConvId: target, decision: report.decision || null, replyId: report.replyId || null });
  return { ok: true, reportId, convId: target, found, status, decision: d.decision || null, replyText: (lastA ? lastA.text : "").slice(0, 1200) };
}

export async function recoverFromContextLimit({ config, stateDir, log = () => {}, dryRun = false, attempts = 2, checkpointFile = null, deps = {} }) {
  checkpointFile = checkpointFile || path.join(stateDir, "context_handoff_checkpoint.json");
  const find = deps.findExhaustedPage || findExhaustedPage;
  const create = deps.createNewConversation || createNewConversation;
  const send = deps.sendAndRead || sendAndRead;
  const dir = path.join(stateDir, "pending_reports");

  // 先恢复未完成交接（不重发）
  const cp0 = PR.loadCheckpoint(checkpointFile);
  if (!dryRun && cp0 && !cp0.corrupt && [PR.STATUS.SENT, PR.STATUS.REPLY_RECEIVED, PR.STATUS.DECISION_RETURNED, PR.STATUS.SEND_UNCONFIRMED].includes(cp0.status)) {
    const r = await resumePending({ config, stateDir, log, checkpointFile, deps });
    if (r.ok) return { ...r, resumedFirst: true };
  }

  const scan = await find(config);
  if (!scan.exhausted.length) {
    return { ok: false, reason: "NO_CONTEXT_LIMIT_DETECTED", pages: scan.pages.map((p) => ({ url: p.url, limit: p.limit, ready: p.info && p.info.ready })) };
  }
  const cap = await capturePendingFromExhausted(stateDir, scan);
  if (!cap.ok) return { ok: false, reason: cap.reason, url: cap.url };
  const report = PR.normalizeOnLoad(cap.report);
  PR.savePendingReport(dir, report);

  if (dryRun) {
    return { ok: true, dryRun: true, sourceConv: report.sourceConvId, reportId: report.reportId, hash: report.hash, status: report.status, textLen: (report.text || "").length, limit: cap.limit, existing: cap.existing, checkpoint: cp0 };
  }

  // 已有交接且已发送 → 恢复读回，不重发
  if (cp0 && cp0.reportId === report.reportId && [PR.STATUS.SENT, PR.STATUS.REPLY_RECEIVED, PR.STATUS.DECISION_RETURNED, PR.STATUS.SEND_UNCONFIRMED].includes(cp0.status)) {
    return await resumePending({ config, stateDir, log, checkpointFile, deps });
  }

  const created = await create({ config, log, attempts });
  if (!created.ok) {
    PR.setStatus(report, PR.STATUS.FAILED, "create new conversation failed: " + (created.reason || ""));
    PR.savePendingReport(dir, report);
    PR.saveCheckpoint(checkpointFile, { reportId: report.reportId, status: PR.STATUS.FAILED, reason: "NEW_CONV_NOT_READY", sourceConvId: report.sourceConvId, newConvId: null });
    return { ok: false, reason: "NEW_CONV_NOT_READY", detail: created };
  }

  const handoffId = "H-" + Date.now().toString(36);
  const gs = loadGlobalState(GLOBAL_STATE_DEFAULT);
  const handoff = buildHandoff({
    goal: (gs && gs.goal) || "「互联」项目：上下文耗尽后自动续接",
    acceptance: (gs && gs.acceptance) || [],
    constraints: (gs && gs.constraints) || [],
    progress: gs && gs.conversations ? gs.conversations.map((c) => `${c.label || c.convId}: ${(c.rounds || []).length} 轮`) : [],
    completed: [],
    evidence: [],
    pending: [`待处理原报告 reportId=${report.reportId} (project=${report.project || "unknown"})`],
    handoffId,
    completedSignatures: (gs && gs.executedSignatures) || [],
  });
  const message = `${handoff}\n\n---\nreport_ref: ${report.hash}\n以下是需要你处理的原报告（原样转发，未重新执行已完成任务；请直接给出决策）：\n\n${report.text}\n`;

  const claimed = PR.claimForSend(report);
  if (!claimed.ok) return await resumePending({ config, stateDir, log, checkpointFile, deps });
  PR.savePendingReport(dir, report);

  const sent = await send({ config, text: message, stateDir, overridePage: created.page, log, reportRef: report.hash });
  if (!sent.ok) {
    const status = isPreSendFailure(sent.reason) ? PR.STATUS.PENDING : PR.STATUS.SEND_UNCONFIRMED;
    report.targetConvId = sent.convId || null;
    PR.setStatus(report, status, "send result: " + sent.reason);
    PR.savePendingReport(dir, report);
    PR.saveCheckpoint(checkpointFile, { reportId: report.reportId, status, sourceConvId: report.sourceConvId, newConvId: sent.convId || null, handoffId, reason: sent.reason });
    return { ok: false, reason: sent.reason, reportId: report.reportId, newConvId: sent.convId || null, status };
  }

  report.targetConvId = sent.convId;
  PR.setStatus(report, PR.STATUS.SENT, "sent");
  PR.savePendingReport(dir, report);

  const decision = parseDecision(sent.replyText || "");
  report.replyText = sent.replyText; report.replyId = sent.replyId; report.decision = decision.decision || null;
  PR.setStatus(report, PR.STATUS.REPLY_RECEIVED, "reply received");
  if (decision.decision) PR.setStatus(report, PR.STATUS.DECISION_RETURNED, "decision=" + decision.decision);
  PR.savePendingReport(dir, report);
  PR.saveCheckpoint(checkpointFile, {
    reportId: report.reportId,
    status: decision.decision ? PR.STATUS.DECISION_RETURNED : PR.STATUS.REPLY_RECEIVED,
    sourceConvId: report.sourceConvId,
    newConvId: sent.convId,
    handoffId,
    decision: decision.decision || null,
    replyId: sent.replyId || null,
  });

  return {
    ok: !!decision.decision,
    reason: decision.decision ? undefined : "NO_DECISION_PARSED",
    reportId: report.reportId,
    sourceConv: report.sourceConvId,
    newConvId: sent.convId,
    handoffId,
    status: report.status,
    decision: decision.decision || null,
    nextAction: decision.nextAction || null,
    replyText: (sent.replyText || "").slice(0, 1500),
  };
}

export async function resumePending({ config, stateDir, log = () => {}, checkpointFile = null, deps = {} }) {
  checkpointFile = checkpointFile || path.join(stateDir, "context_handoff_checkpoint.json");
  const loadCp = deps.loadCheckpoint || PR.loadCheckpoint;
  const loadRep = deps.loadPendingReport || PR.loadPendingReport;
  const saveRep = deps.savePendingReport || PR.savePendingReport;
  const readFromConv = deps.readFromConv || defaultReadFromConv;

  const cp = loadCp(checkpointFile);
  if (!cp || cp.corrupt) return { ok: false, reason: "NO_CHECKPOINT" };
  const dir = path.join(stateDir, "pending_reports");
  const report = loadRep(dir, cp.reportId);
  if (!report) return { ok: false, reason: "REPORT_MISSING", checkpoint: cp };
  PR.normalizeOnLoad(report);

  if (report.status === PR.STATUS.DECISION_RETURNED && report.decision) {
    return { ok: true, resumed: true, reportId: report.reportId, newConvId: cp.newConvId, status: report.status, decision: report.decision, replyText: (report.replyText || "").slice(0, 1500) };
  }
  if (!cp.newConvId) return { ok: false, reason: "NO_TARGET_CONV", checkpoint: cp };

  const rd = await readFromConv(config, cp.newConvId);
  if (!rd.ok) return { ok: false, reason: rd.reason, newConvId: cp.newConvId };
  const snap = rd.snap;
  const msgs = snap.msgs || [];
  const idx = msgs.findIndex((m) => m.role === "user" && String(m.text || "").includes(report.hash));
  const found = idx >= 0;
  const after = found ? msgs.slice(idx + 1).filter((m) => m.role === "assistant") : [];
  const lastA = after.slice(-1)[0] || null;
  const decision = parseDecision(lastA ? lastA.text : "");
  report.status = decision.decision ? PR.STATUS.DECISION_RETURNED : (found ? (lastA ? PR.STATUS.REPLY_RECEIVED : PR.STATUS.SENT) : PR.STATUS.SEND_UNCONFIRMED);
  if (lastA && found) report.replyText = lastA.text;
  if (decision.decision) report.decision = decision.decision;
  PR.addHistory(report, report.status, `resume readback found=${found} decision=${decision.decision || "-"}`);
  saveRep(dir, report);
  (deps.saveCheckpoint || PR.saveCheckpoint)(checkpointFile, { ...cp, status: report.status, decision: report.decision || null });
  return { ok: !!decision.decision, reason: decision.decision ? undefined : "NO_DECISION_PARSED", resumed: true, reportId: report.reportId, newConvId: cp.newConvId, status: report.status, decision: decision.decision || null, nextAction: decision.nextAction || null, found, replyText: (lastA ? lastA.text : "").slice(0, 1500) };
}

// 通用：投递一份"已存在但未发送"的报告到指定可用对话（不要求上下文耗尽）
// 用于修复"报告卡在输入框/协调器中断"的场景；幂等、不重复发送。
export async function deliverPendingReport({ config, stateDir, convId, text, project = null, log = () => {}, checkpointFile = null, deps = {} }) {
  checkpointFile = checkpointFile || path.join(stateDir, "context_handoff_checkpoint.json");
  const dir = path.join(stateDir, "pending_reports");
  const proj = project || (String(text).match(/project:\s*([A-Za-z0-9_.-]+)/) || [])[1] || null;
  const p = PR.persistPendingReport({ dir, text, project: proj, sourceConvId: convId });
  const report = PR.normalizeOnLoad(p.report);
  PR.savePendingReport(dir, report);

  if (report.status === PR.STATUS.DECISION_RETURNED && report.decision) {
    return { ok: true, alreadyDelivered: true, reportId: report.reportId, convId: report.targetConvId || convId, decision: report.decision, replyText: (report.replyText || "").slice(0, 1500) };
  }
  const claimed = PR.claimForSend(report);
  if (!claimed.ok) return { ok: false, reason: claimed.code, reportId: report.reportId, status: report.status };
  PR.savePendingReport(dir, report);

  const message = `report_ref: ${report.hash}\n\n${text}`;
  const sent = await (deps.sendAndRead || sendAndRead)({ config, text: message, stateDir, preferConvId: convId, log, reportRef: report.hash });
  if (!sent.ok) {
    const status = isPreSendFailure(sent.reason) ? PR.STATUS.PENDING : PR.STATUS.SEND_UNCONFIRMED;
    report.targetConvId = sent.convId || convId;
    PR.setStatus(report, status, "send result: " + sent.reason);
    PR.savePendingReport(dir, report);
    PR.saveCheckpoint(checkpointFile, { reportId: report.reportId, status, sourceConvId: convId, newConvId: sent.convId || convId, reason: sent.reason });
    return { ok: false, reason: sent.reason, reportId: report.reportId, convId: sent.convId || convId, status };
  }
  report.targetConvId = sent.convId || convId;
  PR.setStatus(report, PR.STATUS.SENT, "sent");
  PR.savePendingReport(dir, report);

  const d = parseDecision(sent.replyText || "");
  report.replyText = sent.replyText; report.replyId = sent.replyId; report.decision = d.decision || null;
  PR.setStatus(report, PR.STATUS.REPLY_RECEIVED, "reply received");
  if (d.decision) PR.setStatus(report, PR.STATUS.DECISION_RETURNED, "decision=" + d.decision);
  PR.savePendingReport(dir, report);
  PR.saveCheckpoint(checkpointFile, { reportId: report.reportId, status: report.status, sourceConvId: convId, newConvId: report.targetConvId, decision: d.decision || null, replyId: sent.replyId || null });

  return { ok: !!d.decision, reason: d.decision ? undefined : "NO_DECISION_PARSED", reportId: report.reportId, convId: report.targetConvId, status: report.status, decision: d.decision || null, nextAction: d.nextAction || null, replyText: (sent.replyText || "").slice(0, 1500) };
}

// ---- CLI ----
const __isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (__isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const resume = args.includes("--resume");
  const ai = args.indexOf("--attempts");
  const attempts = ai >= 0 ? Math.max(1, parseInt(args[ai + 1], 10) || 2) : 2;
  const { loadRelayConfig } = await import("./relay.mjs");
  const loaded = loadRelayConfig();
  if (!loaded.ok) { console.error("CFG " + loaded.error); process.exit(64); }
  const config = loaded.config;
  const stateDir = path.join(__dirname, "state");
  const log = (m) => console.error("[RECOVERY] " + m);
  const fi = args.indexOf("--deliver-file");
  const ci = args.indexOf("--conv");
  const ri = args.indexOf("--report");
  let fn;
  if (fi < 0 && ri >= 0) {
    fn = reconcilePendingReport({ config, stateDir, reportId: args[ri + 1], convId: ci >= 0 ? args[ci + 1] : null, log });
  } else if (fi >= 0 && ci >= 0) {
    const text = fs.readFileSync(args[fi + 1], "utf8");
    fn = deliverPendingReport({ config, stateDir, convId: args[ci + 1], text, log });
  } else if (resume) {
    fn = resumePending({ config, stateDir, log });
  } else {
    fn = recoverFromContextLimit({ config, stateDir, log, dryRun, attempts });
  }
  fn.then((res) => {
    console.log("RECOVERY_RESULT " + JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }).catch((e) => { console.error("RECOVERY_ERROR " + e.message); process.exit(3); });
}
