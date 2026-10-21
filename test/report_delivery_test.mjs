// C9-R2 报告自动回传 Mock 测试（不访问 CDP、不连浏览器、不发送真实消息）
// 覆盖任务书 §六: 报告生成/唯一 token/发送意图持久化/重复防护/成功与未知/延迟回显引用/
// 新回复匹配/普通分析不执行/STOP 与 NEEDS_USER_INPUT/浏览器断开引用/遗留阻断/恢复不重跑/
// 失败路径真实发送计数为 0
// 用法: node report_delivery_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { parseReportBlocks, REPORT_STATUS } from "./protocol.mjs";
import { PHASES, loadRegistry } from "./task_store.mjs";
import { makeExecutor } from "./agent_executor.mjs";
import { processConversation, buildReportText, makeReportSender, defaultPreSendWait } from "./collab_once.mjs";
import { checkRegistryGate, checkLegacyGate, runCollabLoop } from "./collab_loop.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(SELF_DIR, "tmp_r2");
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
const regFile = (n) => path.join(TMP, n, "registry.json");
const REAL_ROOT = path.join(SELF_DIR, "..");
const CHECK_TARGET = "test/cdp_ws_client.mjs";
const OK_TASK = block({ type: "ASSISTANT_TASK", taskId: "tk-1", summary: "语法检查", actions: [{ op: "node_check", target: CHECK_TARGET }] });

function makeExecutorOk() {
  return makeExecutor({ projectRoot: REAL_ROOT, log: () => {} });
}
// 发送计数器 Mock: 记录每次调用参数，可配置成败
function makeSendReport(behavior = {}) {
  const calls = [];
  const fn = async (arg) => {
    calls.push(arg);
    if (behavior.failFirst && calls.length === 1) return { ok: false, token: "tok-x", detail: "exit=33 模拟未知", reply: null };
    if (behavior.throwErr) throw new Error("模拟发送器崩溃");
    return { ok: true, token: `tok-${calls.length}`, detail: "exit=0", reply: { id: "r-1", text: "报告已收到" } };
  };
  fn.calls = calls;
  return fn;
}

// ===== D1-D3: 报告构造与发送意图持久化 =====

await record("D1 报告正文包含全部必需字段与标记", async () => {
  const token = "C3T-rep-test-0001";
  const ex = { ok: false, results: [{ action: { op: "node_check", target: "t.mjs" }, ok: false, blocked: false, exitCode: 1, reason: "语法错误" }] };
  const text = buildReportText({ taskId: "tk-1", ex, summary: "语法检查", token });
  assert.ok(text.includes("AGENT_REPORT_BEGIN") && text.includes("AGENT_REPORT_END"));
  const parsed = parseReportBlocks(text);
  assert.equal(parsed.length, 1);
  assert.ok(parsed[0].ok, JSON.stringify(parsed[0]));
  assert.equal(parsed[0].taskId, "tk-1");
  assert.equal(parsed[0].status, "FAILED");
  const body = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  assert.equal(body.reportToken, token);
  assert.equal(body.status, "FAILED");
  assert.equal(body.summary, "语法检查");
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].exitCode, 1);
  assert.ok(body.failures.includes("语法错误"));
  assert.ok(text.includes(token), "正文须含 token 供 ChatGPT 引用");
});

await record("D2 发送器: 唯一 token + 发送前 outbox 持久化 + 发送后更新结局", async () => {
  const outboxDir = path.join(TMP, "d2_outbox");
  let seenStatusAtCall = null;
  const runCommTestFn = async (args) => {
    // 调用发生时 outbox 必须已存在且为 SENDING（崩溃可恢复）
    const f = path.join(outboxDir, `${args.token}.json`);
    seenStatusAtCall = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).status : null;
    return { exitCode: 0, verdict: "CONTENT_STABLE_HEURISTIC", reply: { id: "r-9", text: "报告已收到" } };
  };
  const sender = makeReportSender({ connect: async () => ({}), stateDir: path.join(TMP, "d2_state"), outboxDir, latestFile: null, log: () => {}, runCommTestFn, preSendWaitFn: async () => ({ ok: true, waitedMs: 0 }), sleepFn: async () => {} });
  const r1 = await sender({ taskId: "tk-a", ex: { ok: true, results: [] }, summary: "s1" });
  const r2 = await sender({ taskId: "tk-b", ex: { ok: true, results: [] }, summary: "s2" });
  assert.equal(seenStatusAtCall, "SENDING", "runCommTest 调用时 outbox 必须已是 SENDING");
  assert.notEqual(r1.token, r2.token, "每份报告必须唯一 token");
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.reply, { id: "r-9", text: "报告已收到" });
  const rec1 = JSON.parse(fs.readFileSync(path.join(outboxDir, `${r1.token}.json`), "utf8"));
  assert.equal(rec1.status, "DELIVERED");
  assert.equal(rec1.taskId, "tk-a");
  assert.equal(rec1.exitCode, 0);
  assert.equal(rec1.reply.id, "r-9");
  assert.ok(rec1.reportText.includes("AGENT_REPORT_BEGIN"));
});

