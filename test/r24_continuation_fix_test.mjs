// C9-R24 恢复执行：回传异常根因修复的回归与诊断测试
// 覆盖:
//   - R24 报告续接指令不再自我驱动（RC-1）
//   - 纯文本决策识别（RC-2）：ChatGPT 以纯文本 STOP/NEEDS_USER_INPUT/TASK_COMPLETE 作出的决策被识别
//   - 自续接防护（RC-3）：ChatGPT 在"本系统报告之后"衍生的任务块只登记并暂停，不自动执行
//   - 协议/对话分离（RC-4）：合法用户任务仍正常执行；退化"AGENT_TASK_BEGIN"（不完整块）安全不执行
//
// 复现依据（真实盘面证据，非模拟）:
//   test/tasks/registry.json 中 t-c9-r24-loop-a 的 reportReply = "C3T-rep-mvgyn2pa-04f6 NEEDS_USER_INPUT"
//   （纯文本决策，旧代码忽略→循环未暂停）；t-c9-r24-loop-b 的 reportReply = "C3T-rep-mvgyncw7-2a83 AGENT_TASK_BEGIN"
//   （退化块，旧代码若其补全则会被自动执行，形成报告→任务→报告的自驱动循环）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import {
  processConversation, buildReportText, classifyReplyDecision,
} from "./collab_once.mjs";
import { PHASES, loadRegistry } from "./task_store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r24-fix-"));
const regFile = (n) => path.join(TMP, `reg-${n}.json`);

const block = (o) => `AGENT_TASK_BEGIN\n${JSON.stringify(o)}\nAGENT_TASK_END`;
const msg = (role, id, text) => ({ role, id, text });
const makeExecutorOk = () => ({
  executeActions: (actions) => ({
    ok: true,
    results: (actions || []).map((a) => ({ action: a, ok: true, exitCode: 0, reason: null })),
  }),
});
const makeSendReport = () => {
  const calls = [];
  const fn = async (rep) => { calls.push(rep); return { ok: true, token: `MOCK-${rep.taskId}`, reply: null, detail: "mock" }; };
  fn.calls = calls;
  return fn;
};

