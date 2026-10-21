// C9 上下文耗尽恢复编排 单测（依赖注入，不访问浏览器）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { recoverFromContextLimit, resumePending, deliverPendingReport, reconcilePendingReport } from "./context_recovery.mjs";
import * as PR from "./pending_reports.mjs";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-recover-"));
const results = [];
let passed = 0;
async function record(name, fn) {
  try { await fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}
function env(tag) {
  const stateDir = path.join(BASE, tag, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  return { stateDir, checkpointFile: path.join(stateDir, "context_handoff_checkpoint.json"), dir: path.join(stateDir, "pending_reports") };
}
const REPORT_TEXT = "[AGENT_REPORT]\n\nproject: qwen-bench\n测试报告：B 类请裁定\n\n[/AGENT_REPORT]";
const exhausted = (text) => async () => ({
  pages: [],
  exhausted: [{ url: "https://chatgpt.com/c/aaaaaaaa-1111", page: {}, limit: { limit: true, signals: ["聊天上下文已用完"] }, draft: { found: true, text } }],
});

await record("R1 无上下文耗尽页 → NO_CONTEXT_LIMIT_DETECTED", async () => {
  const e = env("r1");
  const res = await recoverFromContextLimit({ config: {}, stateDir: e.stateDir, checkpointFile: e.checkpointFile, deps: { findExhaustedPage: async () => ({ pages: [], exhausted: [] }) } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NO_CONTEXT_LIMIT_DETECTED");
});

await record("R2 新建对话失败 → 明确失败、不发送、报告 FAILED", async () => {
  const e = env("r2");
  let sent = 0;
  const res = await recoverFromContextLimit({
    config: {}, stateDir: e.stateDir, checkpointFile: e.checkpointFile, attempts: 2,
    deps: {
      findExhaustedPage: exhausted(REPORT_TEXT),
      createNewConversation: async () => ({ ok: false, reason: "NEW_CONV_NOT_READY", attempts: 2 }),
      sendAndRead: async () => { sent++; return { ok: true, replyText: "", convId: "c2" }; },
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NEW_CONV_NOT_READY");
  assert.equal(sent, 0, "建会话失败不得发送");
  assert.equal(PR.listPendingReports(e.dir)[0].status, PR.STATUS.FAILED);
});

await record("R3 发送成功且有决策 → DECISION_RETURNED（消息含报告 hash）", async () => {
  const e = env("r3");
  let sentText = "", sent = 0;
  const res = await recoverFromContextLimit({
    config: {}, stateDir: e.stateDir, checkpointFile: e.checkpointFile,
    deps: {
      findExhaustedPage: exhausted(REPORT_TEXT),
      createNewConversation: async () => ({ ok: true, page: {}, targetId: "t2" }),
      sendAndRead: async ({ text }) => { sent++; sentText = text; return { ok: true, replyText: "decision: CONTINUE\nNEXT_ACTION: node_check test/x.mjs", replyId: "m1", convId: "c2" }; },
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.decision, "CONTINUE");
  assert.equal(res.nextAction.target, "test/x.mjs");
  assert.equal(sent, 1);
  assert.ok(sentText.includes(PR.hashOf(REPORT_TEXT)), "消息应包含 report_ref hash 供幂等读回");
  const rep = PR.listPendingReports(e.dir)[0];
  assert.equal(rep.status, PR.STATUS.DECISION_RETURNED);
  assert.equal(rep.decision, "CONTINUE");
});

await record("R4 已发送但回复读取失败 → SEND_UNCONFIRMED；恢复读回不重发", async () => {
  const e = env("r4");
  let sent = 0;
  const res = await recoverFromContextLimit({
    config: {}, stateDir: e.stateDir, checkpointFile: e.checkpointFile,
    deps: {
      findExhaustedPage: exhausted(REPORT_TEXT),
      createNewConversation: async () => ({ ok: true, page: {}, targetId: "t2" }),
      sendAndRead: async () => { sent++; return { ok: false, reason: "REPLY_TIMEOUT", convId: "c2" }; },
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, PR.STATUS.SEND_UNCONFIRMED);
  assert.equal(sent, 1);
  const hash = PR.hashOf(REPORT_TEXT);
  const r2 = await resumePending({
    config: {}, stateDir: e.stateDir, checkpointFile: e.checkpointFile,
    deps: { readFromConv: async () => ({ ok: true, snap: { msgs: [{ role: "user", text: "report_ref: " + hash }, { role: "assistant", text: "decision: CONTINUE" }] } }) },
  });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.decision, "CONTINUE");
  assert.equal(sent, 1, "恢复读回不得重发");
});

await record("R5 幂等：已 DECISION_RETURNED 再 recover → 不新建、不发送", async () => {
  const e = env("r5");
  let created = 0, sent = 0;
  const deps = {
    findExhaustedPage: exhausted(REPORT_TEXT),
    createNewConversation: async () => { created++; return { ok: true, page: {}, targetId: "t2" }; },
    sendAndRead: async () => { sent++; return { ok: true, replyText: "decision: CONTINUE", replyId: "m1", convId: "c2" }; },
  };
  const r1 = await recoverFromContextLimit({ config: {}, stateDir: e.stateDir, checkpointFile: e.checkpointFile, deps });
  assert.equal(r1.ok, true);
  const r2 = await recoverFromContextLimit({ config: {}, stateDir: e.stateDir, checkpointFile: e.checkpointFile, deps });
  assert.equal(r2.ok, true);
  assert.equal(r2.resumed, true);
  assert.equal(created, 1, "不得重复新建对话");
  assert.equal(sent, 1, "不得重复发送");
});

await record("R6 新对话仍上下文耗尽 → CONTEXT_LIMIT，报告保持 PENDING（未发送）", async () => {
  const e = env("r6");
  const res = await recoverFromContextLimit({
    config: {}, stateDir: e.stateDir, checkpointFile: e.checkpointFile,
    deps: {
      findExhaustedPage: exhausted(REPORT_TEXT),
      createNewConversation: async () => ({ ok: true, page: {}, targetId: "t2" }),
      sendAndRead: async () => ({ ok: false, reason: "CONTEXT_LIMIT", convId: null }),
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, PR.STATUS.PENDING);
});

await record("R7 崩溃恢复：报告 SENDING + 检查点 SENT → 先归一为 SEND_UNCONFIRMED，读回后 DECISION_RETURNED", async () => {
  const e = env("r7");
  const p = PR.persistPendingReport({ dir: e.dir, text: REPORT_TEXT, project: "qwen-bench", sourceConvId: "c1" }).report;
  p.status = PR.STATUS.SENDING; PR.savePendingReport(e.dir, p);
  PR.saveCheckpoint(e.checkpointFile, { reportId: p.reportId, status: PR.STATUS.SENT, newConvId: "c2", sourceConvId: "c1" });
  const hash = PR.hashOf(REPORT_TEXT);
  let sent = 0;
  const res = await resumePending({
    config: {}, stateDir: e.stateDir, checkpointFile: e.checkpointFile,
    deps: {
      readFromConv: async () => ({ ok: true, snap: { msgs: [{ role: "user", text: "report_ref: " + hash }, { role: "assistant", text: "decision: FIX" }] } }),
      sendAndRead: async () => { sent++; return { ok: true, replyText: "x", convId: "c2" }; },
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.decision, "FIX");
  assert.equal(sent, 0, "崩溃恢复不得重发");
});

await record("R8 投递卡住的报告：发送成功且解析出决策 → DECISION_RETURNED（含 report_ref）", async () => {
  const e = env("r8");
  let sentText = "", sent = 0;
  const res = await deliverPendingReport({
    config: {}, stateDir: e.stateDir, convId: "c9", text: REPORT_TEXT,
    deps: { sendAndRead: async ({ text }) => { sent++; sentText = text; return { ok: true, replyText: "decision: COMPLETE", replyId: "m9", convId: "c9" }; } },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.decision, "COMPLETE");
  assert.equal(sent, 1);
  assert.ok(sentText.includes(PR.hashOf(REPORT_TEXT)));
  assert.equal(PR.listPendingReports(e.dir)[0].status, PR.STATUS.DECISION_RETURNED);
});

await record("R9 同一报告再次投递 → alreadyDelivered，不重发", async () => {
  const e = env("r9");
  let sent = 0;
  const deps = { sendAndRead: async () => { sent++; return { ok: true, replyText: "decision: COMPLETE", replyId: "m9", convId: "c9" }; } };
  await deliverPendingReport({ config: {}, stateDir: e.stateDir, convId: "c9", text: REPORT_TEXT, deps });
  const r2 = await deliverPendingReport({ config: {}, stateDir: e.stateDir, convId: "c9", text: REPORT_TEXT, deps });
  assert.equal(r2.ok, true);
  assert.equal(r2.alreadyDelivered, true);
  assert.equal(sent, 1, "不得重复发送");
});

await record("R10 网络不可用（点击前）→ 报告保持 PENDING", async () => {
  const e = env("r10");
  const res = await deliverPendingReport({ config: {}, stateDir: e.stateDir, convId: "c9", text: REPORT_TEXT, deps: { sendAndRead: async () => ({ ok: false, reason: "NETWORK_UNAVAILABLE" }) } });
  assert.equal(res.ok, false);
  assert.equal(res.status, PR.STATUS.PENDING);
  assert.equal(PR.listPendingReports(e.dir)[0].status, PR.STATUS.PENDING);
});

await record("R11 网络回复超时（已点击）→ SEND_UNCONFIRMED（不自动重发）", async () => {
  const e = env("r11");
  const res = await deliverPendingReport({ config: {}, stateDir: e.stateDir, convId: "c9", text: REPORT_TEXT, deps: { sendAndRead: async () => ({ ok: false, reason: "NETWORK_REPLY_TIMEOUT", convId: "c9" }) } });
  assert.equal(res.ok, false);
  assert.equal(res.status, PR.STATUS.SEND_UNCONFIRMED);
});

await record("R12 对账：报告已在对话且其后无助手 → SENT（不重发）", async () => {
  const e = env("r12");
  const p = PR.persistPendingReport({ dir: e.dir, text: REPORT_TEXT, project: "qwen-bench", sourceConvId: "c1" }).report;
  p.status = PR.STATUS.SENDING; PR.savePendingReport(e.dir, p);
  PR.saveCheckpoint(e.checkpointFile, { reportId: p.reportId, status: PR.STATUS.SENDING, newConvId: "c9", sourceConvId: "c1" });
  const res = await reconcilePendingReport({
    config: {}, stateDir: e.stateDir, reportId: p.reportId, convId: "c9", checkpointFile: e.checkpointFile,
    deps: { readFromConv: async () => ({ ok: true, snap: { msgs: [{ role: "user", text: "report_ref: " + PR.hashOf(REPORT_TEXT) }] } }) },
  });
  assert.equal(res.found, true);
  assert.equal(res.status, PR.STATUS.SENT);
});

await record("R13 对账：报告不在对话 → PENDING（可稍后投递）", async () => {
  const e = env("r13");
  const p = PR.persistPendingReport({ dir: e.dir, text: REPORT_TEXT, project: "qwen-bench" }).report;
  p.status = PR.STATUS.SEND_UNCONFIRMED; PR.savePendingReport(e.dir, p);
  const res = await reconcilePendingReport({
    config: {}, stateDir: e.stateDir, reportId: p.reportId, convId: "c9", checkpointFile: e.checkpointFile,
    deps: { readFromConv: async () => ({ ok: true, snap: { msgs: [{ role: "assistant", text: "hi" }] } }) },
  });
  assert.equal(res.found, false);
  assert.equal(res.status, PR.STATUS.PENDING);
});

await record("R14 DOM 不可读但 relay 已发送凭证 → SENT（不重投）", async () => {
  const e = env("r14");
  const p = PR.persistPendingReport({ dir: e.dir, text: REPORT_TEXT, project: "qwen-bench" }).report;
  p.status = PR.STATUS.SEND_UNCONFIRMED; PR.savePendingReport(e.dir, p);
  fs.writeFileSync(path.join(e.stateDir, "relay_test.json"), JSON.stringify({ reportRef: p.hash, status: "SENT", targetUrl: "https://chatgpt.com/c/c9", textLen: REPORT_TEXT.length + 30 }), "utf8");
  const res = await reconcilePendingReport({
    config: {}, stateDir: e.stateDir, reportId: p.reportId, convId: "c9", checkpointFile: e.checkpointFile,
    deps: { readFromConv: async () => ({ ok: true, snap: { msgs: [] } }) },
  });
  assert.equal(res.found, true);
  assert.equal(res.status, PR.STATUS.SENT);
});

fs.rmSync(BASE, { recursive: true, force: true });
console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