await record("D3 发送器: 结果未知 → outbox UNKNOWN，不抛异常", async () => {
  const outboxDir = path.join(TMP, "d3_outbox");
  const runCommTestFn = async () => ({ exitCode: 33, verdict: null, reason: "无 SEND_CONFIRMED 证据" });
  const sender = makeReportSender({ connect: async () => ({}), stateDir: path.join(TMP, "d3_state"), outboxDir, latestFile: null, log: () => {}, runCommTestFn, preSendWaitFn: async () => ({ ok: true, waitedMs: 0 }), sleepFn: async () => {} });
  const r = await sender({ taskId: "tk-c", ex: { ok: true, results: [] }, summary: "s" });
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes("exit=33"));
  const rec = JSON.parse(fs.readFileSync(path.join(outboxDir, `${r.token}.json`), "utf8"));
  assert.equal(rec.status, "UNKNOWN");
  assert.equal(rec.reason, "无 SEND_CONFIRMED 证据");
  // 发送器整体异常（如 CDP 断开）→ 同样 UNKNOWN 且不崩溃
  const sender2 = makeReportSender({ connect: async () => ({}), stateDir: path.join(TMP, "d3_state"), outboxDir, latestFile: null, log: () => {}, runCommTestFn: async () => { throw new Error("WebSocket closed"); }, preSendWaitFn: async () => ({ ok: true, waitedMs: 0 }), sleepFn: async () => {} });
  const r2 = await sender2({ taskId: "tk-d", ex: { ok: true, results: [] }, summary: "s" });
  assert.equal(r2.ok, false);
  assert.ok(r2.detail.includes("WebSocket closed"));
});

// ===== D4-D10: processConversation 报告流 =====

