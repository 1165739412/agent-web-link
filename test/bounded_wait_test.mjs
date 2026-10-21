// C9-R5 有界等待与多轮接续 Mock 测试（不访问 CDP、不发送真实消息）
// 覆盖验收标准: 有界等待、合法新任务接续、普通文字不执行、重复任务阻断、
//              空闲超时、报告预算耗尽、默认行为保持、等待期异常安全停止
// 用法: node bounded_wait_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { PHASES, loadRegistry } from "./task_store.mjs";
import { makeExecutor } from "./agent_executor.mjs";
import { findNewTaskBlocks } from "./collab_once.mjs";
import { runCollabLoop, computeWatchdogMs } from "./collab_loop.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(SELF_DIR, "tmp_r5");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const results = [];
let passed = 0;
async function record(name, fn) {
  console.log(`RUN ${name}`);
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("TEST_TIMEOUT 15000ms")), 15000); }),
    ]);
    results.push(`PASS ${name}`); passed++;
  } catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
  finally { clearTimeout(timer); }
}

const hash = (t) => [...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const msg = (role, id, text) => ({ role, id, len: text.length, hash: hash(text), text });
const block = (obj) => `AGENT_TASK_BEGIN\n${JSON.stringify(obj, null, 1)}\nAGENT_TASK_END`;
const REAL_ROOT = path.join(SELF_DIR, "..");
const CHECK_TARGET = "test/cdp_ws_client.mjs";
const taskBlock = (taskId) => block({ type: "ASSISTANT_TASK", taskId, summary: "语法检查", actions: [{ op: "node_check", target: CHECK_TARGET }] });
const sleepFn = async () => {};

// 构造 roundFn: 按轮次返回预置结果，记录调用
function makeRoundFn(script) {
  const calls = [];
  const fn = async (roundNo, opts) => {
    calls.push({ round: roundNo, registerOnly: opts.registerOnly });
    const s = script[roundNo] || { exitCode: 0, executed: [], registeredOnly: [], reportResults: [] };
    return s;
  };
  fn.calls = calls;
  return fn;
}
const reportRound = (taskId) => ({ exitCode: 0, executed: [{ taskId, ok: true }], registeredOnly: [], reportResults: [{ taskId, ok: true, token: "tok-" + taskId }] });

// W1: 报告后有界等待 → 等待到新任务 → 下一轮正常执行（预算内）
await record("W1 有界等待发现新任务 → 下一轮自动接续执行", async () => {
  let waitCalls = 0;
  const waitFn = async () => { waitCalls++; return { found: true, taskIds: ["tk-2"] }; };
  const roundFn = makeRoundFn({
    1: reportRound("tk-1"),
    2: reportRound("tk-2"),
    3: reportRound("tk-3"),
  });
  const r = await runCollabLoop({ roundFn, maxRounds: 3, maxReports: 5, idleTimeoutMs: 1000, waitFn, sleepFn, log: () => {} });
  // 第 2、3 轮开始前各等待一次（第 1 轮前无需等待）
  assert.equal(waitCalls, 2, "每个接续轮开始前必须等待");
  assert.equal(roundFn.calls.length, 3);
  assert.equal(roundFn.calls[1].registerOnly, false, "预算内应正常执行");
  assert.equal(r.reportsSent, 3);
  assert.ok(r.stopReason.includes("轮次上限"), JSON.stringify(r));
});

// W2: 等待超时（无新任务块）→ 安全停止，不再调用 roundFn
await record("W2 空闲超时 → 安全停止且不进入下一轮", async () => {
  let waitCalls = 0;
  const waitFn = async () => { waitCalls++; return { found: false, reason: "空闲超时：1s 内未出现新的合法任务块" }; };
  const roundFn = makeRoundFn({ 1: reportRound("tk-1") });
  const r = await runCollabLoop({ roundFn, maxRounds: 4, maxReports: 3, idleTimeoutMs: 1000, waitFn, sleepFn, log: () => {} });
  assert.equal(waitCalls, 1);
  assert.equal(roundFn.calls.length, 1, "超时后不得再执行轮次");
  assert.ok(r.stopReason.includes("空闲超时"));
  assert.equal(r.reportsSent, 1);
});

// W3: 预算耗尽 + 等待到新任务 → registerOnly 登记后停止（不突破预算）
await record("W3 预算耗尽后等待到新任务 → 只登记不执行", async () => {
  const waitFn = async () => ({ found: true, taskIds: ["tk-next"] });
  const roundFn = makeRoundFn({
    1: reportRound("tk-1"),
    2: { exitCode: 0, executed: [], registeredOnly: [{ taskId: "tk-next" }], reportResults: [] },
  });
  const r = await runCollabLoop({ roundFn, maxRounds: 4, maxReports: 1, idleTimeoutMs: 1000, waitFn, sleepFn, log: () => {} });
  assert.equal(roundFn.calls.length, 2);
  assert.equal(roundFn.calls[1].registerOnly, true);
  assert.ok(r.stopReason.includes("报告预算已用尽"));
  assert.equal(r.reportsSent, 1, "不得突破报告预算");
});

// W4: 未注入 waitFn → 行为与 C9-R4 一致（无等待）
await record("W4 默认无等待 → 既有调度行为保持", async () => {
  const roundFn = makeRoundFn({
    1: reportRound("tk-1"),
    2: { exitCode: 0, executed: [], registeredOnly: [{ taskId: "tk-next" }], reportResults: [] },
  });
  const r = await runCollabLoop({ roundFn, maxRounds: 4, maxReports: 1, sleepFn, log: () => {} });
  assert.equal(roundFn.calls.length, 2);
  assert.equal(roundFn.calls[1].registerOnly, true);
  assert.ok(r.stopReason.includes("报告预算已用尽"));
});

// W5: 等待期间浏览器/CDP 异常 → 带原因安全停止
await record("W5 等待期间连接异常 → 安全停止", async () => {
  const waitFn = async () => ({ found: false, reason: "等待期间浏览器/CDP 异常: WebSocket closed" });
  const roundFn = makeRoundFn({ 1: reportRound("tk-1") });
  const r = await runCollabLoop({ roundFn, maxRounds: 4, maxReports: 3, idleTimeoutMs: 1000, waitFn, sleepFn, log: () => {} });
  assert.equal(roundFn.calls.length, 1);
  assert.ok(r.stopReason.includes("浏览器/CDP 异常"));
});

// W6: 停止条件在等待之后依然优先（REPORT_UNKNOWN 不等待）
await record("W6 REPORT_UNKNOWN 不进入等待", async () => {
  let waitCalls = 0;
  const waitFn = async () => { waitCalls++; return { found: true }; };
  const roundFn = makeRoundFn({ 1: { exitCode: 61, executed: [{ taskId: "tk-1", ok: true }], registeredOnly: [], reportResults: [{ taskId: "tk-1", ok: false, token: "t" }] } });
  const r = await runCollabLoop({ roundFn, maxRounds: 4, maxReports: 3, idleTimeoutMs: 1000, waitFn, sleepFn, log: () => {} });
  assert.equal(waitCalls, 0, "REPORT_UNKNOWN 必须立即停止，不得等待");
  assert.ok(r.stopReason.includes("REPORT_UNKNOWN"));
});

// W7: findNewTaskBlocks 单元行为
await record("W7 findNewTaskBlocks: 新块/重复/畸形/普通文字/区域/用户消息", async () => {
  const reg = { tasks: [
    { taskId: "tk-old", assistantMsgId: "a-old", phase: PHASES.REPORTED },
    { taskId: "tk-rep", assistantMsgId: "a-rep", phase: PHASES.REPORTED },
  ] };
  // 新合法块 → 发现
  let fresh = findNewTaskBlocks({ messages: [msg("assistant", "a-new", taskBlock("tk-new"))], reg });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].taskId, "tk-new");
  // 已登记 taskId → 不发现
  fresh = findNewTaskBlocks({ messages: [msg("assistant", "a-x", taskBlock("tk-old"))], reg });
  assert.equal(fresh.length, 0);
  // 已登记 assistantMsgId（同一条回复换个 taskId）→ 不发现
  fresh = findNewTaskBlocks({ messages: [msg("assistant", "a-old", taskBlock("tk-another"))], reg });
  assert.equal(fresh.length, 0);
  // 畸形块 → 不发现
  fresh = findNewTaskBlocks({ messages: [msg("assistant", "a-bad", "AGENT_TASK_BEGIN\n{broken\nAGENT_TASK_END")], reg });
  assert.equal(fresh.length, 0);
  // 普通文字 → 不发现
  fresh = findNewTaskBlocks({ messages: [msg("assistant", "a-chat", "这只是分析，没有任务块")], reg });
  assert.equal(fresh.length, 0);
  // 用户消息中的块 → 不发现（协议只认助手消息）
  fresh = findNewTaskBlocks({ messages: [msg("user", null, taskBlock("tk-user"))], reg });
  assert.equal(fresh.length, 0);
  // 最新回复区域中的新块 → 发现（伪消息 id 参与去重）
  fresh = findNewTaskBlocks({ messages: [msg("user", null, "q")], latestRegionText: `ChatGPT 说：\n${taskBlock("tk-region")}`, reg });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].taskId, "tk-region");
  assert.ok(fresh[0].assistantMsgId.startsWith("latest-region:"));
  // 重复区域文本（同哈希）→ 第二次仍发现（taskId 未登记），由登记簿去重兜底
  fresh = findNewTaskBlocks({ messages: [msg("user", null, "q")], latestRegionText: `ChatGPT 说：\n${taskBlock("tk-region")}`, reg });
  assert.equal(fresh.length, 1);
  // 区域中包含已登记 taskId → 不发现
  const reg2 = { tasks: [{ taskId: "tk-region", assistantMsgId: "latest-region:abc", phase: PHASES.REPORTED }] };
  fresh = findNewTaskBlocks({ messages: [], latestRegionText: taskBlock("tk-region"), reg: reg2 });
  assert.equal(fresh.length, 0);
});