let pass = 0, fail = 0;
async function record(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// ---------- RC-1: 报告续接指令不再自我驱动 ----------
await record("RC1 报告不再邀请 ChatGPT 自行输出新任务块", async () => {
  const text = buildReportText({ taskId: "tk-1", ex: { ok: true, results: [] }, summary: "s", token: "C3T-x" });
  assert.ok(!text.includes("直接输出新的 AGENT_TASK_BEGIN"), "旧的危险指令应已移除");
  assert.ok(text.includes("不会"), "应声明系统不会自动发起新任务执行");
  assert.ok(text.includes("用户的明确指示"), "下一步任务须由用户明确指示驱动");
  assert.ok(text.includes("AGENT_REPORT_BEGIN") && text.includes("AGENT_REPORT_END"), "协议边界保持不变");
});

// ---------- RC-2: 纯文本决策识别 ----------
await record("RC2a classifyReplyDecision 识别纯文本 NEEDS_USER_INPUT", async () => {
  assert.equal(classifyReplyDecision("C3T-rep-x NEEDS_USER_INPUT").decision, "NEEDS_USER_INPUT");
  assert.equal(classifyReplyDecision("决策：NEEDS_USER_INPUT，等待用户").decision, "NEEDS_USER_INPUT");
});
await record("RC2b 识别 STOP / TASK_COMPLETE / CONTINUE", async () => {
  assert.equal(classifyReplyDecision("STOP").decision, "STOP");
  assert.equal(classifyReplyDecision("目标已达成 TASK_COMPLETE").decision, "TASK_COMPLETE");
  assert.equal(classifyReplyDecision("CONTINUE").decision, "CONTINUE");
});
await record("RC2c 普通文本与小写不误触发", async () => {
  assert.equal(classifyReplyDecision("这只是分析，没有任务块").decision, null);
  assert.equal(classifyReplyDecision("please stop the server").decision, null, "小写 stop 不应误触发");
  assert.equal(classifyReplyDecision("XNEEDS_USER_INPUTY").decision, null, "词内子串不应误触发");
});

// ---------- RC-2 (集成): 纯文本决策使循环暂停 ----------
await record("RC2d 纯文本 NEEDS_USER_INPUT 使 processConversation 暂停", async () => {
  const f = regFile("rc2d");
  const send = makeSendReport();
  const r = await processConversation({
    messages: [msg("assistant", "a-1", "C3T-rep-x NEEDS_USER_INPUT")],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(r.needsInput, true, "纯文本 NEEDS_USER_INPUT 应暂停");
  assert.equal(r.executed.length, 0);
});

// ---------- RC-3: 自续接防护 ----------
await record("RC3 报告之后的任务块只登记并暂停，不自动执行", async () => {
  const f = regFile("rc3");
  const send = makeSendReport();
  // 我们的报告（user 消息，含 AGENT_REPORT_BEGIN）+ ChatGPT 在其后衍生的新任务块
  const reportText = buildReportText({ taskId: "tk-prev", ex: { ok: true, results: [] }, summary: "s", token: "C3T-rep-prev" });
  const next = block({ type: "ASSISTANT_TASK", taskId: "tk-self", summary: "自行衍生", actions: [{ op: "node_check", target: "test/protocol.mjs" }] });
  const r = await processConversation({
    messages: [msg("user", null, reportText), msg("assistant", "a-reply", `收到。\n${next}`)],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(r.executed.length, 0, "自续接任务不得自动执行");
  assert.equal(send.calls.length, 0, "自续接任务不得自动回传");
  assert.equal(r.needsInput, true, "应暂停待用户确认");
  const reg = loadRegistry(f);
  const t = reg.tasks.find((x) => x.taskId === "tk-self");
  assert.ok(t, "自续接任务应被登记");
  assert.equal(t.phase, PHASES.NEW, "登记为 NEW 待用户确认");
});

// ---------- RC-4: 合法用户任务仍正常执行；退化块安全不执行 ----------
await record("RC4a 合法用户任务仍正常识别→执行→报告", async () => {
  const f = regFile("rc4a");
  const send = makeSendReport();
  const r = await processConversation({
    messages: [msg("user", null, "请检查语法"), msg("assistant", "a-ok", block({ type: "ASSISTANT_TASK", taskId: "tk-user", actions: [{ op: "node_check", target: "test/cdp_ws_client.mjs" }] }))],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(r.executed.length, 1);
  assert.equal(r.executed[0].taskId, "tk-user");
  assert.equal(send.calls.length, 1);
});

await record("RC4b 退化块（仅 AGENT_TASK_BEGIN，无 END）安全不执行", async () => {
  const f = regFile("rc4b");
  const send = makeSendReport();
  const r = await processConversation({
    messages: [msg("assistant", "a-bad", "C3T-rep-x AGENT_TASK_BEGIN")],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(r.executed.length, 0, "不完整块不得执行");
  assert.equal(r.protocolErrors.length >= 1, true, "应记为协议错误");
  assert.equal(send.calls.length, 0);
});

// ---------- 边界: 非报告上下文里的任务块仍执行（不与自续接门控冲突） ----------
await record("RC3b 非报告上下文的后续任务块仍执行（D8 兼容）", async () => {
  const f = regFile("rc3b");
  const send = makeSendReport();
  // 第一轮执行 tk-1；第二轮对话里 tk-2 出现在另一条助手消息、且前面无报告 user 消息
  await processConversation({ messages: [msg("assistant", "a-1", block({ type: "ASSISTANT_TASK", taskId: "tk-1", actions: [{ op: "node_check", target: "test/cdp_ws_client.mjs" }] }))], registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {} });
  const next = block({ type: "ASSISTANT_TASK", taskId: "tk-2", actions: [{ op: "node_check", target: "test/protocol.mjs" }] });
  const r2 = await processConversation({ messages: [msg("assistant", "a-1", block({ type: "ASSISTANT_TASK", taskId: "tk-1", actions: [{ op: "node_check", target: "test/cdp_ws_client.mjs" }] })), msg("assistant", "a-2", `分析：上一步通过。\n${next}`)], registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {} });
  assert.equal(r2.executed.length, 1, "非报告上下文的新任务仍应执行");
  assert.equal(r2.executed[0].taskId, "tk-2");
});

console.log(`\nR24 修复测试: 通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
