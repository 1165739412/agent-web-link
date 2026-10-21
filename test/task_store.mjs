// C9 任务登记簿：任务去重、阶段追踪与恢复基础（纯本地 JSON，无依赖）
// 阶段: NEW → EXECUTED → REPORTED → (DONE|FAILED|BLOCKED|STOPPED|NEEDS_INPUT|REPORT_UNKNOWN)
// 去重规则:
//   - taskId 重复 → 拒绝注册（旧任务/重复任务不重复执行）
//   - assistantMsgId 重复 → 拒绝注册（同一条助手回复不执行两次）
//   - phase=REPORTED 的任务再次出现 → 跳过（报告已回传，不重复发送）
import fs from "node:fs";
import path from "node:path";

export const PHASES = {
  NEW: "NEW",
  // C9-R20: 本地服务执行中的瞬态。进程崩溃/重启时残留的 RUNNING 一律视为结果未知，
  // 必须转 REPORT_UNKNOWN 且不得自动重试（禁止重复执行结果不确定的任务）。
  RUNNING: "RUNNING",
  EXECUTED: "EXECUTED",
  REPORTED: "REPORTED",
  DONE: "DONE",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
  STOPPED: "STOPPED",
  NEEDS_INPUT: "NEEDS_INPUT",
  REPORT_UNKNOWN: "REPORT_UNKNOWN",
};

export function loadRegistry(file) {
  if (!fs.existsSync(file)) return { tasks: [] };
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(obj.tasks)) throw new Error("tasks 非数组");
    return obj;
  } catch (e) {
    // 损坏的登记簿: 保守停止，不静默重建（调用方据此转人工）
    return { ok: false, error: e.message };
  }
}

export function saveRegistry(file, reg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return true;
}

export function findTask(reg, { taskId, assistantMsgId } = {}) {
  return reg.tasks.find((t) =>
    (taskId && t.taskId === taskId) || (assistantMsgId && t.assistantMsgId === assistantMsgId));
}

// 注册新任务。返回 {ok:true, task} 或 {ok:false, code:"DUPLICATE_TASK"|"EXISTS_MSG", task:已存在的任务}
export function registerTask(reg, { taskId, assistantMsgId, userSource, type, actions, summary, project = null }) {
  const dupId = reg.tasks.find((t) => t.taskId === taskId);
  if (dupId) return { ok: false, code: "DUPLICATE_TASK", task: dupId };
  const dupMsg = reg.tasks.find((t) => t.assistantMsgId === assistantMsgId);
  if (dupMsg) return { ok: false, code: "EXISTS_MSG", task: dupMsg };
  const task = {
    taskId,
    project: project || null,
    assistantMsgId,
    userSource: userSource
      ? { text: String(typeof userSource === "object" && userSource.text !== undefined ? userSource.text : userSource).slice(0, 500), hash: typeof userSource === "object" ? (userSource.hash ?? null) : null }
      : null,
    type,
    actions,
    summary: String(summary || "").slice(0, 300),
    phase: PHASES.NEW,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), phase: PHASES.NEW }],
  };
  reg.tasks.push(task);
  return { ok: true, task };
}

export function updatePhase(reg, taskId, phase, patch = {}) {
  const t = reg.tasks.find((x) => x.taskId === taskId);
  if (!t) return { ok: false, code: "NOT_FOUND" };
  t.phase = phase;
  t.updatedAt = new Date().toISOString();
  if (patch.results !== undefined) t.results = patch.results;
  if (patch.stopReason !== undefined) t.stopReason = String(patch.stopReason).slice(0, 300);
  if (patch.reportToken !== undefined) t.reportToken = patch.reportToken;
  // C9-R20: 本地服务把报告快照文件路径记录在任务上（报告可检索；不复制第二套状态系统）
  if (patch.reportFile !== undefined) t.reportFile = patch.reportFile;
  t.history.push({ at: t.updatedAt, phase });
  return { ok: true, task: t };
}