// W8: 多轮接续的轮次上限（3 轮报告+等待）
await record("W8 多轮接续受轮次上限约束", async () => {
  const waitFn = async () => ({ found: true, taskIds: ["tk-x"] });
  const roundFn = makeRoundFn({ 1: reportRound("a"), 2: reportRound("b"), 3: reportRound("c") });
  const r = await runCollabLoop({ roundFn, maxRounds: 3, maxReports: 5, idleTimeoutMs: 1000, waitFn, sleepFn, log: () => {} });
  assert.equal(roundFn.calls.length, 3);
  assert.equal(r.reportsSent, 3);
  assert.ok(r.stopReason.includes("轮次上限"));
});

// W9: 看门狗预算覆盖有界等待（C9-R5 实机缺陷修复的回归）
await record("W9 看门狗预算: 覆盖轮询+等待，不小于既有下限", async () => {
  const { WATCHDOG_MS } = await import("./cdp_ws_client.mjs");
  const base = computeWatchdogMs({ maxRounds: 3, idleTimeoutMs: 150000 });
  assert.ok(base >= 3 * (180000 + 150000 + 60000), "必须覆盖 3 轮(轮询+等待+余量)");
  assert.ok(base >= WATCHDOG_MS, "不得低于既有 30s 下限");
  // 单轮短等待场景
  const small = computeWatchdogMs({ maxRounds: 1, idleTimeoutMs: 1000 });
  assert.ok(small >= WATCHDOG_MS);
  assert.ok(small < base, "预算随轮次/等待增长");
});

