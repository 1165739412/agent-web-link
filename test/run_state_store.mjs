// 阶段 C6：运行状态持久化与校验模块（纯本地文件操作，零依赖，无任何发送能力）
// 设计要点:
//   - 单一 JSON 状态文件，canonical SHA256 完整性校验
//   - 原子写入: 临时文件 + fsync + rename（同卷）
//   - 任何解析/校验/完整性失败都拒绝自动重置（保守恢复路径）
//   - 状态转换白名单 + 条件证据强制；状态模块自身不执行任何发送
//   - 重启保护: sendAttempted=true 的状态在恢复时强制 requiresHumanReview
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const SCHEMA_VERSION = 1;

export const STATES = {
  NOT_STARTED: "NOT_STARTED",                             // 尚未尝试发送
  SEND_STARTED: "SEND_STARTED",                           // 已开始发送操作，提交结果不确定
  SEND_CONFIRMED: "SEND_CONFIRMED",                       // 已确认用户消息提交并渲染
  NEW_ASSISTANT_MESSAGE_FOUND: "NEW_ASSISTANT_MESSAGE_FOUND", // 已发现本轮关联新回复
  CONTENT_STABLE_HEURISTIC: "CONTENT_STABLE_HEURISTIC",   // 正文暂时稳定（启发式）
  GENERATION_COMPLETE_CONFIRMED: "GENERATION_COMPLETE_CONFIRMED", // 有直接验证证据的完成
  CHALLENGE_DETECTED: "CHALLENGE_DETECTED",               // 检测到挑战
  UNKNOWN: "UNKNOWN",                                     // 状态不明，需人工审核
  ABORTED: "ABORTED",                                     // 已中止
};

// 合法转换白名单（含证据条件的强制在 transition() 内单独校验）
const TRANSITIONS = {
  [STATES.NOT_STARTED]: [STATES.SEND_STARTED, STATES.ABORTED],
  [STATES.SEND_STARTED]: [STATES.SEND_CONFIRMED, STATES.UNKNOWN, STATES.CHALLENGE_DETECTED, STATES.ABORTED],
  [STATES.SEND_CONFIRMED]: [STATES.NEW_ASSISTANT_MESSAGE_FOUND, STATES.UNKNOWN, STATES.CHALLENGE_DETECTED, STATES.ABORTED],
  [STATES.NEW_ASSISTANT_MESSAGE_FOUND]: [STATES.CONTENT_STABLE_HEURISTIC, STATES.GENERATION_COMPLETE_CONFIRMED, STATES.UNKNOWN, STATES.CHALLENGE_DETECTED, STATES.ABORTED],
  [STATES.CONTENT_STABLE_HEURISTIC]: [STATES.UNKNOWN, STATES.CHALLENGE_DETECTED, STATES.ABORTED],
  [STATES.GENERATION_COMPLETE_CONFIRMED]: [],
  [STATES.CHALLENGE_DETECTED]: [STATES.UNKNOWN, STATES.ABORTED],
  [STATES.UNKNOWN]: [STATES.ABORTED], // 不允许自动回到 NOT_STARTED（防"结果不明"被当作"从未发送"）
  [STATES.ABORTED]: [],
};

// 已验证的完成证据白名单（CONTENT_STABLE 不得自动升级；GEN_COMPLETE 必须携带直接证据）
const COMPLETION_EVIDENCE_WHITELIST = ["STOP_BUTTON_TRANSITION"];

const FINAL_STATES = new Set([STATES.GENERATION_COMPLETE_CONFIRMED, STATES.ABORTED]);

export function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

function digestOf(stateObj) {
  const { integrity, ...payload } = stateObj;
  return createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");
}

// ---- 校验 ----