await record("D4 执行失败也回传（status=FAILED，不隐瞒）", async () => {
  const f = regFile("d4");
  const send = makeSendReport();
  const r = await processConversation({
    messages: [msg("assistant", "a-1", block({ type: "ASSISTANT_TASK", taskId: "tk-f", actions: [{ op: "node_check", target: "../escape.mjs" }] }))],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(r.executed.length, 1);
  assert.equal(r.executed[0].ok, false);
  assert.equal(send.calls.length, 1, "失败也必须回传一份报告");
  assert.equal(send.calls[0].ex.ok, false);
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.REPORTED);
});

await record("D5 重复任务块只发送一份报告", async () => {
  const f = regFile("d5");
  const send = makeSendReport();
  const dup = block({ type: "ASSISTANT_TASK", taskId: "tk-dup", actions: [{ op: "node_check", target: CHECK_TARGET }] });
  const r = await processConversation({
    messages: [msg("assistant", "a-1", dup), msg("assistant", "a-2", dup)],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(send.calls.length, 1);
  assert.ok(r.skipped.some((s) => s.reason.includes("防重复执行")));
});

await record("D6 报告未知 → REPORT_UNKNOWN，恢复后不重复执行原任务", async () => {
  const f = regFile("d6");
  const send = makeSendReport({ failFirst: true });
  const msgs = [msg("assistant", "a-1", OK_TASK)];
  const r1 = await processConversation({ messages: msgs, registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {} });
  assert.equal(r1.exitCode, 61);
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.REPORT_UNKNOWN);
  // 恢复后再扫同一对话: 跳过（不重跑任务、不发第二份报告）
  const send2 = makeSendReport();
  const r2 = await processConversation({ messages: msgs, registryFile: f, executor: makeExecutorOk(), sendReport: send2, log: () => {} });
  assert.equal(r2.executed.length, 0);
  assert.equal(send2.calls.length, 0, "不得重复执行或重复回传");
});

await record("D7 registerOnly: 只登记不执行不回传", async () => {
  const f = regFile("d7");
  const send = makeSendReport();
  const r = await processConversation({
    messages: [msg("assistant", "a-1", block({ type: "ASSISTANT_TASK", taskId: "tk-ro", actions: [{ op: "node_check", target: CHECK_TARGET }] }))],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, registerOnly: true, log: () => {},
  });
  assert.equal(r.executed.length, 0);
  assert.equal(send.calls.length, 0);
  assert.equal(r.registeredOnly.length, 1);
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.NEW);
});

await record("D8 报告回复中的新任务块 → 下一轮登记并执行", async () => {
  const f = regFile("d8");
  const send = makeSendReport();
  // 第一轮: 执行 tk-1 并回传
  await processConversation({ messages: [msg("assistant", "a-1", OK_TASK)], registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {} });
  assert.equal(send.calls.length, 1);
  // ChatGPT 的回复（第二轮读到）包含新任务块
  const next = block({ type: "ASSISTANT_TASK", taskId: "tk-2", summary: "第二步", actions: [{ op: "node_check", target: CHECK_TARGET }] });
  const r2 = await processConversation({
    messages: [msg("assistant", "a-1", OK_TASK), msg("assistant", "a-2", `分析：上一步通过。\n${next}`)],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(r2.executed.length, 1);
  assert.equal(r2.executed[0].taskId, "tk-2");
  assert.equal(send.calls.length, 2, "新任务执行后再回传一份");
  assert.equal(loadRegistry(f).tasks.find((t) => t.taskId === "tk-2").phase, PHASES.REPORTED);
  assert.equal(loadRegistry(f).tasks.find((t) => t.taskId === "tk-1").phase, PHASES.REPORTED, "旧任务状态保留");
});

await record("D9 普通分析文本（无标记）不执行不发送", async () => {
  const f = regFile("d9");
  const send = makeSendReport();
  const r = await processConversation({
    messages: [msg("assistant", "a-1", "这只是分析：建议后续检查 X 模块。没有任务块。")],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(r.executed.length, 0);
  assert.equal(send.calls.length, 0);
  assert.ok(!fs.existsSync(f), "无任务则不创建登记簿");
});

await record("D10 STOP 与 NEEDS_USER_INPUT 正确停驻", async () => {
  const f = regFile("d10");
  const send = makeSendReport();
  const r = await processConversation({
    messages: [msg("assistant", "a-1", block({ type: "STOP", taskId: "tk-stop" })), msg("assistant", "a-2", OK_TASK)],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(r.stopped, true);
  assert.equal(send.calls.length, 0);
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.STOPPED);
  const f2 = regFile("d10b");
  const r2 = await processConversation({
    messages: [msg("assistant", "a-1", block({ type: "NEEDS_USER_INPUT", taskId: "tk-nui", summary: "需要用户选择方案" })), msg("assistant", "a-2", OK_TASK)],
    registryFile: f2, executor: makeExecutorOk(), sendReport: makeSendReport(), log: () => {},
  });
  assert.equal(r2.needsInput, true);
  assert.equal(loadRegistry(f2).tasks[0].phase, PHASES.NEEDS_INPUT);
});

// ===== D11-D13: 门禁与循环调度 =====

await record("D11 启动门禁: 需人工复核的任务与未了结状态都拒绝", async () => {
  const mk = (phase) => ({ ok: true, tasks: [{ taskId: "t", phase, assistantMsgId: "a" }] });
  assert.ok(!checkRegistryGate(mk(PHASES.REPORT_UNKNOWN)).ok);
  assert.ok(!checkRegistryGate(mk(PHASES.NEEDS_INPUT)).ok);
  assert.ok(!checkRegistryGate(mk(PHASES.STOPPED)).ok);
  assert.ok(checkRegistryGate({ tasks: [] }).ok);
  assert.ok(!checkRegistryGate({ ok: false, error: "损坏" }).ok);
  // 遗留状态门禁: 未了结 UNKNOWN 状态文件 → 拒绝
  const dir = path.join(TMP, "d11_state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "comm_bad.json"), JSON.stringify({ schemaVersion: 1, runId: "r-bad", state: "UNKNOWN", sendAttempted: true, requiresHumanReview: true, token: "t", history: [], integrity: { algo: "x", digest: "y" } }), "utf8");
  assert.ok(!checkLegacyGate(dir).ok, "未了结状态必须阻断启动");
});

await record("D12 循环调度: 各停止条件与预算边界", async () => {
  const sleepFn = async () => {};
  const log = () => {};
  // (a) 报告未知 → 立即停止
  let r = await runCollabLoop({
    roundFn: async () => ({ exitCode: 61, executed: [], registeredOnly: [], reportResults: [] }),
    maxRounds: 5, maxReports: 5, sleepFn, log,
  });
  assert.ok(r.stopReason.includes("REPORT_UNKNOWN"));
  // (b) STOP
  r = await runCollabLoop({ roundFn: async () => ({ exitCode: 0, stopped: true, executed: [], registeredOnly: [], reportResults: [] }), maxRounds: 5, maxReports: 5, sleepFn, log });
  assert.ok(r.stopReason.includes("STOP"));
  // (c) 无进展 → 停止（防空转）
  r = await runCollabLoop({ roundFn: async () => ({ exitCode: 0, executed: [], registeredOnly: [], reportResults: [] }), maxRounds: 5, maxReports: 5, sleepFn, log });
  assert.ok(r.stopReason.includes("无进展"));
  // (d) 报告预算用尽 → 先做一轮 registerOnly 登记，再停止
  const seenRegisterOnly = [];
  r = await runCollabLoop({
    roundFn: async (n, { registerOnly }) => {
      seenRegisterOnly.push(registerOnly);
      if (registerOnly) return { exitCode: 0, executed: [], registeredOnly: [{ taskId: "tk-next" }], reportResults: [] };
      return { exitCode: 0, executed: [{ taskId: "tk-1", ok: true }], registeredOnly: [], reportResults: [{ taskId: "tk-1", ok: true, token: "t1" }] };
    },
    maxRounds: 6, maxReports: 1, sleepFn, log,
  });
  assert.equal(r.reportsSent, 1);
  assert.ok(seenRegisterOnly.includes(true), "预算用尽后必须有一轮 registerOnly");
  assert.ok(r.stopReason.includes("报告预算已用尽"));
  // (e) 轮次上限
  r = await runCollabLoop({ roundFn: async () => ({ exitCode: 0, executed: [{ taskId: "x", ok: true }], registeredOnly: [], reportResults: [{ taskId: "x", ok: true, token: "t" }] }), maxRounds: 3, maxReports: 10, sleepFn, log });
  assert.ok(r.stopReason.includes("轮次上限"));
  assert.equal(r.rounds.length, 3);
});

await record("D13 失败路径真实发送计数为 0（Mock 注入层面验证）", async () => {
  // 协议解析错误: 不执行、不发送
  const f = regFile("d13a");
  const send = makeSendReport();
  const r1 = await processConversation({
    messages: [msg("assistant", "a-1", "AGENT_TASK_BEGIN\n{broken\nAGENT_TASK_END")],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(send.calls.length, 0);
  assert.equal(r1.protocolErrors.length, 1);
  // 发送器抛异常: processConversation 不崩溃、不二次发送
  const f2 = regFile("d13b");
  const send2 = makeSendReport({ throwErr: true });
  const r2 = await processConversation({
    messages: [msg("assistant", "a-1", block({ type: "ASSISTANT_TASK", taskId: "tk-z", actions: [{ op: "node_check", target: CHECK_TARGET }] }))],
    registryFile: f2, executor: makeExecutorOk(), sendReport: send2, log: () => {},
  });
  assert.equal(send2.calls.length, 1, "仅一次发送尝试");
  assert.equal(loadRegistry(f2).tasks[0].phase, PHASES.REPORT_UNKNOWN);
  // 再次扫描: 零调用
  const send3 = makeSendReport();
  await processConversation({
    messages: [msg("assistant", "a-1", block({ type: "ASSISTANT_TASK", taskId: "tk-z", actions: [{ op: "node_check", target: CHECK_TARGET }] }))],
    registryFile: f2, executor: makeExecutorOk(), sendReport: send3, log: () => {},
  });
  assert.equal(send3.calls.length, 0);
});

await record("D14 resumeNewTasks: 登记簿 NEW 任务（块不在对话中）按恢复语义执行并回传", async () => {
  const f = regFile("d14");
  const reg = loadRegistry(f);
  // 人工重排队后的任务: 块已不在当前对话（对话被清理），但登记簿定义完整
  const { registerTask, updatePhase, saveRegistry } = await import("./task_store.mjs");
  registerTask(reg, { taskId: "tk-resume", assistantMsgId: "gone-msg", type: "ASSISTANT_TASK", actions: [{ op: "node_check", target: CHECK_TARGET }], summary: "恢复执行" });
  updatePhase(reg, "tk-resume", PHASES.NEW, { stopReason: "人工重排队" });
  saveRegistry(f, reg);
  const send = makeSendReport();
  // 不开启恢复: 对话中无块 → 不执行
  const r0 = await processConversation({ messages: [msg("assistant", "a-x", "普通聊天")], registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {} });
  assert.equal(r0.executed.length, 0);
  assert.equal(send.calls.length, 0);
  // 开启恢复: 执行 + 回传
  const r1 = await processConversation({ messages: [msg("assistant", "a-x", "普通聊天")], registryFile: f, executor: makeExecutorOk(), sendReport: send, resumeNewTasks: true, log: () => {} });
  assert.equal(r1.executed.length, 1);
  assert.equal(r1.executed[0].taskId, "tk-resume");
  assert.equal(send.calls.length, 1);
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.REPORTED);
  // 恢复执行后再扫: 不重复（phase=REPORTED 去重）
  const send2 = makeSendReport();
  const r2 = await processConversation({ messages: [msg("assistant", "a-x", "普通聊天")], registryFile: f, executor: makeExecutorOk(), sendReport: send2, resumeNewTasks: true, log: () => {} });
  assert.equal(r2.executed.length, 0);
  assert.equal(send2.calls.length, 0);
});

await record("D15 协议硬化: 非 JSON 开头的 body 不误配对执行", async () => {
  const { parseTaskBlocks } = await import("./protocol.mjs");
  // 跨段落误配对: BEGIN 与 END 之间是普通 markdown 文本
  const fake = "前言 AGENT_TASK_BEGIN 这只是普通文本，包含很多内容 AGENT_TASK_END 后记";
  const blocks = parseTaskBlocks(fake);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].ok, false);
  assert.equal(blocks[0].error, "json");
  // 纯 JSON 块仍然正常解析
  const good = block({ type: "ASSISTANT_TASK", taskId: "tk-ok", actions: [] });
  assert.ok(parseTaskBlocks(good)[0].ok);
  // markdown 围栏容错保留
  const fenced = "```json\n" + block({ type: "ASSISTANT_TASK", taskId: "tk-fenced", actions: [] }) + "\n```";
  assert.ok(parseTaskBlocks(fenced)[0].ok);
});

// D16: 空 actions 不得误报 DONE；报告-回复关联写入登记簿（C9-R7 R7-1/R7-2）
await record("D16 空 actions 判 FAILED 且记录报告-回复关联", async () => {
  const f = regFile("d16");
  const send = makeSendReport();
  const r = await processConversation({
    messages: [msg("assistant", "a-1", block({ type: "ASSISTANT_TASK", taskId: "tk-empty", actions: [] }))],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(r.executed.length, 1);
  assert.equal(r.executed[0].ok, false, "空 actions 必须判失败");
  assert.equal(send.calls.length, 1, "无动作执行也必须如实回传");
  assert.equal(send.calls[0].ex.ok, false, "报告 status 必须为 FAILED（不得空 results 冒充 DONE）");
  const t = loadRegistry(f).tasks[0];
  assert.equal(t.phase, PHASES.REPORTED);
  assert.equal(t.reportToken, "tok-1");
  assert.ok(t.reportReply, "必须记录报告-回复关联");
  assert.equal(t.reportReply.assistantMsgId, "r-1");
  assert.equal(t.reportReply.reportToken, "tok-1");
  // 报告发送失败（未知）时不得写 reportReply
  const f2 = regFile("d16b");
  const send2 = makeSendReport({ failFirst: true });
  await processConversation({
    messages: [msg("assistant", "a-1", block({ type: "ASSISTANT_TASK", taskId: "tk-empty2", actions: [] }))],
    registryFile: f2, executor: makeExecutorOk(), sendReport: send2, log: () => {},
  });
  const t2 = loadRegistry(f2).tasks[0];
  assert.equal(t2.phase, PHASES.REPORT_UNKNOWN);
  assert.ok(!t2.reportReply, "发送结果未知不得伪造回复关联");
});

// ===== C9-R8 修复专项测试 =====

// D17: 紧凑 JSON 可完整解析，中文/引号/反斜杠/换行/协议标记均不丢失（Fix B）
await record("D17 紧凑 JSON 完整往返：字段/中文/引号/反斜杠/换行保留", async () => {
  const token = "C3T-rep-d17-0001";
  const ex = {
    ok: false,
    results: [
      { action: { op: "node_check", target: "t.mjs" }, ok: false, blocked: false, exitCode: 1, reason: '路径含"引号"与\\反斜杠' },
      { action: { op: "run_project_tests", target: "test/x.mjs" }, ok: true, blocked: false, exitCode: 0, reason: "多\n行\n说明" },
    ],
  };
  const text = buildReportText({ taskId: "tk-d17", ex, summary: "含中文与特殊字符的摘要：测试『用例』", token });
  assert.ok(text.startsWith("AGENT_REPORT_BEGIN\n") && text.includes("\nAGENT_REPORT_END"));
  const parsed = parseReportBlocks(text);
  assert.equal(parsed.length, 1);
  assert.ok(parsed[0].ok, JSON.stringify(parsed[0]));
  const body = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  assert.equal(body.taskId, "tk-d17");
  assert.equal(body.reportToken, token);
  assert.equal(body.status, "FAILED");
  assert.equal(body.summary, "含中文与特殊字符的摘要：测试『用例』");
  assert.ok(body.summary.includes("『用例』"), "中文必须保留");
  assert.equal(body.results[0].reason, '路径含"引号"与\\反斜杠', "引号与反斜杠必须保留");
  assert.equal(body.results[1].reason, "多\n行\n说明", "结果内换行必须保留");
  assert.equal(body.failures.length, 1);
  assert.ok(text.includes(`报告已送达（token: ${token}）`), "新模板须含 token 与送达说明");
  assert.ok(text.includes("AGENT_TASK_BEGIN") && text.includes("TASK_COMPLETE") && text.includes("NEEDS_USER_INPUT") && text.includes("STOP"), "新模板须含续接协议（四类决策）");
  assert.ok(!text.includes("仅回复"), "新模板不得再限制『仅回复确认』");
});

// D18: 发送前有界冷却恰好调用一次且仅一次发送尝试（Fix A）
await record("D18 发送前冷却: 调用一次且只发送一次", async () => {
  const outboxDir = path.join(TMP, "d18_outbox");
  const waitCalls = [];
  let sendCalls = 0;
  const preSendWaitFn = async () => { waitCalls.push(Date.now()); return { ok: true, waitedMs: 5 }; };
  const runCommTestFn = async () => { sendCalls++; return { exitCode: 0, verdict: "CONTENT_STABLE_HEURISTIC", reply: { id: "r-18", text: "报告已收到" } }; };
  const sender = makeReportSender({ connect: async () => ({}), stateDir: path.join(TMP, "d18_state"), outboxDir, latestFile: null, log: () => {}, runCommTestFn, preSendWaitFn, sleepFn: async () => {} });
  const r = await sender({ taskId: "tk-18", ex: { ok: true, results: [] }, summary: "s" });
  assert.equal(waitCalls.length, 1, "冷却等待必须恰好调用一次");
  assert.equal(sendCalls, 1, "只允许一次发送尝试（不重试）");
  assert.equal(r.ok, true);
  const rec = JSON.parse(fs.readFileSync(path.join(outboxDir, `${r.token}.json`), "utf8"));
  assert.equal(rec.status, "DELIVERED");
});

// D19: 发送前等待未通过 → 不发送（安全停止，UNKNOWN）
await record("D19 发送前等待未通过 → 不发送（UNKNOWN 安全停止）", async () => {
  const outboxDir = path.join(TMP, "d19_outbox");
  let sendCalls = 0;
  const preSendWaitFn = async () => ({ ok: false, reason: "页面挑战检测" });
  const runCommTestFn = async () => { sendCalls++; return { exitCode: 0, verdict: "x", reply: null }; };
  const sender = makeReportSender({ connect: async () => ({}), stateDir: path.join(TMP, "d19_state"), outboxDir, latestFile: null, log: () => {}, runCommTestFn, preSendWaitFn, sleepFn: async () => {} });
  const r = await sender({ taskId: "tk-19", ex: { ok: true, results: [] }, summary: "s" });
  assert.equal(sendCalls, 0, "等待未通过不得发送");
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes("发送前等待未通过"));
  const rec = JSON.parse(fs.readFileSync(path.join(outboxDir, `${r.token}.json`), "utf8"));
  assert.equal(rec.status, "UNKNOWN");
});

// D20: 发送前等待异常 → 不发送（安全停止，UNKNOWN，不二次发送）
await record("D20 发送前等待异常 → 不发送（UNKNOWN 安全停止）", async () => {
  const outboxDir = path.join(TMP, "d20_outbox");
  let sendCalls = 0;
  const preSendWaitFn = async () => { throw new Error("WebSocket 连接丢失"); };
  const runCommTestFn = async () => { sendCalls++; return { exitCode: 0, verdict: "x", reply: null }; };
  const sender = makeReportSender({ connect: async () => ({}), stateDir: path.join(TMP, "d20_state"), outboxDir, latestFile: null, log: () => {}, runCommTestFn, preSendWaitFn, sleepFn: async () => {} });
  const r = await sender({ taskId: "tk-20", ex: { ok: true, results: [] }, summary: "s" });
  assert.equal(sendCalls, 0, "等待异常不得发送");
  assert.equal(r.ok, false);
  assert.ok(r.detail.includes("发送前等待异常"));
  const rec = JSON.parse(fs.readFileSync(path.join(outboxDir, `${r.token}.json`), "utf8"));
  assert.equal(rec.status, "UNKNOWN");
});

// D21: 紧凑 JSON 显著降低段落数（实测字符/换行/段落计数）
await record("D21 紧凑 JSON 显著减少段落（实测字符/换行/段落）", async () => {
  const token = "C3T-rep-d21-0001";
  const ex = { ok: true, results: Array.from({ length: 10 }, (_, i) => ({ action: { op: "run_project_tests", target: `t${i}.mjs` }, ok: true, blocked: false, exitCode: 0, reason: `第${i}项` })) };
  const compact = buildReportText({ taskId: "tk-d21", ex, summary: "摘要", token });
  const prettyBody = JSON.stringify({
    taskId: "tk-d21", status: "DONE", summary: "摘要", reportToken: token,
    results: ex.results.map((r) => ({ op: r.action.op, target: r.action.target, ok: true, blocked: false, exitCode: 0, reason: r.reason })),
    failures: [],
  }, null, 1);
  const pretty = `AGENT_REPORT_BEGIN\n${prettyBody}\nAGENT_REPORT_END\n\n请确认收到，并仅回复：报告已收到 ${token}`;
  const stats = (s) => ({ chars: s.length, newlines: (s.match(/\n/g) || []).length, paragraphs: s.split("\n").length });
  const c = stats(compact), p = stats(pretty);
  assert.ok(c.paragraphs < p.paragraphs, `紧凑段落(${c.paragraphs}) 须 < pretty段落(${p.paragraphs})`);
  assert.ok(p.paragraphs >= 20, `pretty 应含真实换行（段落=${p.paragraphs}）`);
  // Fix B 核心：JSON 正文本身为单行（紧凑），段落增量仅来自报告尾部续接协议文案
  const bodyLine = compact.split("AGENT_REPORT_BEGIN\n")[1].split("\nAGENT_REPORT_END")[0];
  assert.ok(!bodyLine.includes("\n"), "紧凑 JSON 正文必须为单行（无内部换行）");
  assert.ok(c.paragraphs <= 20, `紧凑段落须远小于 pretty（实测 ${c.paragraphs}）`);
  const cb = JSON.parse(compact.slice(compact.indexOf("{"), compact.lastIndexOf("}") + 1));
  assert.equal(cb.results.length, 10, "全部结果字段必须保留");
  console.log(`  [实测] 紧凑: ${c.chars}字符/${c.newlines}换行/${c.paragraphs}段落; pretty: ${p.chars}字符/${p.newlines}换行/${p.paragraphs}段落（pretty 多为 JSON 内部换行）`);
});

// D22: 默认冷却受 30s 上限约束（注入 sleepFn 记录，不真实睡眠）
await record("D22 默认冷却受 30s 上限约束且可注入（不真实睡眠）", async () => {
  let slept = 0;
  const sleepFn = async (ms) => { slept += ms; };
  const r = await defaultPreSendWait({ maxMs: 30000, cooldownMs: 999999, sleepFn });
  assert.equal(r.ok, true);
  assert.equal(r.waitedMs, 30000, "超过上限须截断为 30s");
  assert.equal(slept, 30000, "注入 sleepFn 记录的实际睡眠须等于截断值");
  let slept2 = 0;
  const r2 = await defaultPreSendWait({ maxMs: 30000, cooldownMs: 2000, sleepFn: async (ms) => { slept2 += ms; } });
  assert.equal(r2.waitedMs, 2000);
  assert.equal(slept2, 2000);
});

// D23: C9-R10 R10-1/R10-2 回归：报告模板不再限制"仅回复确认"，且包含续接协议
await record("D23 报告模板解除『仅回复确认』限制并含续接协议（R10-1/R10-2）", async () => {
  const token = "C3T-rep-d23-0001";
  const text = buildReportText({ taskId: "tk-d23", ex: { ok: true, results: [] }, summary: "s", token });
  assert.ok(!text.includes("仅回复"), "不得再含『仅回复』限制指令");
  assert.ok(!/请确认收到[，,]?并仅回复/.test(text), "不得再含『请确认收到，并仅回复』句式");
  assert.ok(text.includes(`报告已送达（token: ${token}）`), "须保留送达与 token 说明");
  assert.ok(text.includes("请在回复中包含该 token"), "须要求回显 token 以便送达确认（避免报告被判 UNKNOWN 而阻断续接）");
  for (const kw of ["AGENT_TASK_BEGIN", "TASK_COMPLETE", "NEEDS_USER_INPUT", "STOP"]) {
    assert.ok(text.includes(kw), `续接协议必须提及决策类型: ${kw}`);
  }
  const body = JSON.parse(text.split("AGENT_REPORT_BEGIN\n")[1].split("\nAGENT_REPORT_END")[0]);
  assert.equal(body.reportToken, token);
});

// D24: C9-R13 R13-2/R13-3 任务完成契约——actions 成功不再被无条件等同于整个任务完成
await record("D24 actions 成功≠任务完成：报告须标 ACTIONS_DONE 且 goalAchieved=false（R13-2/R13-3）", async () => {
  const parse = (t) => JSON.parse(t.split("AGENT_REPORT_BEGIN\n")[1].split("\nAGENT_REPORT_END")[0]);
  // 1) 全部 actions 成功：状态必须为 ACTIONS_DONE，严禁 DONE；并显式标记目标未验证
  const exOk = { ok: true, results: [
    { action: { op: "node_check", target: "test/collab_once.mjs" }, ok: true, blocked: false, exitCode: 0 },
    { action: { op: "run_project_tests", target: "x" }, ok: true, blocked: false, exitCode: 0 },
  ] };
  const b1 = parse(buildReportText({ taskId: "tk-d24a", ex: exOk, summary: "仅语法检查通过", token: "C3T-rep-d24a" }));
  assert.equal(b1.status, "ACTIONS_DONE", "actions 全成功必须标 ACTIONS_DONE，不得标 DONE");
  assert.notEqual(b1.status, "DONE", "严禁把 actions 成功等同于整个任务完成(DONE)");
  assert.equal(b1.goalAchieved, false, "执行器无法验证自然语言目标，goalAchieved 必须为 false");
  assert.ok(/不代表任务目标/.test(b1.note), "note 必须说明 actions 成功≠目标达成");
  // 2) 存在被阻断的 action：状态必须为 BLOCKED（不得谎称 DONE/ACTIONS_DONE）
  const b2 = parse(buildReportText({ taskId: "tk-d24b", ex: { ok: false, results: [{ action: { op: "node_check", target: "../evil/x.mjs" }, ok: false, blocked: true, reason: "目标越界" }] }, summary: "s", token: "C3T-rep-d24b" }));
  assert.equal(b2.status, "BLOCKED", "被阻断 action 必须标 BLOCKED");
  // 3) 普通失败：状态必须为 FAILED
  const b3 = parse(buildReportText({ taskId: "tk-d24c", ex: { ok: false, results: [{ action: { op: "node_check", target: "test/x.mjs" }, ok: false, blocked: false, exitCode: 1, reason: "语法错误" }] }, summary: "s", token: "C3T-rep-d24c" }));
  assert.equal(b3.status, "FAILED", "执行失败必须标 FAILED");
  // 4) 终态 DONE 仍保留给 ChatGPT TASK_COMPLETE 决策 / agent 确认，未被契约移除
  assert.ok(REPORT_STATUS.includes("ACTIONS_DONE") && REPORT_STATUS.includes("DONE"), "枚举须同时含 ACTIONS_DONE 与 DONE（DONE 保留给 TASK_COMPLETE/agent 确认）");
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