// W10: 看门狗预算覆盖实机建议参数（3 轮 × 150s 等待）
await record("W10 看门狗预算覆盖实机建议参数", async () => {
  const { WATCHDOG_MS } = await import("./cdp_ws_client.mjs");
  // R6-3 建议参数: max_rounds=3, max_reports=2, idle_timeout_ms=150000, wait_interval_ms=5000
  const ms = computeWatchdogMs({ maxRounds: 3, idleTimeoutMs: 150000 });
  const need = 3 * (180000 + 150000 + 60000); // 轮询截止 + 等待 + 余量
  assert.equal(ms, need, JSON.stringify({ ms, need }));
  assert.ok(ms > 150000 + 180000, "必须大于单轮(等待+轮询)");
  assert.ok(ms >= WATCHDOG_MS);
  // R5 缺陷回归: 旧实现为固定 WATCHDOG_MS(30s)，小于 idle_timeout → 长等待必被误杀
  assert.ok(WATCHDOG_MS < 150000, "旧固定看门狗确实小于等待窗口（R5 缺陷前提）");
});

// W11: CLI 参数解析（默认值与实机建议参数）
await record("W11 CLI 参数解析: 默认值与建议参数", async () => {
  const { parseArgs } = await import("./collab_loop.mjs");
  const d = parseArgs([]);
  assert.deepEqual(d, { maxRounds: 5, maxReports: 5, maxTotalMs: 1500000, intervalMs: 3000, idleTimeoutMs: 120000, waitIntervalMs: 5000, resumeNew: false });
  const s = parseArgs(["--max-rounds", "3", "--max-reports", "2", "--idle-timeout-ms", "150000", "--wait-interval-ms", "5000"]);
  assert.equal(s.maxRounds, 3);
  assert.equal(s.maxReports, 2);
  assert.equal(s.idleTimeoutMs, 150000);
  assert.equal(s.waitIntervalMs, 5000);
  assert.equal(s.resumeNew, false);
  // 非法值回退默认
  const bad = parseArgs(["--max-rounds", "abc", "--idle-timeout-ms", "10"]);
  assert.equal(bad.maxRounds, 1, "非数字回退为 1（安全下限）");
  assert.equal(bad.idleTimeoutMs, 1000, "低于下限回退 1000");
  const r = parseArgs(["--resume-new"]);
  assert.equal(r.resumeNew, true);
});