export function validateState(obj) {
  const errors = [];
  if (typeof obj !== "object" || obj === null) return { ok: false, errors: ["not an object"] };
  if (obj.schemaVersion !== SCHEMA_VERSION) errors.push(`SCHEMA_VERSION: 期望 ${SCHEMA_VERSION}，实际 ${JSON.stringify(obj.schemaVersion)}`);
  for (const f of ["runId", "createdAt", "updatedAt", "state", "reason"]) {
    if (typeof obj[f] !== "string" || !obj[f]) errors.push(`INVALID: 字段 ${f} 必须为非空字符串`);
  }
  if (!STATES[obj.state]) errors.push(`INVALID: 未知状态 ${JSON.stringify(obj.state)}`);
  for (const f of ["sendAttempted", "sendConfirmed", "requiresHumanReview"]) {
    if (typeof obj[f] !== "boolean") errors.push(`INVALID: 字段 ${f} 必须为布尔值`);
  }
  if (obj.requestOutcome !== "NOT_STARTED" && obj.requestOutcome !== "UNKNOWN" && obj.requestOutcome !== "REPLY_RECEIVED") {
    errors.push(`INVALID: requestOutcome 非法 ${JSON.stringify(obj.requestOutcome)}`);
  }
  if (!Array.isArray(obj.baselineMessageIds)) errors.push("INVALID: baselineMessageIds 必须为数组");
  if (obj.token !== null && typeof obj.token !== "string") errors.push("INVALID: token 必须为字符串或 null");
  if (obj.matchedAssistantMessageId !== null && typeof obj.matchedAssistantMessageId !== "string") {
    errors.push("INVALID: matchedAssistantMessageId 必须为字符串或 null");
  }
  if (obj.lastError !== null && typeof obj.lastError !== "string") errors.push("INVALID: lastError 必须为字符串或 null");
  if (!Array.isArray(obj.history)) errors.push("INVALID: history 必须为数组");
  // 派生一致性: 已进入发送后状态则 sendAttempted 必须为 true 且不可回退
  const sendStates = new Set([STATES.SEND_STARTED, STATES.SEND_CONFIRMED, STATES.NEW_ASSISTANT_MESSAGE_FOUND,
    STATES.CONTENT_STABLE_HEURISTIC, STATES.GENERATION_COMPLETE_CONFIRMED]);
  if (sendStates.has(obj.state) && obj.sendAttempted !== true) errors.push("INVALID: 该状态要求 sendAttempted=true");
  if (obj.sendAttempted === false && obj.sendConfirmed === true) errors.push("INVALID: sendConfirmed=true 而 sendAttempted=false");
  // 重启保护: 已尝试发送但结果不确定/被挑战 → 必须人工审核
  if (obj.sendAttempted === true && obj.requiresHumanReview !== true &&
      [STATES.SEND_STARTED, STATES.UNKNOWN, STATES.CHALLENGE_DETECTED].includes(obj.state)) {
    errors.push("INVALID: sendAttempted 后处于不确定状态必须 requiresHumanReview=true");
  }
  return { ok: errors.length === 0, errors };
}

function deriveFields(prev, toState, opts) {
  const sendStates = new Set([STATES.SEND_STARTED, STATES.SEND_CONFIRMED, STATES.NEW_ASSISTANT_MESSAGE_FOUND,
    STATES.CONTENT_STABLE_HEURISTIC, STATES.GENERATION_COMPLETE_CONFIRMED]);
  const state = {
    ...prev,
    state: toState,
    updatedAt: new Date().toISOString(),
  };
  // C9-R24-MCP 修复: 点击前确定性中止（typeAndEcho/clickSendOnce 明确失败、从未点击发送）
  // 记为 sendAttempted=false。否则遗留门禁把"确定未发送"误判为"未了结发送",每次失败制造永久阻塞。
  // 崩溃保护不受影响: 仅显式传入 preSendAbort 时降级; 未完成的 SEND_STARTED（崩溃）仍 sendAttempted=true。
  const preSendAbort = toState === STATES.ABORTED && opts && opts.preSendAbort === true;
  state.sendAttempted = preSendAbort ? false
    : (prev.sendAttempted || sendStates.has(toState) || (toState === STATES.ABORTED && prev.sendAttempted));
  state.sendConfirmed = [STATES.SEND_CONFIRMED, STATES.NEW_ASSISTANT_MESSAGE_FOUND,
    STATES.CONTENT_STABLE_HEURISTIC, STATES.GENERATION_COMPLETE_CONFIRMED].includes(toState);
  if (toState === STATES.NEW_ASSISTANT_MESSAGE_FOUND) state.matchedAssistantMessageId = opts.matchedAssistantMessageId;
  if (toState === STATES.GENERATION_COMPLETE_CONFIRMED) state.matchedAssistantMessageId = opts.matchedAssistantMessageId ?? prev.matchedAssistantMessageId;
  state.requestOutcome =
    (toState === STATES.NOT_STARTED) ? "NOT_STARTED" :
    ([STATES.NEW_ASSISTANT_MESSAGE_FOUND, STATES.CONTENT_STABLE_HEURISTIC, STATES.GENERATION_COMPLETE_CONFIRMED].includes(toState)) ? "REPLY_RECEIVED" :
    (state.sendAttempted ? "UNKNOWN" : "NOT_STARTED");
  state.requiresHumanReview =
    [STATES.UNKNOWN, STATES.CHALLENGE_DETECTED].includes(toState) ||
    (state.sendAttempted && toState === STATES.SEND_STARTED) ||
    (toState === STATES.ABORTED && state.sendAttempted);
  state.reason = opts.reason || state.reason;
  if (opts.lastError !== undefined) state.lastError = String(opts.lastError).slice(0, 300);
  state.history = [...(prev.history || []), {
    at: state.updatedAt, from: prev.state, to: toState,
    reason: (opts.reason || "").slice(0, 200),
  }].slice(-50);
  return state;
}

