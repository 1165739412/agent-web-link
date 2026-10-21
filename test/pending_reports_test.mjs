// C9 待发报告持久化/幂等/状态机/检查点 单测
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import * as PR from "./pending_reports.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-pending-"));
const results = [];
let passed = 0;
function record(name, fn) {
  try { fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

record("P1 同内容幂等持久化（同 hash 只一份）", () => {
  const text = "[AGENT_REPORT]\nproject: qwen-bench\n内容";
  const a = PR.persistPendingReport({ dir: TMP, text, project: "qwen-bench", sourceConvId: "c1" });
  const b = PR.persistPendingReport({ dir: TMP, text, project: "qwen-bench", sourceConvId: "c1" });
  assert.equal(a.ok, true);
  assert.equal(b.existing, true);
  assert.equal(a.report.reportId, b.report.reportId);
  assert.equal(PR.listPendingReports(TMP).length, 1);
});

record("P2 认领发送防重复：SENDING 在飞 / 已送达 / 失败不重试", () => {
  const r = PR.persistPendingReport({ dir: TMP, text: "x2", project: "p" }).report;
  assert.equal(PR.claimForSend(r).ok, true);
  assert.equal(PR.claimForSend(r).code, "SENDING_IN_FLIGHT");
  r.status = PR.STATUS.SENT;
  assert.equal(PR.claimForSend(r).code, "ALREADY_DELIVERED");
  r.status = PR.STATUS.DECISION_RETURNED;
  assert.equal(PR.claimForSend(r).code, "ALREADY_DELIVERED");
  r.status = PR.STATUS.FAILED;
  assert.equal(PR.claimForSend(r).code, "FAILED_NO_RETRY");
});

record("P3 崩溃恢复：加载时 SENDING → SEND_UNCONFIRMED（不重发）", () => {
  const r = { reportId: "pr_x", status: PR.STATUS.SENDING, history: [] };
  PR.normalizeOnLoad(r);
  assert.equal(r.status, PR.STATUS.SEND_UNCONFIRMED);
  assert.ok(r.history.some((h) => h.status === PR.STATUS.SEND_UNCONFIRMED));
});

record("P4 检查点保存/读取/损坏识别", () => {
  const f = path.join(TMP, "cp.json");
  PR.saveCheckpoint(f, { reportId: "pr_1", status: PR.STATUS.SENT, newConvId: "c2" });
  const cp = PR.loadCheckpoint(f);
  assert.equal(cp.reportId, "pr_1");
  assert.equal(cp.status, PR.STATUS.SENT);
  fs.writeFileSync(f, "{broken");
  assert.equal(PR.loadCheckpoint(f).corrupt, true);
});

record("P5 save/load 往返保留历史", () => {
  const r = PR.persistPendingReport({ dir: TMP, text: "x5", project: "p" }).report;
  PR.addHistory(r, PR.STATUS.SENT, "sent");
  PR.savePendingReport(TMP, r);
  const back = PR.loadPendingReport(TMP, r.reportId);
  assert.ok(back.history.some((h) => h.status === PR.STATUS.SENT));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
