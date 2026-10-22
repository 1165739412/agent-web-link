// C9 协作闭环 Mock 测试（不访问 CDP、不连浏览器、不发送真实消息）
// 覆盖任务书 §七 全部 17 项要求
// 用法: node protocol_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { parseTaskBlocks, parseReportBlocks, diffMessages, latestUserBefore } from "./protocol.mjs";
import { PHASES, loadRegistry, saveRegistry, registerTask, updatePhase, findTask } from "./task_store.mjs";
import { makeExecutor } from "./agent_executor.mjs";
import { processConversation } from "./collab_once.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(SELF_DIR, "tmp_c9");
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

// ---- 协议解析 ----
await record("P1 无标记普通文本不产生任务块（防误执行）", async () => {
  assert.deepEqual(parseTaskBlocks("你好，帮我看看这段代码为什么慢？"), []);
  assert.deepEqual(parseTaskBlocks("AGENT_TASK_BEGIN 没有 END 的残缺块"), [
    { ok: false, kind: "task", error: "incomplete", raw: "AGENT_TASK_BEGIN 没有 END 的残缺块" },
  ]);
});

await record("P2 合法 ASSISTANT_TASK 解析（含 markdown 围栏容错）", async () => {
  const t = { type: "ASSISTANT_TASK", taskId: "t-1", summary: "s", actions: [{ op: "node_check", target: "test/x.mjs" }] };
  const plain = block(t);
  const fenced = "```json\n" + block(t) + "\n```";
  for (const txt of [plain, fenced]) {
    const r = parseTaskBlocks(txt);
    assert.equal(r.length, 1);
    assert.ok(r[0].ok);
    assert.equal(r[0].taskId, "t-1");
    assert.equal(r[0].type, "ASSISTANT_TASK");
  }
});

await record("P3 非法任务块安全失败（类型未知/taskId 缺失/JSON 损坏）", async () => {
  assert.equal(parseTaskBlocks(block({ type: "HACK", taskId: "t" }))[0].error, "type");
  assert.equal(parseTaskBlocks(block({ type: "ASSISTANT_TASK" }))[0].error, "taskId");
  assert.equal(parseTaskBlocks("AGENT_TASK_BEGIN\n{broken\nAGENT_TASK_END")[0].error, "json");
});

await record("P4 消息差分: 新/旧助手消息与用户消息区分", async () => {
  const prev = [msg("user", null, "旧用户"), msg("assistant", "a1", "旧回复")];
  const cur = [...prev, msg("user", null, "新指令"), msg("assistant", "a2", "新回复")];
  const d = diffMessages(prev, cur);
  assert.equal(d.newUsers.length, 1);
  assert.equal(d.newAssistants.length, 1);
  assert.equal(d.newAssistants[0].id, "a2");
});

await record("P5 任务来源关联: 助手消息之前最近用户消息", async () => {
  const msgs = [msg("user", null, "第一问"), msg("assistant", "a1", "第一答"), msg("user", null, "第二问"), msg("assistant", "a2", block({ type: "ASSISTANT_TASK", taskId: "t" }))];
  assert.equal(latestUserBefore(msgs, 1).text, "第一问");
  assert.equal(latestUserBefore(msgs, 3).text, "第二问");
});

// ---- 登记簿去重 ----
await record("P6 旧回复/重复 taskId 不重复执行", async () => {
  const f = regFile("p6");
  const reg = loadRegistry(f);
  assert.ok(registerTask(reg, { taskId: "t-1", assistantMsgId: "a1", type: "ASSISTANT_TASK", actions: [] }).ok);
  const dup1 = registerTask(reg, { taskId: "t-1", assistantMsgId: "a2", type: "ASSISTANT_TASK", actions: [] });
  const dup2 = registerTask(reg, { taskId: "t-9", assistantMsgId: "a1", type: "ASSISTANT_TASK", actions: [] });
  assert.equal(dup1.code, "DUPLICATE_TASK");
  assert.equal(dup2.code, "EXISTS_MSG");
  saveRegistry(f, reg);
  assert.equal(loadRegistry(f).tasks.length, 1);
});

await record("P7 登记簿损坏 → 保守停止不静默重建", async () => {
  const f = regFile("p7");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "{broken", "utf8");
  const reg = loadRegistry(f);
  assert.ok(reg.ok === false);
});