// ---- 原子写入 ----

function atomicWrite(file, stateObj) {
  const payload = { ...stateObj, integrity: { algo: "sha256-canonical", digest: digestOf(stateObj) } };
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file); // 同卷 rename 原子替换
}

// ---- 公开 API（纯文件操作，无发送能力） ----

// 新建状态文件；目标已存在 → 拒绝（绝不覆盖）
export function initStateFile(file, { runId, token = null, reason = "new run" } = {}) {
  if (fs.existsSync(file)) {
    return { ok: false, code: "ALREADY_EXISTS", detail: "状态文件已存在，拒绝覆盖；请归档后重试" };
  }
  const now = new Date().toISOString();
  const state = {
    schemaVersion: SCHEMA_VERSION,
    runId: runId || `r-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    createdAt: now,
    updatedAt: now,
    state: STATES.NOT_STARTED,
    sendAttempted: false,
    sendConfirmed: false,
    requestOutcome: "NOT_STARTED",
    token,
    baselineMessageIds: [],
    matchedAssistantMessageId: null,
    requiresHumanReview: false,
    reason,
    lastError: null,
    history: [{ at: now, from: null, to: STATES.NOT_STARTED, reason: reason.slice(0, 200) }],
  };
  const v = validateState(state);
  if (!v.ok) return { ok: false, code: "INVALID", detail: v.errors.join("; ") };
  try {
    atomicWrite(file, state);
  } catch (e) {
    return { ok: false, code: "WRITE_FAIL", detail: `状态文件写入失败: ${e.message}` };
  }
  return { ok: true, state };
}

// 读取并校验；任何失败都返回结构化错误，绝不静默重建
export function loadState(file) {
  if (!fs.existsSync(file)) return { ok: false, code: "NOT_FOUND", detail: "状态文件不存在（不等于从未发送，需人工确认历史）" };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, code: "READ_FAIL", detail: e.message };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, code: "PARSE_FAIL", detail: "JSON 语法损坏，拒绝自动重置（保留原文件待人工处理）" };
  }
  if (!obj || typeof obj.integrity !== "object" || obj.integrity.algo !== "sha256-canonical") {
    return { ok: false, code: "INTEGRITY_FAIL", detail: "缺少完整性校验块或算法不符，拒绝采信" };
  }
  const actual = digestOf(obj);
  if (actual !== obj.integrity.digest) {
    return { ok: false, code: "INTEGRITY_FAIL", detail: `完整性校验失败（期望 ${obj.integrity.digest.slice(0, 12)}...，实际 ${actual.slice(0, 12)}...），文件可能被截断或篡改，拒绝自动重置` };
  }
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, code: "SCHEMA_VERSION", detail: `schema 版本不兼容（文件 ${obj.schemaVersion}，程序 ${SCHEMA_VERSION}），停止` };
  }
  const v = validateState(obj);
  if (!v.ok) return { ok: false, code: "INVALID", detail: v.errors.join("; ") };
  return { ok: true, state: obj };
}

// 状态转换：白名单 + 证据条件 + 原子持久化；失败时文件保持原状
export function transition(file, toState, opts = {}) {
  const loaded = loadState(file);
  if (!loaded.ok) return loaded; // 任何读取失败都不推进状态机
  const cur = loaded.state;
  if (!STATES[toState]) return { ok: false, code: "INVALID", detail: `未知目标状态 ${JSON.stringify(toState)}` };
  if (cur.state === toState) return { ok: false, code: "NOOP", detail: "目标状态与当前状态相同" };
  const allowed = TRANSITIONS[cur.state] || [];
  if (!allowed.includes(toState)) {
    return { ok: false, code: "ILLEGAL_TRANSITION", detail: `非法转换 ${cur.state} → ${toState}；允许: [${allowed.join(", ")}]；状态矛盾时不自动推进` };
  }
  // 条件证据强制
  if (toState === STATES.CHALLENGE_DETECTED && !(typeof opts.evidence === "string" && opts.evidence.trim())) {
    return { ok: false, code: "EVIDENCE_REQUIRED", detail: "转入 CHALLENGE_DETECTED 必须携带非空 evidence（不得伪造挑战检测）" };
  }
  if (toState === STATES.GENERATION_COMPLETE_CONFIRMED) {
    if (!COMPLETION_EVIDENCE_WHITELIST.includes(opts.completionEvidence)) {
      return { ok: false, code: "EVIDENCE_REQUIRED",
        detail: `转入 GENERATION_COMPLETE_CONFIRMED 必须携带已验证完成证据，允许值: [${COMPLETION_EVIDENCE_WHITELIST.join(", ")}]；内容稳定(启发式)不构成完成证据` };
    }
    if (cur.state === STATES.CONTENT_STABLE_HEURISTIC) {
      return { ok: false, code: "ILLEGAL_TRANSITION", detail: "内容稳定(启发式)不得自动升级为生成完成" };
    }
  }
  if (toState === STATES.NEW_ASSISTANT_MESSAGE_FOUND || toState === STATES.GENERATION_COMPLETE_CONFIRMED) {
    if (!(typeof opts.matchedAssistantMessageId === "string" && opts.matchedAssistantMessageId)) {
      return { ok: false, code: "EVIDENCE_REQUIRED", detail: "必须提供 matchedAssistantMessageId（不能只凭消息数量增加判定）" };
    }
    if (opts.tokenMatched !== true) {
      return { ok: false, code: "EVIDENCE_REQUIRED", detail: "必须提供 tokenMatched=true（回复正文须包含本轮 token 才算关联成功）" };
    }
  }
  if (toState === STATES.UNKNOWN && !(typeof opts.reason === "string" && opts.reason.trim())) {
    return { ok: false, code: "EVIDENCE_REQUIRED", detail: "转入 UNKNOWN 必须说明原因" };
  }
  const next = deriveFields(cur, toState, opts);
  const v = validateState(next);
  if (!v.ok) return { ok: false, code: "INVALID", detail: "转换后状态校验失败: " + v.errors.join("; ") };
  try {
    atomicWrite(file, next);
  } catch (e) {
    return { ok: false, code: "WRITE_FAIL", detail: `状态持久化失败: ${e.message}（当前状态保持原状，不得视为已持久化）` };
  }
  return { ok: true, state: next };
}

// 重启保护：判断能否在既有状态文件之外安全开始新运行
export function assertSafeToStartNewRun(file) {
  const loaded = loadState(file);
  if (!loaded.ok) {
    if (loaded.code === "NOT_FOUND") return { ok: true, detail: "无既有状态文件（注意: 文件不存在不等于从未发送，跨轮次历史需人工确认）" };
    return { ok: false, code: loaded.code, detail: `既有状态文件不可读: ${loaded.detail}；不得开始新运行` };
  }
  const s = loaded.state;
  if (s.sendAttempted === false) return { ok: true, detail: "上一轮未尝试发送" };
  if (s.state === STATES.GENERATION_COMPLETE_CONFIRMED) return { ok: true, detail: "上一轮已确认生成完成" };
  return { ok: false, code: "HUMAN_REVIEW_REQUIRED",
    detail: `上一轮 sendAttempted=true 且状态=${s.state}（结果不确定/未完成），恢复后强制人工审核，不得自动开始新发送` };
}