// W12: 总运行时间预算（C9-R7 R7-3）: 超限即停、不无限轮转、不截断进行中轮次
await record("W12 总运行时间预算: 超限安全停止", async () => {
  let rounds = 0;
  const slow = (ms) => new Promise((r) => setTimeout(r, ms));
  const roundFn = async () => {
    rounds++;
    await slow(50); // 模拟一轮执行耗时
    return { exitCode: 0, executed: [{ taskId: "t" + rounds, ok: true }], registeredOnly: [], reportResults: [{ taskId: "t" + rounds, ok: true, token: "x" }] };
  };
  const r = await runCollabLoop({ roundFn, maxRounds: 10, maxReports: 10, maxTotalMs: 170, idleTimeoutMs: 1000, waitFn: null, sleepFn: async () => {}, log: () => {} });
  assert.ok(r.stopReason.includes("总运行时间预算"), JSON.stringify(r));
  assert.ok(rounds >= 2 && rounds < 10, `必须有限轮转: rounds=${rounds}`);
  // 预算内不触发: maxTotalMs 足够大时由轮次上限结束
  let rounds2 = 0;
  const roundFn2 = async () => { rounds2++; return { exitCode: 0, executed: [{ taskId: "u" + rounds2, ok: true }], registeredOnly: [], reportResults: [{ taskId: "u" + rounds2, ok: true, token: "x" }] }; };
  const r2 = await runCollabLoop({ roundFn: roundFn2, maxRounds: 3, maxReports: 10, maxTotalMs: 600000, idleTimeoutMs: 1000, waitFn: null, sleepFn: async () => {}, log: () => {} });
  assert.ok(r2.stopReason.includes("轮次上限"), JSON.stringify(r2));
  assert.equal(rounds2, 3);
});

// W13: 预算充足时多轮全部正常执行（不得提前切 registerOnly）
await record("W13 预算充足: 多轮报告全部正常执行", async () => {
  const waitFn = async () => ({ found: true, taskIds: ["tk-x"] });
  const flags = [];
  const roundFn = async (n, { registerOnly }) => {
    flags.push(registerOnly);
    return { exitCode: 0, executed: [{ taskId: "t" + n, ok: true }], registeredOnly: [], reportResults: [{ taskId: "t" + n, ok: true, token: "x" }] };
  };
  const r = await runCollabLoop({ roundFn, maxRounds: 4, maxReports: 4, maxTotalMs: 600000, idleTimeoutMs: 1000, waitFn, sleepFn: async () => {}, log: () => {} });
  assert.equal(r.reportsSent, 4);
  assert.deepEqual(flags, [false, false, false, false], "预算=轮数时不得出现 registerOnly");
  assert.ok(r.stopReason.includes("轮次上限"));
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