// ---- 执行器边界 ----
const executor = makeExecutor({ projectRoot: path.join(SELF_DIR, ".."), log: () => {} });
await record("P8 越界目标拒绝", async () => {
  assert.ok(!executor.validateAction({ op: "node_check", target: "../example-project/train.py" }).ok);
  assert.ok(!executor.validateAction({ op: "node_check", target: "C:/Windows/system32/cmd.exe" }).ok);
  assert.ok(!executor.validateAction({ op: "shell", target: "rm -rf /" }).ok);
  assert.ok(!executor.validateAction({ op: "node_check", target: "test/不存在.mjs" }).ok);
  assert.ok(executor.validateAction({ op: "node_check", target: "test/cdp_ws_client.mjs" }).ok);
});

await record("P9 越界动作不执行（blocked 标记）", async () => {
  const r = executor.executeActions([{ op: "node_check", target: "../outside/x.mjs" }]);
  assert.equal(r.results[0].blocked, true);
  assert.equal(r.ok, false);
});

// ---- 单轮闭环（注入 Mock sendReport） ----
function makeExecutorOk() {
  return makeExecutor({ projectRoot: path.join(SELF_DIR, ".."), log: () => {} });
}
const OK_TASK = block({ type: "ASSISTANT_TASK", taskId: "tk-1", summary: "语法检查", actions: [{ op: "node_check", target: "test/cdp_ws_client.mjs" }] });

await record("T10 正常闭环: 识别→执行→报告回传→REPORTED", async () => {
  const f = regFile("t10");
  const reports = [];
  const r = await processConversation({
    messages: [msg("user", null, "请检查语法"), msg("assistant", "a-ok", OK_TASK)],
    registryFile: f, executor: makeExecutorOk(),
    sendReport: async (rep) => { reports.push(rep); return { ok: true, token: "rep-tok" }; },
    log: () => {},
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.executed.length, 1);
  assert.equal(reports.length, 1);
  const s = loadRegistry(f).tasks[0];
  assert.equal(s.phase, PHASES.REPORTED);
  assert.equal(s.assistantMsgId, "a-ok");
  assert.equal(s.userSource.text, "请检查语法");
});

await record("T11 普通聊天不触发执行", async () => {
  const f = regFile("t11");
  const r = await processConversation({
    messages: [msg("user", null, "闲聊"), msg("assistant", "a-chat", "这只是解释，没有任务块")],
    registryFile: f, executor: makeExecutorOk(),
    sendReport: async () => { throw new Error("不应发送"); },
    log: () => {},
  });
  assert.equal(r.executed.length, 0);
  assert.ok(!fs.existsSync(f));
});

await record("T12 同一回复二次运行不重复执行（恢复语义）", async () => {
  const f = regFile("t12");
  const msgs = [msg("user", null, "q"), msg("assistant", "a-ok", OK_TASK)];
  const send = async () => ({ ok: true, token: "t" });
  await processConversation({ messages: msgs, registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {} });
  const r2 = await processConversation({ messages: msgs, registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {} });
  assert.equal(r2.executed.length, 0);
  assert.ok(r2.skipped.some((s) => s.reason.includes("防重复执行")));
});

await record("T13 STOP 停止自动推进，后续块全部跳过", async () => {
  const f = regFile("t13");
  const msgs = [msg("assistant", "a-stop", block({ type: "STOP", taskId: "stop-1" })), msg("assistant", "a-task", OK_TASK)];
  const send = async () => ({ ok: true, token: "t" });
  const r = await processConversation({ messages: msgs, registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {} });
  assert.equal(r.stopped, true);
  assert.equal(r.executed.length, 0);
  assert.ok(r.skipped.some((s) => s.reason.includes("停止")));
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.STOPPED);
});

await record("T14 NEEDS_USER_INPUT 暂停并保留现场", async () => {
  const f = regFile("t14");
  const msgs = [msg("assistant", "a-n", block({ type: "NEEDS_USER_INPUT", taskId: "n-1", summary: "需要用户选择方案" })), msg("assistant", "a-task", OK_TASK)];
  const send = async () => ({ ok: true, token: "t" });
  const r = await processConversation({ messages: msgs, registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {} });
  assert.equal(r.needsInput, true);
  assert.equal(r.executed.length, 0);
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.NEEDS_INPUT);
});

await record("T15 TASK_COMPLETE 记录完成", async () => {
  const f = regFile("t15");
  const r = await processConversation({
    messages: [msg("assistant", "a-c", block({ type: "TASK_COMPLETE", taskId: "c-1" }))],
    registryFile: f, executor: makeExecutorOk(),
    sendReport: async () => ({ ok: true, token: "t" }), log: () => {},
  });
  assert.equal(r.completed, true);
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.DONE);
});

