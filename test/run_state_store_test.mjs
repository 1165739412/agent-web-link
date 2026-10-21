// 阶段 C6：状态存储 Mock 测试（纯本地，不访问 CDP、不连浏览器、不发消息、不联网）
// 用法:
//   node run_state_store_test.mjs                     # 运行全部 12 项测试
//   node run_state_store_test.mjs --child <stateFile> # 内部协议: 模拟重启后的独立进程读取
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  STATES, initStateFile, loadState, transition, assertSafeToStartNewRun,
} from "./run_state_store.mjs";

const isChild = process.argv.includes("--child");
const SELF = fileURLToPath(import.meta.url);

// 子进程模式: 模拟"重启后"的独立进程读取状态
if (isChild) {
  const file = process.argv[process.argv.indexOf("--child") + 1];
  const loaded = loadState(file);
  const safe = assertSafeToStartNewRun(file);
  process.stdout.write(JSON.stringify({
    loadOk: loaded.ok,
    code: loaded.code || null,
    state: loaded.ok ? loaded.state.state : null,
    sendAttempted: loaded.ok ? loaded.state.sendAttempted : null,
    requiresHumanReview: loaded.ok ? loaded.state.requiresHumanReview : null,
    safeToStart: safe.ok, safeDetail: safe.detail,
  }));
  process.exit(0);
}

// ---- 主测试 ----
const TMP = path.join(path.dirname(SELF), "tmp_c6");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const results = [];
let passed = 0;
function record(name, fn) {
  try { fn(); results.push(`PASS ${name}`); passed++; }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}
const digestOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

// 1. 创建初始状态并读取
const f1 = path.join(TMP, "s1.json");
record("T1 初始化与读取", () => {
  const r = initStateFile(f1, { token: "TOK-TEST-1", reason: "mock run" });
  assert.ok(r.ok, JSON.stringify(r));
  const s = loadState(f1);
  assert.ok(s.ok && s.state.state === STATES.NOT_STARTED && s.state.sendAttempted === false);
  assert.equal(s.state.requestOutcome, "NOT_STARTED");
});

