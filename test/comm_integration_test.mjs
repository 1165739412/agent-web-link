// 阶段 C7：集成 Mock 测试（不访问 CDP、不连浏览器、不发送真实消息）
// 用法: node comm_integration_test.mjs
// 真实发送函数从未被调用: 所有发送行为均为注入的 Mock ops，并在用例中断言调用计数。
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { STATES, loadState, transition, initStateFile } from "./run_state_store.mjs";
import { runCommTest, classifyReply, userEchoSeen, scanLegacyStateFiles } from "./comm_test_once.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(SELF_DIR, "tmp_c7");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const hash = (t) => [...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const msg = (role, id, text) => ({ role, id, len: text.length, hash: hash(text), text });
const TOKEN = "C3T-test-token-001";
const OLD_ASST = msg("assistant", "old-asst-id", "通信测试 OK");
const BEFORE = { msgs: [msg("user", null, "请只回复：通信测试 OK"), OLD_ASST], stopButton: 0, sendButton: 0 };
const snap = (...extra) => ({ msgs: [...BEFORE.msgs, ...extra], stopButton: 0, sendButton: 0 });

function makeOps({ seq = [], clickOk = true, typeOk = true } = {}) {
  const counters = { snapshots: 0, type: 0, click: 0 };
  let i = 0;
  return {
    counters,
    snapshot: async () => { counters.snapshots++; const s = seq[Math.min(i, seq.length - 1)]; i++; return s; },
    typeAndEcho: async () => { counters.type++; return typeOk ? { ok: true, echoed: true, len: 50 } : { ok: false, err: "mock type fail" }; },
    clickSendOnce: async () => { counters.click++; return clickOk ? { ok: true } : { ok: false, err: "mock click fail" }; },
  };
}
const noopLog = () => {};
const history = (file) => loadState(file).state.history.map((h) => h.to);