await record("T16 报告回传结果未知 → REPORT_UNKNOWN，不重发", async () => {
  const f = regFile("t16");
  const send = async () => ({ ok: false, token: "t", detail: "exit=34 UNKNOWN" });
  const r = await processConversation({
    messages: [msg("assistant", "a-ok", OK_TASK)],
    registryFile: f, executor: makeExecutorOk(), sendReport: send, log: () => {},
  });
  assert.equal(r.exitCode, 61);
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.REPORT_UNKNOWN);
  // 恢复运行: 同一回复再次扫描 → 跳过（不重发报告）
  const r2 = await processConversation({
    messages: [msg("assistant", "a-ok", OK_TASK)],
    registryFile: f, executor: makeExecutorOk(), sendReport: async () => { throw new Error("不得重发"); }, log: () => {},
  });
  assert.equal(r2.executed.length, 0);
  assert.ok(r2.skipped.some((s) => s.reason.includes("REPORT_UNKNOWN") || s.reason.includes("防重复执行")));
});

await record("T17 用户修改方向: 新任务优先，旧任务状态保留", async () => {
  const f = regFile("t17");
  const old = block({ type: "ASSISTANT_TASK", taskId: "old-1", actions: [{ op: "node_check", target: "test/cdp_ws_client.mjs" }] });
  const msgs1 = [msg("user", null, "做 A"), msg("assistant", "a-old", old)];
  await processConversation({ messages: msgs1, registryFile: f, executor: makeExecutorOk(), sendReport: async () => ({ ok: true, token: "t" }), log: () => {} });
  const newTask = block({ type: "ASSISTANT_TASK", taskId: "new-1", summary: "用户改变了方向", actions: [{ op: "node_check", target: "test/protocol.mjs" }] });
  const r2 = await processConversation({ messages: [...msgs1, msg("user", null, "改做 B"), msg("assistant", "a-new", newTask)], registryFile: f, executor: makeExecutorOk(), sendReport: async () => ({ ok: true, token: "t" }), log: () => {} });
  assert.equal(r2.executed.length, 1);
  assert.equal(r2.executed[0].taskId, "new-1");
  const reg = loadRegistry(f);
  assert.equal(reg.tasks.find(t => t.taskId === "old-1").phase, PHASES.REPORTED, "旧任务状态保留");
  assert.equal(reg.tasks.find(t => t.taskId === "new-1").phase, PHASES.REPORTED);
});

await record("T18 协议解析错误安全停止（不执行、计数并报告）", async () => {
  const f = regFile("t18");
  const r = await processConversation({
    messages: [msg("assistant", "a-bad", "AGENT_TASK_BEGIN\n{broken\nAGENT_TASK_END")],
    registryFile: f, executor: makeExecutorOk(),
    sendReport: async () => { throw new Error("不得发送"); }, log: () => {},
  });
  assert.equal(r.executed.length, 0);
  assert.equal(r.protocolErrors.length, 1);
});

await record("T19 执行成功路径真实运行 node_check", async () => {
  const f = regFile("t19");
  const r = await processConversation({
    messages: [msg("assistant", "a-ok", OK_TASK)],
    registryFile: f, executor: makeExecutorOk(), sendReport: async () => ({ ok: true, token: "t" }), log: () => {},
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.executed[0].ok, true);
});

await record("T20 报告解析（round-trip）", async () => {
  const rep = { taskId: "tk-1", status: "DONE", reportToken: "t" };
  const r = parseReportBlocks(`AGENT_REPORT_BEGIN\n${JSON.stringify(rep)}\nAGENT_REPORT_END`);
  assert.equal(r[0].ok, true);
  assert.equal(r[0].taskId, "tk-1");
});

await record("T21 人工复核重排队: REPORT_UNKNOWN→NEW 后允许重新回传（上次发送从未发生）", async () => {
  const f = regFile("t21");
  const send = async () => { throw new Error("不得发送"); };
  // 第一次: 报告回传被阻断（模拟发送前门禁失败，从未提交）
  await processConversation({
    messages: [msg("assistant", "a-ok", OK_TASK)],
    registryFile: f, executor: makeExecutorOk(), sendReport: async () => ({ ok: false, token: "t1", detail: "exit=59 发送前阻断" }), log: () => {},
  });
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.REPORT_UNKNOWN);
  // 人工复核: 确认上次发送从未发生（0 次点击），重排队为 NEW
  const reg21 = loadRegistry(f);
  updatePhase(reg21, "tk-1", PHASES.NEW, { stopReason: "人工复核: 上次报告从未提交(0次点击)，允许重新回传" });
  saveRegistry(f, reg21);
  let sendCount = 0;
  const r2 = await processConversation({
    messages: [msg("assistant", "a-ok", OK_TASK)],
    registryFile: f, executor: makeExecutorOk(), sendReport: async (rep) => { sendCount++; return { ok: true, token: "t2" }; }, log: () => {},
  });
  assert.equal(r2.exitCode, 0, JSON.stringify(r2));
  assert.equal(sendCount, 1, "重排队后恰好回传一次");
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.REPORTED);
});

