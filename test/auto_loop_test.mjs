// C9 无人值守自动闭环 单测（依赖注入，不访问浏览器/不真实执行）
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runAutoLoop, parseDecision, sigOf } from "./auto_loop.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, "tmp_autoloop");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const results = [];
let passed = 0;
async function record(name, fn) {
  try { await fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}

const A = (target) => ({ op: "node_check", target });
const okExec = (taskId) => async () => ({ ok: true, taskId, status: "ACTIONS_DONE", exitCode: 0 });
const reply = (text) => async () => ({ ok: true, replyText: text, runId: "r", replyId: "m" });

await record("L1 连续两轮自动接管（CONTINUE→COMPLETE）", async () => {
  const stateFile = path.join(TMP, "l1.json");
  let n = 0;
  const execFn = async () => ({ ok: true, taskId: `t${++n}`, status: "ACTIONS_DONE", exitCode: 0 });
  const replies = ["decision: CONTINUE\nNEXT_ACTION: node_check test/b.mjs", "decision: COMPLETE"];
  let i = 0;
  const relayFn = async () => ({ ok: true, replyText: replies[i++], runId: `r${i}`, replyId: `m${i}` });
  const res = await runAutoLoop({ seedAction: A("test/a.mjs"), minRounds: 2, maxRounds: 4, stateFile, execFn, relayFn, intervalMs: 0 });
  assert.equal(res.ok, true);
  assert.equal(res.stopReason, "COMPLETE");
  assert.equal(res.rounds.length, 2);
  assert.deepEqual(res.executedSignatures, ["node_check:test/a.mjs", "node_check:test/b.mjs"]);
});

await record("L2 未达最小轮数即 COMPLETE → 不算完成", async () => {
  const stateFile = path.join(TMP, "l2.json");
  const execFn = okExec("t1");
  const relayFn = reply("decision: COMPLETE");
  const res = await runAutoLoop({ seedAction: A("test/a.mjs"), minRounds: 2, maxRounds: 4, stateFile, execFn, relayFn, intervalMs: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.stopReason, "COMPLETE_BEFORE_MIN_ROUNDS");
  assert.equal(res.rounds.length, 1);
});

await record("L3 重复动作 → DUPLICATE_ACTION 停止", async () => {
  const stateFile = path.join(TMP, "l3.json");
  const execFn = okExec("t1");
  const relayFn = reply("decision: CONTINUE\nNEXT_ACTION: node_check test/a.mjs");
  const res = await runAutoLoop({ seedAction: A("test/a.mjs"), minRounds: 2, maxRounds: 4, stateFile, execFn, relayFn, intervalMs: 0 });
  assert.equal(res.stopReason, "DUPLICATE_ACTION");
  assert.equal(res.rounds.length, 1);
});

await record("L4 CONTINUE 但无 NEXT_ACTION → NO_ACTION_IN_REPLY", async () => {
  const stateFile = path.join(TMP, "l4.json");
  const execFn = okExec("t1");
  const relayFn = reply("decision: CONTINUE 继续观察");
  const res = await runAutoLoop({ seedAction: A("test/a.mjs"), minRounds: 2, maxRounds: 4, stateFile, execFn, relayFn, intervalMs: 0 });
  assert.equal(res.stopReason, "NO_ACTION_IN_REPLY");
  assert.equal(res.rounds.length, 1);
});

await record("L5 ASK_USER → 暂停", async () => {
  const stateFile = path.join(TMP, "l5.json");
  const res = await runAutoLoop({ seedAction: A("test/a.mjs"), minRounds: 2, maxRounds: 4, stateFile, execFn: okExec("t1"), relayFn: reply("decision: ASK_USER"), intervalMs: 0 });
  assert.equal(res.stopReason, "ASK_USER");
});

await record("L6 上次 RUNNING（崩溃）→ PREV_CRASH_UNRESOLVED", async () => {
  const stateFile = path.join(TMP, "l6.json");
  fs.writeFileSync(stateFile, JSON.stringify({ status: "RUNNING", rounds: [], executedSignatures: [] }));
  const res = await runAutoLoop({ seedAction: A("test/a.mjs"), minRounds: 2, maxRounds: 4, stateFile, execFn: okExec("t1"), relayFn: reply("decision: COMPLETE"), intervalMs: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.stopReason, "PREV_CRASH_UNRESOLVED");
});

await record("L7 中转失败 → RELAY_FAILED", async () => {
  const stateFile = path.join(TMP, "l7.json");
  const res = await runAutoLoop({ seedAction: A("test/a.mjs"), minRounds: 2, maxRounds: 4, stateFile, execFn: okExec("t1"), relayFn: async () => ({ ok: false, reason: "x" }), intervalMs: 0 });
  assert.equal(res.stopReason, "RELAY_FAILED");
});

await record("L8 parseDecision 解析 decision / NEXT_ACTION / node --check / 中文冒号", () => {
  assert.equal(parseDecision("decision: COMPLETE").decision, "COMPLETE");
  assert.equal(parseDecision("decision：CONTINUE").decision, "CONTINUE");
  const p1 = parseDecision("decision: CONTINUE\nNEXT_ACTION: node_check test/x.mjs");
  assert.equal(p1.nextAction.target, "test/x.mjs");
  const p2 = parseDecision("可以继续：node --check test/y.mjs");
  assert.equal(p2.nextAction.target, "test/y.mjs");
  const p3 = parseDecision("NEXT_ACTION: node --check `test/z.mjs`。");
  assert.equal(p3.nextAction.target, "test/z.mjs");
  const p4 = parseDecision("随便聊聊");
  assert.equal(p4.decision, null);
  assert.equal(p4.nextAction, null);
});

await record("L9 sigOf 归一化反斜杠", () => {
  assert.equal(sigOf({ op: "node_check", target: "test\\a.mjs" }), "node_check:test/a.mjs");
});

console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);
if (passed === results.length) { fs.rmSync(TMP, { recursive: true, force: true }); console.log("临时目录已清理"); }
else process.exitCode = 1;