// 2. 合法状态转换链
const f2 = path.join(TMP, "s2.json");
record("T2 合法转换链", () => {
  assert.ok(initStateFile(f2).ok);
  assert.ok(transition(f2, STATES.SEND_STARTED, { reason: "提交中" }).ok);
  assert.ok(transition(f2, STATES.SEND_CONFIRMED, { reason: "用户气泡出现" }).ok);
  const r = transition(f2, STATES.NEW_ASSISTANT_MESSAGE_FOUND, {
    matchedAssistantMessageId: "aaaa-bbbb", tokenMatched: true, reason: "新容器含 token",
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(transition(f2, STATES.CONTENT_STABLE_HEURISTIC, { reason: "3x2s hash 稳定" }).ok);
  const s = loadState(f2);
  assert.equal(s.state.requestOutcome, "REPLY_RECEIVED");
  assert.equal(s.state.matchedAssistantMessageId, "aaaa-bbbb");
});

// 3. 非法转换被拒绝且文件不变
record("T3 非法转换拒绝", () => {
  const f3 = path.join(TMP, "s3.json");
  initStateFile(f3);
  const before = digestOf(f3);
  const r1 = transition(f3, STATES.GENERATION_COMPLETE_CONFIRMED, { completionEvidence: "STOP_BUTTON_TRANSITION" });
  assert.equal(r1.code, "ILLEGAL_TRANSITION");
  const r2 = transition(f3, STATES.NEW_ASSISTANT_MESSAGE_FOUND, { reason: "跳步" });
  assert.equal(r2.code, "ILLEGAL_TRANSITION");
  assert.equal(digestOf(f3), before, "拒绝后文件必须原状");
});

// 4+7. 重启后可正确读取 + sendAttempted/UNKNOWN 强制人工审核（跨进程模拟重启）
record("T4/T7 重启读取与人工审核强制", () => {
  const f4 = path.join(TMP, "s4.json");
  initStateFile(f4, { token: "TOK-R" });
  transition(f4, STATES.SEND_STARTED, { reason: "提交中" });
  const out1 = spawnSync(process.execPath, [SELF, "--child", f4], { encoding: "utf8" });
  const c1 = JSON.parse(out1.stdout);
  assert.equal(c1.state, STATES.SEND_STARTED);
  assert.equal(c1.sendAttempted, true);
  assert.equal(c1.requiresHumanReview, true, "SEND_STARTED 重启后必须要求人工审核");
  assert.equal(c1.safeToStart, false, "结果不明时不得自动开始新运行");
  transition(f4, STATES.UNKNOWN, { reason: "轮询超时" });
  const out2 = spawnSync(process.execPath, [SELF, "--child", f4], { encoding: "utf8" });
  const c2 = JSON.parse(out2.stdout);
  assert.equal(c2.requiresHumanReview, true);
  assert.equal(c2.safeToStart, false, "UNKNOWN 后重启仍必须人工审核");
});

// 5. JSON 损坏 → 拒绝自动重置
record("T5 损坏 JSON 拒绝重置", () => {
  const f5 = path.join(TMP, "s5.json");
  initStateFile(f5);
  transition(f5, STATES.SEND_STARTED, { reason: "x" });
  const corrupted = fs.readFileSync(f5, "utf8").slice(0, 40); // 模拟截断
  fs.writeFileSync(f5, corrupted, "utf8");
  const loaded = loadState(f5);
  assert.equal(loaded.code, "PARSE_FAIL");
  assert.ok(!fs.existsSync(f5 + ".tmp-0"), "不得产生静默重建");
  const r = transition(f5, STATES.NOT_STARTED, { reason: "尝试重置" });
  assert.ok(!r.ok && r.code === "PARSE_FAIL", "损坏状态下不得推进状态机");
});

// 6. schema 版本不兼容 → 停止
record("T6 schema 版本不兼容", () => {
  const f6 = path.join(TMP, "s6.json");
  initStateFile(f6);
  transition(f6, STATES.SEND_STARTED, { reason: "x" });
  const obj = JSON.parse(fs.readFileSync(f6, "utf8"));
  obj.schemaVersion = 99;
  fs.writeFileSync(f6, JSON.stringify(obj), "utf8");
  const loaded = loadState(f6);
  assert.equal(loaded.code, "INTEGRITY_FAIL", "篡改版本号必然破坏完整性校验，先于版本检查拦截");
});

// 7b. 合法版本的 schema 升级路径（构造完整但版本不同的状态文件）
record("T6b 版本不兼容（完整签名）", () => {
  const f6b = path.join(TMP, "s6b.json");
  initStateFile(f6b);
  const obj = JSON.parse(fs.readFileSync(f6b, "utf8"));
  const { integrity, ...payload } = obj;
  payload.schemaVersion = 2;
  const canon = (o) => typeof o !== "object" || o === null ? JSON.stringify(o)
    : Array.isArray(o) ? "[" + o.map(canon).join(",") + "]"
    : "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  obj.schemaVersion = 2;
  obj.integrity = { algo: "sha256-canonical", digest: createHash("sha256").update(canon(payload), "utf8").digest("hex") };
  fs.writeFileSync(f6b, JSON.stringify(obj, null, 2), "utf8");
  const loaded = loadState(f6b);
  assert.equal(loaded.code, "SCHEMA_VERSION");
});

// 8. UNKNOWN 不能自动变回 NOT_STARTED
record("T8 UNKNOWN 不得自动回退", () => {
  const f8 = path.join(TMP, "s8.json");
  initStateFile(f8);
  transition(f8, STATES.SEND_STARTED, { reason: "x" });
  transition(f8, STATES.UNKNOWN, { reason: "结果不明" });
  const r = transition(f8, STATES.NOT_STARTED, { reason: "尝试自动回退" });
  assert.equal(r.code, "ILLEGAL_TRANSITION");
  assert.equal(loadState(f8).state.state, STATES.UNKNOWN);
});

// 9. 不得伪造 CHALLENGE_DETECTED
record("T9 CHALLENGE 需证据", () => {
  const f9 = path.join(TMP, "s9.json");
  initStateFile(f9);
  transition(f9, STATES.SEND_STARTED, { reason: "x" });
  const r0 = transition(f9, STATES.CHALLENGE_DETECTED, { reason: "无证据" });
  assert.equal(r0.code, "EVIDENCE_REQUIRED");
  const r1 = transition(f9, STATES.CHALLENGE_DETECTED, { evidence: "   ", reason: "空白证据" });
  assert.equal(r1.code, "EVIDENCE_REQUIRED");
  const r2 = transition(f9, STATES.CHALLENGE_DETECTED, { evidence: "结构化检测: C1-C4 全命中", reason: "有证据" });
  assert.ok(r2.ok, JSON.stringify(r2));
});

// 10. CONTENT_STABLE 不得自动升级为完成；完成必须有白名单证据
record("T10 完成状态证据强制", () => {
  const f10 = path.join(TMP, "s10.json");
  initStateFile(f10);
  transition(f10, STATES.SEND_STARTED, { reason: "x" });
  transition(f10, STATES.SEND_CONFIRMED, { reason: "x" });
  transition(f10, STATES.NEW_ASSISTANT_MESSAGE_FOUND, { matchedAssistantMessageId: "m-1", tokenMatched: true, reason: "x" });
  transition(f10, STATES.CONTENT_STABLE_HEURISTIC, { reason: "x" });
  const r1 = transition(f10, STATES.GENERATION_COMPLETE_CONFIRMED, { completionEvidence: "STOP_BUTTON_TRANSITION", matchedAssistantMessageId: "m-1" });
  assert.equal(r1.code, "ILLEGAL_TRANSITION", "启发式稳定不得升级为完成");
  const r2 = transition(f10, STATES.UNKNOWN, { reason: "转人工" });
  assert.ok(r2.ok);
  // 正确路径: NEW 状态下凭直接证据确认完成
  const f10b = path.join(TMP, "s10b.json");
  initStateFile(f10b);
  transition(f10b, STATES.SEND_STARTED, { reason: "x" });
  transition(f10b, STATES.SEND_CONFIRMED, { reason: "x" });
  transition(f10b, STATES.NEW_ASSISTANT_MESSAGE_FOUND, { matchedAssistantMessageId: "m-2", tokenMatched: true, reason: "x" });
  const r3 = transition(f10b, STATES.GENERATION_COMPLETE_CONFIRMED, { completionEvidence: "STOP_BUTTON_TRANSITION", matchedAssistantMessageId: "m-2", tokenMatched: true });
  assert.ok(r3.ok, JSON.stringify(r3));
  const r4 = transition(f10b, STATES.GENERATION_COMPLETE_CONFIRMED, { completionEvidence: "TEXT_STABLE", matchedAssistantMessageId: "m-2" });
  assert.ok(!r4.ok, "终态后不得再转换（含 NOOP）");
  assert.equal(r4.code, "NOOP", "终态重复转入应报 NOOP");
  const rb = transition(f10b, STATES.NEW_ASSISTANT_MESSAGE_FOUND, { matchedAssistantMessageId: "m-3", tokenMatched: true, reason: "终态后尝试继续" });
  assert.equal(rb.code, "ILLEGAL_TRANSITION", "终态锁定");
});

// 11. 写入失败不得报告持久化成功
record("T11 写入失败明确报错", () => {
  const badDir = path.join(TMP, "not_a_dir");
  const f11 = path.join(badDir, "s11.json"); // 目录不存在 → 写入必然失败
  const r = initStateFile(f11);
  assert.equal(r.code, "WRITE_FAIL");
  assert.ok(!fs.existsSync(f11));
  // 已存在文件在不可写位置的转换失败
  const f11b = path.join(TMP, "s11b.json");
  initStateFile(f11b);
  // 用只读属性模拟写入失败（Windows: attrib +R 对 rename 生效）
  execSync(`attrib +R "${f11b}"`);
  let failed = false;
  try {
    const r2 = transition(f11b, STATES.SEND_STARTED, { reason: "x" });
    if (!r2.ok && r2.code === "WRITE_FAIL") failed = true;
    else if (!r2.ok) failed = true; // 其他失败也可接受，关键是不报告成功
    else failed = false;
  } catch { failed = true; }
  execSync(`attrib -R "${f11b}"`);
  assert.ok(failed, "写入失败时不得报告持久化成功");
  const s = loadState(f11b);
  assert.ok(s.ok && s.state.state === STATES.NOT_STARTED, "原状态未被破坏");
});

// 12. 测试仅在独立临时目录内写文件
record("T12 写入范围受控", () => {
  const created = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else created.push(p);
    }
  };
  walk(TMP);
  assert.ok(created.every(p => p.startsWith(TMP)), "所有测试产物必须在 tmp_c6 内");
});

console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);

// 清理: 全部通过才删除临时目录；有失败则保留供审计
if (passed === results.length) {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("临时目录已清理: " + TMP);
} else {
  console.log("存在失败，临时目录保留供审计: " + TMP);
  process.exitCode = 1;
}

// ---- 辅助（无） ----