const results = [];
let passed = 0;
const TEST_TIMEOUT_MS = 20000;
async function record(name, fn) {
  console.log(`RUN ${name}`); // 挂起时可定位用例
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`TEST_TIMEOUT ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS); }),
    ]);
    results.push(`PASS ${name}`); passed++;
  } catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
  finally { clearTimeout(timer); }
}

await record("T1 正常初始化与合法状态推进", async () => {
  const sf = path.join(TMP, "t1.json");
  const echo = msg("user", null, `【自动测试 ${TOKEN}】请只回复：通信测试 OK ${TOKEN}`);
  const reply1 = msg("assistant", "new-id-1", `通信测试 OK ${TOKEN}`);
  const ops = makeOps({ seq: [snap(), snap(echo, reply1), snap(echo, reply1), snap(echo, reply1)] });
  const r = await runCommTest({
    authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base",
    pollIntervalMs: 0, pollDeadlineMs: 60000, log: noopLog,
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.verdict, "CONTENT_STABLE_HEURISTIC");
  assert.deepEqual(history(sf), ["NOT_STARTED", "SEND_STARTED", "SEND_CONFIRMED", "NEW_ASSISTANT_MESSAGE_FOUND", "CONTENT_STABLE_HEURISTIC"]);
  assert.equal(ops.counters.click, 1);
});

await record("T2 未授权时不调用发送操作", async () => {
  const sf = path.join(TMP, "t2.json");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: false, stateFile: sf, token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 0);
  assert.ok(r.plan);
  assert.equal(ops.counters.type, 0);
  assert.equal(ops.counters.click, 0);
  assert.equal(loadState(sf).state.state, STATES.NOT_STARTED);
});

// （C8-R4: 原 T3"目录不存在→初始化失败"场景已过时——集成层现在自动创建状态目录，
//   其阻断保护由 T32（目录创建失败→阻断）与 T15（状态写入失败→阻断）覆盖。
//   T3 改为验证: 深层目录自动创建 + plan 模式成功初始化 + 不产生悬挂指针）
await record("T3 状态目录自动创建，plan 初始化成功且无悬挂指针", async () => {
  const sf = path.join(TMP, "auto_dir", "nested", "t3.json");
  const latest = path.join(TMP, "auto_dir", "latest.json");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: false, stateFile: sf, token: TOKEN, ops, latestFile: latest, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 0);
  assert.equal(r.pointerWriteError, null, "成功初始化后指针应正常写入");
  assert.ok(loadState(sf).ok, "状态文件应已创建且可读");
  assert.equal(ops.counters.type, 0);
  assert.equal(ops.counters.click, 0);
});

await record("T4 发送开始后中断，重启后禁止自动重发", async () => {
  const prev = path.join(TMP, "t4_prev.json");
  initStateFile(prev, { token: TOKEN });
  transition(prev, STATES.SEND_STARTED, { reason: "上一轮中断" });
  const latest = path.join(TMP, "t4_latest.json");
  fs.writeFileSync(latest, JSON.stringify({ lastStateFile: prev }), "utf8");
  const sf = path.join(TMP, "t4_new.json");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, latestFile: latest, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 52);
  assert.equal(ops.counters.type, 0);
  assert.equal(ops.counters.click, 0, "上一轮结果不明时不得有任何发送");
  assert.ok(!fs.existsSync(sf), "新状态文件也不应被创建");
});

await record("T5 UNKNOWN 不自动恢复为 NOT_STARTED", async () => {
  const prev = path.join(TMP, "t5_prev.json");
  initStateFile(prev, { token: TOKEN });
  transition(prev, STATES.SEND_STARTED, { reason: "x" });
  transition(prev, STATES.UNKNOWN, { reason: "结果不明" });
  const r1 = transition(prev, STATES.NOT_STARTED, { reason: "自动回退尝试" });
  assert.equal(r1.code, "ILLEGAL_TRANSITION");
  const latest = path.join(TMP, "t5_latest.json");
  fs.writeFileSync(latest, JSON.stringify({ lastStateFile: prev }), "utf8");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(TMP, "t5_new.json"), token: TOKEN, ops, latestFile: latest, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 52);
  assert.equal(ops.counters.click, 0);
});

await record("T6 已确认提交但无新回复 → 超时 UNKNOWN，不自动重发", async () => {
  const sf = path.join(TMP, "t6.json");
  const echo = msg("user", null, `【自动测试 ${TOKEN}】请只回复：通信测试 OK ${TOKEN}`);
  const ops = makeOps({ seq: [snap(), snap(echo)] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 0, pollDeadlineMs: 30, fastFailPolls: 1000000, log: noopLog });
  assert.equal(r.exitCode, 34);
  assert.equal(r.verdict, "GENERATION_STATE_UNKNOWN");
  assert.equal(ops.counters.click, 1, "只有一次点击，无重试");
  const s = loadState(sf).state;
  assert.equal(s.state, STATES.UNKNOWN);
  assert.equal(s.sendAttempted, true);
  assert.equal(s.requiresHumanReview, true);
});

await record("T7 旧助手消息（含相同文本）不能匹配本轮", async () => {
  const sf = path.join(TMP, "t7.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const ops = makeOps({ seq: [snap(), snap(echo, msg("assistant", "old-asst-id", `通信测试 OK ${TOKEN}`))] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 0, pollDeadlineMs: 200, fastFailPolls: 1000000, log: noopLog });
  assert.equal(r.exitCode, 34);
  assert.ok(!history(sf).includes(STATES.NEW_ASSISTANT_MESSAGE_FOUND), "基线内 id 不得计入新回复");
});

await record("T8 只有新消息 ID、无 token → 不能认定关联", async () => {
  const sf = path.join(TMP, "t8.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const ops = makeOps({ seq: [snap(), snap(echo, msg("assistant", "new-id-8", "与 token 无关的回复"))] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 0, pollDeadlineMs: 200, fastFailPolls: 1000000, log: noopLog });
  assert.equal(r.exitCode, 34, JSON.stringify(r));
  assert.ok(!history(sf).includes(STATES.NEW_ASSISTANT_MESSAGE_FOUND));
  assert.equal(loadState(sf).state.state, STATES.UNKNOWN);
});

await record("T9 只有 token 命中、消息 ID 在基线内 → 不能认定关联", async () => {
  const sf = path.join(TMP, "t9.json");
  const cls = classifyReply(BEFORE, snap(msg("assistant", "old-asst-id", `包含 ${TOKEN} 的旧消息`)), TOKEN);
  assert.equal(cls.newCount, 0);
  assert.equal(cls.matched, null);
});

await record("T10 新消息 ID 与 token 双匹配才记录关联回复", async () => {
  const sf = path.join(TMP, "t10.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const reply = msg("assistant", "new-id-10", `通信测试 OK ${TOKEN}`);
  const ops = makeOps({ seq: [snap(), snap(echo, reply)] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 0, pollDeadlineMs: 30000, log: noopLog });
  assert.equal(r.exitCode, 0);
  const s = loadState(sf).state;
  assert.equal(s.state, STATES.CONTENT_STABLE_HEURISTIC);
  assert.equal(s.matchedAssistantMessageId, "new-id-10");
  assert.equal(s.requestOutcome, "REPLY_RECEIVED");
});

await record("T11 CONTENT_STABLE 不得升级为生成完成", async () => {
  const sf = path.join(TMP, "t11.json");
  initStateFile(sf, { token: TOKEN });
  transition(sf, STATES.SEND_STARTED, { reason: "x" });
  transition(sf, STATES.SEND_CONFIRMED, { reason: "x" });
  transition(sf, STATES.NEW_ASSISTANT_MESSAGE_FOUND, { matchedAssistantMessageId: "m", tokenMatched: true, reason: "x" });
  transition(sf, STATES.CONTENT_STABLE_HEURISTIC, { reason: "x" });
  const r = transition(sf, STATES.GENERATION_COMPLETE_CONFIRMED, { completionEvidence: "STOP_BUTTON_TRANSITION", matchedAssistantMessageId: "m" });
  assert.equal(r.code, "ILLEGAL_TRANSITION");
  assert.equal(loadState(sf).state.state, STATES.CONTENT_STABLE_HEURISTIC);
});

await record("T12 无真实完成证据时不产生 GENERATION_COMPLETE_CONFIRMED", async () => {
  const sf = path.join(TMP, "t12.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const reply = msg("assistant", "new-id-12", `ok ${TOKEN}`);
  const ops = makeOps({ seq: [snap(), snap(echo, reply)] }); // stopButton 恒为 0 → 无迁移证据
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 0, pollDeadlineMs: 30000, log: noopLog });
  assert.equal(r.verdict, "CONTENT_STABLE_HEURISTIC");
  assert.ok(!history(sf).includes(STATES.GENERATION_COMPLETE_CONFIRMED));
});

await record("T13 challenge 迹象无证据时用 UNKNOWN，不伪造 CHALLENGE_DETECTED", async () => {
  const sf = path.join(TMP, "t13.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const challenge = msg("assistant", "err-card-not-a-message", "cloudflare_challenge 重试"); // 非助手容器结构，模拟正文干扰
  const ops = makeOps({ seq: [snap(), snap(echo, challenge)] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 0, pollDeadlineMs: 200, fastFailPolls: 1000000, log: noopLog });
  assert.equal(r.exitCode, 34, JSON.stringify(r));
  assert.ok(!history(sf).includes(STATES.CHALLENGE_DETECTED), "无结构化证据不得伪造 CHALLENGE_DETECTED");
});

await record("T14 状态损坏时禁止继续发送", async () => {
  const sf = path.join(TMP, "t14.json");
  fs.writeFileSync(sf, "{broken json", "utf8");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 50);
  assert.equal(ops.counters.click, 0);
  assert.ok(fs.readFileSync(sf, "utf8").startsWith("{broken json"), "损坏文件不得被覆盖");
});

await record("T15 状态写入失败时不调用发送", async () => {
  const sf = path.join(TMP, "t15.json");
  initStateFile(sf, { token: TOKEN });
  const ops = makeOps({ seq: [snap()] });
  execSync(`attrib +R "${sf}"`);
  let r;
  try {
    r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 0, log: noopLog });
  } finally {
    execSync(`attrib -R "${sf}"`);
  }
  assert.equal(r.exitCode, 54);
  assert.ok(r.reason.includes("SEND_STARTED"), "失败点必须在发送调用之前");
  assert.equal(ops.counters.type, 0, "SEND_STARTED 持久化失败后不得输入");
  assert.equal(ops.counters.click, 0, "SEND_STARTED 持久化失败后不得点击");
});

await record("T16 合法终态不能被重置或非法推进", async () => {
  // ABORTED 复用拒绝
  const sf = path.join(TMP, "t16.json");
  initStateFile(sf, { token: TOKEN });
  transition(sf, STATES.SEND_STARTED, { reason: "x" });
  transition(sf, STATES.ABORTED, { reason: "中止" });
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 56);
  assert.equal(ops.counters.click, 0);
  // 终态无出边
  const rt = transition(sf, STATES.SEND_STARTED, { reason: "复活尝试" });
  assert.equal(rt.code, "ILLEGAL_TRANSITION");
  // GEN_COMPLETE 终态复用拒绝
  const sf2 = path.join(TMP, "t16b.json");
  initStateFile(sf2, { token: TOKEN });
  transition(sf2, STATES.SEND_STARTED, { reason: "x" });
  transition(sf2, STATES.SEND_CONFIRMED, { reason: "x" });
  transition(sf2, STATES.NEW_ASSISTANT_MESSAGE_FOUND, { matchedAssistantMessageId: "m", tokenMatched: true, reason: "x" });
  transition(sf2, STATES.GENERATION_COMPLETE_CONFIRMED, { completionEvidence: "STOP_BUTTON_TRANSITION", matchedAssistantMessageId: "m" });
  const r2 = await runCommTest({ authorized: true, stateFile: sf2, token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r2.exitCode, 56);
});

// ===== C8-R1 回归: latest 指针缺失时的遗留状态扫描 =====

await record("T17 指针缺失 + 遗留 SEND_STARTED → 阻断", async () => {
  const dir = path.join(TMP, "t17");
  fs.mkdirSync(dir, { recursive: true });
  initStateFile(path.join(dir, "comm_legacy.json"), { token: TOKEN });
  transition(path.join(dir, "comm_legacy.json"), STATES.SEND_STARTED, { reason: "遗留" });
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(dir, "comm_new.json"), token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 59);
  assert.equal(ops.counters.click, 0);
  assert.ok(!fs.existsSync(path.join(dir, "comm_new.json")), "不得创建本轮状态");
});

await record("T18 指针缺失 + 遗留 UNKNOWN → 阻断", async () => {
  const dir = path.join(TMP, "t18");
  fs.mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, "comm_legacy.json");
  initStateFile(lf, { token: TOKEN });
  transition(lf, STATES.SEND_STARTED, { reason: "x" });
  transition(lf, STATES.UNKNOWN, { reason: "结果不明" });
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(dir, "comm_new.json"), token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 59);
  assert.equal(ops.counters.click, 0);
});

await record("T19 指针缺失 + 损坏状态文件 → 阻断", async () => {
  const dir = path.join(TMP, "t19");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "comm_bad.json"), "{broken json", "utf8");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(dir, "comm_new.json"), token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 59);
  assert.equal(ops.counters.click, 0);
  assert.ok(fs.readFileSync(path.join(dir, "comm_bad.json"), "utf8").startsWith("{broken"), "损坏文件不得被改动");
});

await record("T19b 指针缺失 + 版本不兼容（合法签名）→ 阻断", async () => {
  const dir = path.join(TMP, "t19b");
  fs.mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, "comm_legacy.json");
  initStateFile(lf, { token: TOKEN });
  const obj = JSON.parse(fs.readFileSync(lf, "utf8"));
  const { integrity, ...payload } = obj;
  payload.schemaVersion = 2;
  const canon = (o) => typeof o !== "object" || o === null ? JSON.stringify(o)
    : Array.isArray(o) ? "[" + o.map(canon).join(",") + "]"
    : "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  const forged = { ...payload, schemaVersion: 2, integrity: { algo: "sha256-canonical", digest: createHash("sha256").update(canon(payload), "utf8").digest("hex") } };
  fs.writeFileSync(lf, JSON.stringify(forged, null, 2), "utf8");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(dir, "comm_new.json"), token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 59);
});

await record("T20 状态文件与 baseline 的 token 不一致 → 阻断", async () => {
  const dir = path.join(TMP, "t20");
  fs.mkdirSync(dir, { recursive: true });
  initStateFile(path.join(dir, "comm_r.json"), { token: "TOK-A" });
  fs.writeFileSync(path.join(dir, "comm_r.baseline.json"), JSON.stringify({ token: "TOK-B", savedAt: "x" }), "utf8");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(dir, "comm_new.json"), token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 59);
  assert.equal(ops.counters.click, 0);
});

await record("T21 孤立 baseline（无对应状态文件）→ 阻断待人工复核", async () => {
  const dir = path.join(TMP, "t21");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "comm_ghost.baseline.json"), JSON.stringify({ token: "TOK-GHOST", savedAt: "x" }), "utf8");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(dir, "comm_new.json"), token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 59);
  assert.equal(ops.counters.click, 0);
});

await record("T22 无任何遗留 → 允许 plan，并记录 firstStatefulRun 与历史未知声明", async () => {
  const dir = path.join(TMP, "t22");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const base = path.join(dir, "comm_new.baseline.json");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: false, stateFile: sf, token: TOKEN, ops, baselineFile: base, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 0);
  assert.equal(ops.counters.click, 0);
  const b = JSON.parse(fs.readFileSync(base, "utf8"));
  assert.equal(b.firstStatefulRun, true);
  assert.ok(b.historyNote.includes("历史发送情况未知"));
  assert.ok(b.historyNote.includes("不等于此前从未发送"), "必须显式声明不等于从未发送");
});

await record("T22b 遗留未发送状态（NOT_STARTED）→ 放行且不算首次", async () => {
  const dir = path.join(TMP, "t22b");
  fs.mkdirSync(dir, { recursive: true });
  initStateFile(path.join(dir, "comm_old.json"), { token: "TOK-OLD" }); // 未发送遗留
  const sf = path.join(dir, "comm_new.json");
  const base = path.join(dir, "comm_new.baseline.json");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: false, stateFile: sf, token: TOKEN, ops, baselineFile: base, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 0);
  const b = JSON.parse(fs.readFileSync(base, "utf8"));
  assert.equal(b.firstStatefulRun, false);
  assert.equal(ops.counters.click, 0);
});

await record("T24 遗留已确认完成（GEN_COMPLETE）→ 放行", async () => {
  const dir = path.join(TMP, "t24");
  fs.mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, "comm_done.json");
  initStateFile(lf, { token: TOKEN });
  transition(lf, STATES.SEND_STARTED, { reason: "x" });
  transition(lf, STATES.SEND_CONFIRMED, { reason: "x" });
  transition(lf, STATES.NEW_ASSISTANT_MESSAGE_FOUND, { matchedAssistantMessageId: "m", tokenMatched: true, reason: "x" });
  const done = transition(lf, STATES.GENERATION_COMPLETE_CONFIRMED, { completionEvidence: "STOP_BUTTON_TRANSITION", matchedAssistantMessageId: "m", tokenMatched: true });
  assert.ok(done.ok, JSON.stringify(done));
  const sf = path.join(dir, "comm_new.json");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: false, stateFile: sf, token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 0);
  assert.equal(ops.counters.click, 0);
});

// ===== C8-R2 回归: 指针存在时的遗留检查无条件化 + 指针严格校验 =====

// 辅助: 构造一条完整确认的状态文件
function makeConfirmedState(dir, name, token) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  initStateFile(f, { token });
  transition(f, STATES.SEND_STARTED, { reason: "x" });
  transition(f, STATES.SEND_CONFIRMED, { reason: "x" });
  transition(f, STATES.NEW_ASSISTANT_MESSAGE_FOUND, { matchedAssistantMessageId: "m", tokenMatched: true, reason: "x" });
  const done = transition(f, STATES.GENERATION_COMPLETE_CONFIRMED, { completionEvidence: "STOP_BUTTON_TRANSITION", matchedAssistantMessageId: "m", tokenMatched: true });
  assert.ok(done.ok, JSON.stringify(done));
  return f;
}

await record("T25 指针指向 GEN_COMPLETE + 同目录遗留 SEND_STARTED → 阻断", async () => {
  const dir = path.join(TMP, "t25");
  fs.mkdirSync(dir, { recursive: true });
  const prev = makeConfirmedState(dir, "comm_prev.json", TOKEN);
  const legacy = path.join(dir, "comm_legacy.json");
  initStateFile(legacy, { token: TOKEN });
  transition(legacy, STATES.SEND_STARTED, { reason: "遗留未了结" });
  const legacyRaw = fs.readFileSync(legacy, "utf8");
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ lastStateFile: prev }), "utf8");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(dir, "comm_new.json"), token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 59);
  assert.equal(ops.counters.type, 0);
  assert.equal(ops.counters.click, 0);
  assert.ok(!fs.existsSync(path.join(dir, "comm_new.json")), "不得创建本轮状态文件");
  assert.equal(fs.readFileSync(legacy, "utf8"), legacyRaw, "遗留文件内容必须保持不变");
});

await record("T26 指针指向 GEN_COMPLETE + 同目录遗留 UNKNOWN → 阻断", async () => {
  const dir = path.join(TMP, "t26");
  fs.mkdirSync(dir, { recursive: true });
  const prev = makeConfirmedState(dir, "comm_prev.json", TOKEN);
  const legacy = path.join(dir, "comm_legacy.json");
  initStateFile(legacy, { token: TOKEN });
  transition(legacy, STATES.SEND_STARTED, { reason: "x" });
  transition(legacy, STATES.UNKNOWN, { reason: "结果不明" });
  const legacyRaw = fs.readFileSync(legacy, "utf8");
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ lastStateFile: prev }), "utf8");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(dir, "comm_new.json"), token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 59);
  assert.equal(ops.counters.type, 0);
  assert.equal(ops.counters.click, 0);
  assert.equal(fs.readFileSync(legacy, "utf8"), legacyRaw);
});

await record("T27 指针缺少 lastStateFile 字段 → 阻断（不得静默跳过）", async () => {
  const dir = path.join(TMP, "t27");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ updatedAt: "x" }), "utf8");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(dir, "comm_new.json"), token: TOKEN, ops, latestFile: path.join(dir, "latest.json"), pollIntervalMs: 0, pollDeadlineMs: 30000, log: noopLog });
  assert.equal(r.exitCode, 61);
  assert.equal(ops.counters.type, 0);
  assert.equal(ops.counters.click, 0);
  assert.ok(!fs.existsSync(path.join(dir, "comm_new.json")));
});

await record("T28 lastStateFile 空/类型错误/指向不存在 → 均阻断", async () => {
  const dir = path.join(TMP, "t28");
  const cases = [
    { lastStateFile: "" },
    { lastStateFile: 123 },
    { lastStateFile: null },
  ];
  for (let i = 0; i < cases.length; i++) {
    fs.mkdirSync(dir, { recursive: true });
    const latest = path.join(dir, `latest_${i}.json`);
    fs.writeFileSync(latest, JSON.stringify(cases[i]), "utf8");
    const sf = path.join(dir, `comm_new_${i}.json`);
    const ops = makeOps({ seq: [snap()] });
    const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, latestFile: latest, pollIntervalMs: 0, log: noopLog });
    assert.equal(r.exitCode, 61, `case ${i}: ${JSON.stringify(r)}`);
    assert.equal(ops.counters.type, 0, `case ${i}`);
    assert.equal(ops.counters.click, 0, `case ${i}`);
    assert.ok(!fs.existsSync(sf), `case ${i}: 不得创建本轮状态文件`);
  }
});

await record("T29 指针指向 GEN_COMPLETE 且目录无其他遗留 → 正常放行", async () => {
  const dir = path.join(TMP, "t29");
  fs.mkdirSync(dir, { recursive: true });
  const prev = makeConfirmedState(dir, "comm_prev.json", TOKEN);
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ lastStateFile: prev }), "utf8");
  const sf = path.join(dir, "comm_new.json");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: false, stateFile: sf, token: TOKEN, ops, latestFile: path.join(dir, "latest.json"), pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 0);
  assert.equal(ops.counters.click, 0);
  assert.equal(loadState(sf).state.state, STATES.NOT_STARTED);
});

await record("T30 回归: 指针缺失 + 遗留 SEND_STARTED 仍阻断（C8-R1 行为保持）", async () => {
  const dir = path.join(TMP, "t30");
  fs.mkdirSync(dir, { recursive: true });
  const legacy = path.join(dir, "comm_legacy.json");
  initStateFile(legacy, { token: TOKEN });
  transition(legacy, STATES.SEND_STARTED, { reason: "遗留" });
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: path.join(dir, "comm_new.json"), token: TOKEN, ops, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 59);
  assert.equal(ops.counters.click, 0);
});

// ===== C8-R4 回归: 首次初始化目录创建 + 悬挂指针保护 =====

await record("T28b 指针悬挂（目标不存在）→ 放行并合法更新指针", async () => {
  const dir = path.join(TMP, "t28b");
  fs.mkdirSync(dir, { recursive: true });
  const latest = path.join(dir, "latest.json");
  fs.writeFileSync(latest, JSON.stringify({ lastStateFile: path.join(dir, "gone.json") }), "utf8");
  const sf = path.join(dir, "comm_new.json");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: false, stateFile: sf, token: TOKEN, ops, latestFile: latest, pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 0);
  assert.equal(ops.counters.click, 0);
  const ptr = JSON.parse(fs.readFileSync(latest, "utf8"));
  assert.equal(ptr.lastStateFile, sf, "指针在本轮成功初始化后被合法更新");
});

await record("T31 状态目录不存在时首次初始化成功（完整成功路径）", async () => {
  const sf = path.join(TMP, "t31", "deep", "nested", "comm_new.json"); // 父目录均不存在
  const echo = msg("user", null, `x ${TOKEN}`);
  const reply = msg("assistant", "new-id-31", `通信测试 OK ${TOKEN}`);
  const ops = makeOps({ seq: [snap(), snap(echo, reply)] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 0, pollDeadlineMs: 30000, log: noopLog });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  const s = loadState(sf);
  assert.ok(s.ok && s.state.state === STATES.CONTENT_STABLE_HEURISTIC);
  assert.equal(s.state.integrity.algo, "sha256-canonical");
  assert.equal(ops.counters.click, 1);
});

await record("T32 目录创建失败 → 阻断且不产生悬挂指针", async () => {
  const dir = path.join(TMP, "t32");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "blocked"), "I-am-a-file", "utf8"); // 用文件挡住目录路径
  const sf = path.join(dir, "blocked", "comm_new.json"); // 父级是文件 → mkdir 必败
  const latest = path.join(dir, "latest.json");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, latestFile: latest, pollIntervalMs: 0, log: noopLog });
  // 扫描先于初始化执行: 目录路径异常在扫描阶段即被保守阻断（exit 59）
  assert.equal(r.exitCode, 59);
  assert.ok(r.reason.includes("状态目录无法读取"), "异常环境必须保守阻断");
  assert.equal(ops.counters.type, 0);
  assert.equal(ops.counters.click, 0);
  assert.ok(!fs.existsSync(latest), "初始化失败不得创建/更新指针（悬挂指针保护）");
  assert.equal(r.pointerWriteError, "状态文件不存在，跳过指针更新（避免悬挂指针）");
});

await record("T33 指针写入失败被如实报告", async () => {
  const dir = path.join(TMP, "t33");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const latest = path.join(dir, "latest.json");
  // 悬挂指针（目标尚未存在）→ 可证明安全的陈旧指针，放行；
  // 计划模式成功初始化状态文件后，done() 尝试更新指针 → 只读属性导致写入失败 → 必须如实报告
  fs.writeFileSync(latest, JSON.stringify({ lastStateFile: sf }), "utf8");
  const ops = makeOps({ seq: [snap()] });
  execSync(`attrib +R "${latest}"`);
  let r;
  try {
    r = await runCommTest({ authorized: false, stateFile: sf, token: TOKEN, ops, latestFile: latest, pollIntervalMs: 0, log: noopLog });
  } finally {
    execSync(`attrib -R "${latest}"`);
  }
  assert.equal(r.exitCode, 0);
  assert.ok(r.pointerWriteError, "指针写失败必须被报告");
  assert.equal(ops.counters.click, 0);
  assert.ok(loadState(sf).ok, "本轮状态文件不受影响");
});

// ===== C8-R6 回归: 启发式快停 + runId 透传 =====

await record("T34 快停: 提交确认后持续无生成指示 → 提前转 UNKNOWN", async () => {
  const dir = path.join(TMP, "t34");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const ops = makeOps({ seq: [snap(), snap(echo)] }); // echo 后永远无回复、无 stop
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 10, pollDeadlineMs: 60000, stableNeed: 3, fastFailPolls: 3, log: noopLog });
  assert.equal(r.exitCode, 36, JSON.stringify(r));
  assert.equal(r.verdict, "GENERATION_STATE_UNKNOWN");
  assert.equal(ops.counters.click, 1, "仅一次点击");
  const s = loadState(sf).state;
  assert.equal(s.state, STATES.UNKNOWN);
  assert.equal(s.requiresHumanReview, true);
  assert.ok(s.reason.includes("疑似生成错误"), "快停原因须如实标注为疑似而非确认");
  assert.ok(!history(sf).includes(STATES.CHALLENGE_DETECTED), "不得伪造 CHALLENGE_DETECTED");
});

await record("T35 快停不误伤: 回复最终到达时正常完成", async () => {
  const dir = path.join(TMP, "t35");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const late = msg("assistant", "late-id", `通信测试 OK ${TOKEN}`);
  // 前 2 次轮询无回复（不超过阈值 3），第 3 次回复到达
  const ops = makeOps({ seq: [snap(), snap(echo), snap(echo), snap(echo, late), snap(echo, late), snap(echo, late), snap(echo, late)] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 10, pollDeadlineMs: 60000, stableNeed: 3, fastFailPolls: 3, log: noopLog });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.verdict, "CONTENT_STABLE_HEURISTIC");
  assert.equal(loadState(sf).state.matchedAssistantMessageId, "late-id");
});

await record("T36 runId 透传到状态文件（文件名与内部 runId 一致）", async () => {
  const dir = path.join(TMP, "t36");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_r-fixed-runid.json");
  const ops = makeOps({ seq: [snap()] });
  const r = await runCommTest({ authorized: false, stateFile: sf, token: TOKEN, ops, runId: "r-fixed-runid", pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 0);
  const s = loadState(sf).state;
  assert.equal(s.runId, "r-fixed-runid");
});

// ===== C8-R7 回归: 完成信号 / 断连 / 语义边界 / post-hoc 与归档 =====

await record("T38 stop 按钮出现→消失 + token 匹配 → GENERATION_COMPLETE_CONFIRMED", async () => {
  const dir = path.join(TMP, "t38");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const reply = msg("assistant", "gid-1", `通信测试 OK ${TOKEN}`);
  const withStop = { msgs: [...BEFORE.msgs, echo, reply], stopButton: 1, sendButton: 0 };
  const noStop = { msgs: [...BEFORE.msgs, echo, reply], stopButton: 0, sendButton: 1 };
  const ops = makeOps({ seq: [snap(), withStop, noStop, noStop, noStop] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 10, pollDeadlineMs: 60000, stableNeed: 3, log: noopLog });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.verdict, "GENERATION_COMPLETE_CONFIRMED", "有直接完成证据时才允许 CONFIRMED");
  assert.equal(loadState(sf).state.state, STATES.GENERATION_COMPLETE_CONFIRMED);
});

await record("T39 轮询中浏览器断开 → exit 35 + UNKNOWN，不重发", async () => {
  const dir = path.join(TMP, "t39");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  let calls = 0;
  const ops = {
    counters: { type: 0, click: 0 },
    snapshot: async () => { calls++; if (calls <= 2) return snap(); throw new Error("WebSocket closed"); },
    typeAndEcho: async () => { ops.counters.type++; return { ok: true, echoed: true, len: 50 }; },
    clickSendOnce: async () => { ops.counters.click++; return { ok: true }; },
  };
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 10, pollDeadlineMs: 60000, log: noopLog });
  assert.equal(r.exitCode, 35);
  assert.equal(ops.counters.click, 1, "断连后不得再次点击");
  assert.equal(loadState(sf).state.state, STATES.UNKNOWN);
});

await record("T40 用户消息回显不得被当作助手回复", async () => {
  const now = snap(msg("user", null, `包含 ${TOKEN} 的用户消息`));
  const cls = classifyReply(BEFORE, now, TOKEN);
  assert.equal(cls.newCount, 0, "user 角色不进入助手候选");
  assert.equal(cls.matched, null);
  assert.ok(!userEchoSeen(BEFORE, TOKEN), "发送前基线中不应有回显");
  assert.ok(userEchoSeen(now, TOKEN));
});

await record("T41 内容持续变化不得判定稳定（截止后 UNKNOWN）", async () => {
  const dir = path.join(TMP, "t41");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const seq = [snap(), snap(echo)];
  for (let i = 0; i < 8; i++) seq.push({ msgs: [...BEFORE.msgs, echo, msg("assistant", "chg-id", `变化中的回复 第${i}版 ${TOKEN}`)], stopButton: 0, sendButton: 0 });
  const ops = makeOps({ seq });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 0, pollDeadlineMs: 25, fastFailPolls: 1000000, log: noopLog });
  assert.equal(r.exitCode, 34);
  assert.equal(loadState(sf).state.state, STATES.UNKNOWN);
  assert.equal(loadState(sf).state.matchedAssistantMessageId, "chg-id");
});

await record("T43 归档目录存在时扫描放行且不再声明历史未知", async () => {
  const dir = path.join(TMP, "t43");
  fs.mkdirSync(path.join(dir, "archived"), { recursive: true });
  fs.writeFileSync(path.join(dir, "archived", "comm_old.json"), "{}", "utf8");
  const scan = await import("./comm_test_once.mjs");
  const res = scan.scanLegacyStateFiles(dir);
  assert.ok(res.ok);
  assert.equal(res.firstStatefulRun, false);
  assert.ok(res.note.includes("归档"), JSON.stringify(res));
});

await record("T44 SEND_CONFIRMED 记录输入框清空证据", async () => {
  const dir = path.join(TMP, "t44");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const reply = msg("assistant", "r-44", `通信测试 OK ${TOKEN}`);
  const ops = makeOps({ seq: [snap(), { msgs: [...BEFORE.msgs, echo, reply], stopButton: 0, sendButton: 1, inputLen: 0 }] });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 10, pollDeadlineMs: 60000, stableNeed: 3, fastFailPolls: 1000000, log: noopLog });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  const reason = loadState(sf).state.history.find(h => h.to === STATES.SEND_CONFIRMED)?.reason || "";
  assert.ok(reason.includes("输入框已清空"), `SEND_CONFIRMED 应含输入框清空证据: ${reason}`);
});

await record("T45 长延迟 token（8 轮）不被快停误伤", async () => {
  const dir = path.join(TMP, "t45");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const echo = msg("user", null, `x ${TOKEN}`);
  const seq = [snap(), snap(echo)];
  for (let i = 0; i < 6; i++) seq.push(snap(echo)); // 容器已出现但 token 迟迟未进正文
  seq.push(snap(echo, msg("assistant", "late-45", `通信测试 OK ${TOKEN}`)));
  seq.push(snap(echo, msg("assistant", "late-45", `通信测试 OK ${TOKEN}`)));
  seq.push(snap(echo, msg("assistant", "late-45", `通信测试 OK ${TOKEN}`)));
  const ops = makeOps({ seq });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 10, pollDeadlineMs: 60000, stableNeed: 3, fastFailPolls: 1000000, log: noopLog });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.verdict, "CONTENT_STABLE_HEURISTIC");
  assert.equal(loadState(sf).state.matchedAssistantMessageId, "late-45");
});

await record("T47 post-hoc 证据工具: 不修改原状态文件并生成可审计记录", async () => {
  const dir = path.join(TMP, "t47");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_r.json");
  initStateFile(sf, { token: TOKEN, runId: "r-posthoc" });
  transition(sf, STATES.SEND_STARTED, { reason: "x" });
  transition(sf, STATES.SEND_CONFIRMED, { reason: "x" });
  transition(sf, STATES.UNKNOWN, { reason: "R6 型提前中止" });
  const before = fs.readFileSync(sf, "utf8");
  const evFile = path.join(dir, "ev.json");
  fs.writeFileSync(evFile, JSON.stringify({ summary: "事后只读复核确认回复包含 token", replyId: "169c64f5", token: TOKEN, source: "diag_new_reply 只读诊断", observedAt: "2026-10-20T08:25:53Z" }), "utf8");
  const out = spawnSync(process.execPath, [path.join(SELF_DIR, "ops_posthoc_evidence.mjs"), sf, evFile], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(fs.readFileSync(sf, "utf8"), before, "原状态文件必须保持不变");
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "posthoc_comm_r.json"), "utf8"));
  assert.equal(rec.recordType, "post-hoc-evidence");
  assert.equal(rec.refStateRunId, "r-posthoc");
  assert.equal(rec.refState, STATES.UNKNOWN);
  assert.equal(rec.humanAuthorized, true);
});

await record("T48 --as-is 归档保留原始 UNKNOWN 且扫描放行", async () => {
  const dir = path.join(TMP, "t48");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_r.json");
  initStateFile(sf, { token: TOKEN, runId: "r-asis" });
  transition(sf, STATES.SEND_STARTED, { reason: "x" });
  transition(sf, STATES.UNKNOWN, { reason: "结果不明" });
  const before = fs.readFileSync(sf, "utf8");
  const ev = path.join(dir, "posthoc_comm_r.json");
  fs.writeFileSync(ev, JSON.stringify({ summary: "人工复核完成" }), "utf8");
  const out = spawnSync(process.execPath, [path.join(SELF_DIR, "ops_archive_prev_run.mjs"), sf, path.join(dir, "archived"), "R6 UNKNOWN 原样归档", "--as-is"], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const moved = path.join(dir, "archived", "comm_r.json");
  assert.equal(fs.readFileSync(moved, "utf8"), before, "归档必须原样保留（不做转换）");
  assert.ok(!fs.existsSync(sf), "原位置已移出（未删除内容）");
  const scan = (await import("./comm_test_once.mjs")).scanLegacyStateFiles(dir);
  assert.ok(scan.ok, JSON.stringify(scan));
  assert.equal(scan.firstStatefulRun, false);
});

// ===== C9 回归: 回显渲染滞后宽限 =====

await record("T50 回显滞后于回复容器 → 宽限期内确认并正常完成", async () => {
  const dir = path.join(TMP, "t50");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const reply = msg("assistant", "late-echo", `报告已收到 ${TOKEN}`);
  const echo = msg("user", null, `报告正文 ${TOKEN}`);
  // 回复容器先出现（含 token），用户回显气泡滞后 2 轮才渲染
  const seq = [
    snap(),                        // before
    snap(reply),                   // poll1: 匹配但无回显（宽限 1）
    snap(reply),                   // poll2: 宽限 2
    snap(echo, reply),             // poll3: 回显出现 → SEND_CONFIRMED + NEW + 稳定计数
    snap(echo, reply),
    snap(echo, reply),
    snap(echo, reply),
  ];
  const ops = makeOps({ seq });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 10, pollDeadlineMs: 60000, stableNeed: 3, fastFailPolls: 1000000, log: noopLog });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(loadState(sf).state.state, STATES.CONTENT_STABLE_HEURISTIC);
  assert.equal(loadState(sf).state.matchedAssistantMessageId, "late-echo");
});

await record("T51 回显宽限超限 → 保守 UNKNOWN", async () => {
  const dir = path.join(TMP, "t51");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_new.json");
  const reply = msg("assistant", "no-echo", `报告已收到 ${TOKEN}`);
  const seq = [snap(), snap(reply), snap(reply), snap(reply), snap(reply), snap(reply), snap(reply)];
  const ops = makeOps({ seq });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", pollIntervalMs: 10, pollDeadlineMs: 60000, stableNeed: 3, fastFailPolls: 1000000, log: noopLog });
  assert.equal(r.exitCode, 33, JSON.stringify(r));
  assert.equal(loadState(sf).state.state, STATES.UNKNOWN);
});

await record("T52 点击前中止(回显失败)=sendAttempted:false 且不阻断后续（R24-MCP 门禁修复）", async () => {
  const dir = path.join(TMP, "t52");
  fs.mkdirSync(dir, { recursive: true });
  const sf = path.join(dir, "comm_preabort.json");
  // 回显失败 → 从未点击发送
  const ops = makeOps({ seq: [snap()], typeOk: false });
  const r = await runCommTest({ authorized: true, stateFile: sf, token: TOKEN, ops, baselineFile: sf + ".base", latestFile: path.join(dir, "latest.json"), pollIntervalMs: 0, log: noopLog });
  assert.equal(r.exitCode, 31, JSON.stringify(r));
  assert.equal(ops.counters.click, 0, "回显失败不得点击");
  const s = loadState(sf).state;
  assert.equal(s.state, STATES.ABORTED);
  assert.equal(s.sendAttempted, false, "点击前中止不得标记为已尝试发送");
  // 遗留门禁不得把"确定未发送"判为未了结
  const scan = scanLegacyStateFiles(dir, noopLog);
  assert.equal(scan.ok, true, "点击前中止不得被遗留门禁阻断: " + (scan.reason || ""));
});

console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);
if (passed === results.length) {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("临时目录已清理: " + TMP);
} else {
  console.log("存在失败，临时目录保留: " + TMP);
  process.exitCode = 1;
}
