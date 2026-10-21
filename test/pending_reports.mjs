// C9 待发报告持久化：幂等保存、发送认领（防重复投递）、状态机、崩溃恢复检查点
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PENDING_DIR_DEFAULT = path.join(__dirname, "state", "pending_reports");
export const CHECKPOINT_DEFAULT = path.join(__dirname, "state", "context_handoff_checkpoint.json");

export const STATUS = {
  PENDING: "PENDING",                 // 已持久化，未发送
  SENDING: "SENDING",                 // 已认领，发送中
  SENT: "SENT",                       // 已点击发送（消息已发出）
  REPLY_RECEIVED: "REPLY_RECEIVED",   // 已读到 GPT 回复
  DECISION_RETURNED: "DECISION_RETURNED", // 决策已解析并回传
  SEND_UNCONFIRMED: "SEND_UNCONFIRMED",   // 已发送但未确认回复（禁止自动重发）
  FAILED: "FAILED",
};
const DELIVERED = new Set([STATUS.SENT, STATUS.REPLY_RECEIVED, STATUS.DECISION_RETURNED]);

export function hashOf(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex").slice(0, 16);
}

export function persistPendingReport({ dir = PENDING_DIR_DEFAULT, text, project = null, sourceConvId = null, reportId = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const hash = hashOf(text);
  const id = reportId || `pr_${hash}`;
  for (const f of fs.readdirSync(dir)) {
    if (!/^pr_.+\.json$/.test(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (j.hash === hash) return { ok: true, existing: true, report: j, file: path.join(dir, f) };
    } catch {}
  }
  const now = new Date().toISOString();
  const report = {
    reportId: id, hash, project, sourceConvId, text: String(text || ""),
    status: STATUS.PENDING, attempts: 0, targetConvId: null,
    replyText: null, replyId: null, decision: null,
    createdAt: now, updatedAt: now, history: [{ at: now, status: STATUS.PENDING, reason: "persist" }],
  };
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
  return { ok: true, existing: false, report, file };
}

export function loadPendingReport(dir, reportId) {
  const f = path.join(dir, `${reportId}.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

export function savePendingReport(dir, report) {
  fs.mkdirSync(dir, { recursive: true });
  report.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${report.reportId}.json`), JSON.stringify(report, null, 2), "utf8");
  return report;
}

export function listPendingReports(dir = PENDING_DIR_DEFAULT) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^pr_.+\.json$/.test(f)).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; }
  }).filter(Boolean);
}

export function addHistory(report, status, reason) {
  report.history = report.history || [];
  report.history.push({ at: new Date().toISOString(), status, reason: String(reason || "").slice(0, 300) });
}

// 原子地设置状态并记录历史（避免只记历史不改状态）
export function setStatus(report, status, reason) {
  report.status = status;
  addHistory(report, status, reason);
  return report;
}

// 认领发送：同一条报告不得被并发或重复发送
export function claimForSend(report) {
  if (!report) return { ok: false, code: "NOT_FOUND" };
  if (report.status === STATUS.SENDING) return { ok: false, code: "SENDING_IN_FLIGHT" };
  if (DELIVERED.has(report.status)) return { ok: false, code: "ALREADY_DELIVERED", report };
  if (report.status === STATUS.FAILED) return { ok: false, code: "FAILED_NO_RETRY", report };
  report.status = STATUS.SENDING;
  report.attempts = (report.attempts || 0) + 1;
  addHistory(report, STATUS.SENDING, "claim");
  return { ok: true, report };
}

// 崩溃恢复：加载时仍为 SENDING → 视为结果未知，禁止自动重发
export function normalizeOnLoad(report) {
  if (report && report.status === STATUS.SENDING) {
    report.status = STATUS.SEND_UNCONFIRMED;
    addHistory(report, STATUS.SEND_UNCONFIRMED, "recovered: SENDING on load");
  }
  return report;
}

export function saveCheckpoint(file, cp) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...cp, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}
export function loadCheckpoint(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { corrupt: true }; }
}