await record("T22 重排队任务复用（不产生重复登记）", async () => {
  const f = regFile("t22");
  const reg = loadRegistry(f);
  registerTask(reg, { taskId: "tk-re", assistantMsgId: "a-1", type: "ASSISTANT_TASK", actions: [{ op: "node_check", target: "test/cdp_ws_client.mjs" }] });
  updatePhase(reg, "tk-re", PHASES.NEW, { stopReason: "人工重排队" });
  saveRegistry(f, reg);
  // 重发同一助手回复（taskId 一致）→ 复用已重排队任务
  const r = await processConversation({
    messages: [msg("assistant", "a-1", block({ type: "ASSISTANT_TASK", taskId: "tk-re", actions: [{ op: "node_check", target: "test/cdp_ws_client.mjs" }] }))],
    registryFile: f, executor: makeExecutorOk(), sendReport: async () => ({ ok: true, token: "t" }), log: () => {},
  });
  assert.equal(r.executed.length, 1);
  assert.equal(loadRegistry(f).tasks.length, 1, "不产生重复登记");
  assert.equal(loadRegistry(f).tasks[0].phase, PHASES.REPORTED);
  // 不同 taskId 的块挂同一助手消息 → 仍应拒绝（一条回复一个任务）
  const r2 = await processConversation({
    messages: [msg("assistant", "a-1", block({ type: "ASSISTANT_TASK", taskId: "tk-other", actions: [] }))],
    registryFile: f, executor: makeExecutorOk(), sendReport: async () => ({ ok: true, token: "t" }), log: () => {},
  });
  assert.equal(r2.executed.length, 0, "同一条助手消息只允许一个任务");
  assert.ok(r2.skipped.length > 0, "不同 taskId 挂同一助手消息应被跳过");
});

// P10: 无效反斜杠转义修复（C9-R6 实机缺陷: ChatGPT 把 f:\\agent-link 规范化为 f:\agent-link）
await record("P10 单反斜杠 Windows 路径块可解析且值正确", async () => {
  // 单反斜杠(\a 为无效 JSON 转义) → 修复后应解析出原值
  const single = "AGENT_TASK_BEGIN\n" + JSON.stringify({ type: "ASSISTANT_TASK", taskId: "tk-bs", actions: [], root: "f:\\agent-link" }).replace(/\\\\/g, "\\") + "\nAGENT_TASK_END";
  // 注意: 上面构造出的 body 中 root 值为 f:\agent-link（单反斜杠）
  const b1 = parseTaskBlocks(single);
  assert.equal(b1.length, 1);
  assert.ok(b1[0].ok, `单反斜杠块应可解析: ${JSON.stringify(b1[0])}`);
  assert.equal(b1[0].taskId, "tk-bs");
  // 合法双反斜杠 → 解析值同为单反斜杠
  const dbl = "AGENT_TASK_BEGIN\n" + JSON.stringify({ type: "ASSISTANT_TASK", taskId: "tk-bs2", actions: [], root: "f:\\agent-link" }) + "\nAGENT_TASK_END";
  const b2 = parseTaskBlocks(dbl);
  assert.ok(b2[0].ok);
  assert.equal(b2[0].taskId, "tk-bs2");
  // 合法转义序列不被破坏
  const esc = "AGENT_TASK_BEGIN\n" + JSON.stringify({ type: "ASSISTANT_TASK", taskId: "tk-esc", actions: [], note: "line1\nline2 \"quoted\" back\\slash" }) + "\nAGENT_TASK_END";
  const b3 = parseTaskBlocks(esc);
  assert.ok(b3[0].ok, JSON.stringify(b3[0]));
  assert.equal(b3[0].taskId, "tk-esc");
  // 修复不放宽安全边界: 非 { 开头仍拒绝；未知 type/缺 taskId 仍拒绝
  assert.equal(parseTaskBlocks("AGENT_TASK_BEGIN\n普通文本\nAGENT_TASK_END")[0].error, "json");
  assert.equal(parseTaskBlocks("AGENT_TASK_BEGIN\n" + JSON.stringify({ type: "FOO", taskId: "t" }) + "\nAGENT_TASK_END")[0].error, "type");
  assert.equal(parseTaskBlocks("AGENT_TASK_BEGIN\n" + JSON.stringify({ type: "ASSISTANT_TASK" }) + "\nAGENT_TASK_END")[0].error, "taskId");
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
