// C9-R21 MCP 桥接测试：以真实 stdio JSON-RPC 子进程验证握手、工具契约、领取唯一性、
// 结果提交校验、项目隔离与状态契约。注意：本文件验证的是**桥接与协议**，
// 不等同于"宿主会话内真实 Agent 自动派发"（后者另由 R21 实机两轮验证单独记录证据）。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTaskService } from "./local_service.mjs";
import { PHASES, loadRegistry, saveRegistry, registerTask, findTask } from "./task_store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-mcp-"));
const results = [];
async function record(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

function makeProject(tag, name) {
  const root = path.join(BASE, tag, name);
  fs.mkdirSync(path.join(root, "work"), { recursive: true });
  const cfgPath = path.join(root, "project.config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    schemaVersion: 1, name, projectRoot: root,
    projectTests: [{ command: "node", args: ["work/ok.mjs"] }],
    agentCommand: null,
    paths: { stateDir: ".state", tasksDir: ".tasks" },
  }, null, 2), "utf8");
  return { root, cfgPath, name, tasksDir: path.join(root, ".tasks") };
}
function makeProjectsRegistry(tag, projects) {
  const file = path.join(BASE, tag, "projects.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: projects.map((p) => ({ name: p.name, config: p.cfgPath })) }, null, 2), "utf8");
  return file;
}
// 直接落 NEW 的 agent 模式任务（与 HTTP 提交 mode=agent 写入的登记簿格式完全一致）
function seedTask(project, taskId, summary = "seed") {
  const file = path.join(project.tasksDir, "registry.json");
  const reg = loadRegistry(file);
  const r = registerTask(reg, { taskId, assistantMsgId: `api:${taskId}`, type: "ASSISTANT_TASK", actions: [], summary });
  if (r.ok) { r.task.source = "api"; r.task.execution = "agent"; }
  saveRegistry(file, reg);
}

function startMcp(projectsFile) {
  const tokenFile = path.join(path.dirname(projectsFile), "token.txt");
  const child = spawn(process.execPath, [path.join(__dirname, "mcp_server.mjs"), "--projects", projectsFile, "--token-file", tokenFile], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let seq = 0;
  const pending = new Map();
  const rawLines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      rawLines.push(line);
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch {}
    }
  });
  child.stderr.on("data", () => {});
  const request = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return {
    async init() {
      const r = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      // 规范时序：客户端收到 initialize 响应后发送 notifications/initialized（无 id，无需响应）
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return r.result;
    },
    async list() { const r = await request("tools/list", {}); return r.result.tools; },
    async call(name, args = {}) {
      const r = await request("tools/call", { name, arguments: args });
      const text = r.result?.content?.[0]?.text ?? "";
      let obj = text;
      try { obj = JSON.parse(text); } catch {}
      return { isError: r.result?.isError === true, error: r.error, obj };
    },
    close() { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} },
    rawLines,
    request,
  };
}

// ---------- M1 握手与工具契约 ----------
await record("M1 initialize + tools/list 真实握手，五个工具齐备（含新增发现类工具）", async () => {
  const a = makeProject("m1", "proj-a");
  const mcp = startMcp(makeProjectsRegistry("m1", [a]));
  try {
    const info = await mcp.init();
    assert.equal(info.serverInfo.name, "agent-web-link");
    assert.ok(info.capabilities.tools);
    assert.ok(info.instructions, "initialize 应返回 instructions");
    const tools = await mcp.list();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "agent_link_claim_next_task", "agent_link_get_task", "agent_link_list_projects",
      "agent_link_list_tasks", "agent_link_submit_result",
    ]);
    const get = tools.find((t) => t.name === "agent_link_get_task");
    assert.equal(get.annotations.readOnlyHint, true, "get_task 应标注只读");
  } finally { mcp.close(); }
});

await record("M2 工具 schema 不接受命令/路径/可执行文件参数", async () => {
  const a = makeProject("m2", "proj-a");
  const mcp = startMcp(makeProjectsRegistry("m2", [a]));
  try {
    await mcp.init();
    const tools = await mcp.list();
    const forbidden = /command|cmd|shell|exec|argv|args|path|dir|file/i;
    for (const t of tools) {
      const keys = Object.keys(t.inputSchema.properties || {});
      for (const k of keys) assert.ok(!forbidden.test(k), `${t.name} 出现可疑参数 ${k}`);
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} 必须禁止附加属性`);
    }
    const submit = tools.find((t) => t.name === "agent_link_submit_result");
    assert.deepEqual(submit.inputSchema.required.sort(), ["evidence", "ok", "project", "taskId"]);
  } finally { mcp.close(); }
});

// ---------- M3 领取唯一性 ----------
await record("M3 空队列领取返回空；领取后不重复领取", async () => {
  const a = makeProject("m3", "proj-a");
  seedTask(a, "m3-1", "任务一");
  const mcp = startMcp(makeProjectsRegistry("m3", [a]));
  try {
    await mcp.init();
    const c1 = await mcp.call("agent_link_claim_next_task", {});
    assert.equal(c1.isError, false, JSON.stringify(c1.obj));
    assert.equal(c1.obj.task.taskId, "m3-1");
    assert.equal(c1.obj.task.project, "proj-a");
    const st = await mcp.call("agent_link_get_task", { project: "proj-a", taskId: "m3-1" });
    assert.equal(st.obj.task.phase, PHASES.RUNNING);
    const c2 = await mcp.call("agent_link_claim_next_task", {});
    assert.equal(c2.obj.task, null, "同一任务不得被重复领取");
  } finally { mcp.close(); }
});

// ---------- M4 结果提交校验 ----------
await record("M4 结果提交校验：缺证据/未知任务/错误阶段/错误项目 全部拒绝", async () => {
  const a = makeProject("m4", "proj-a");
  seedTask(a, "m4-1", "任务一");
  seedTask(a, "m4-2", "任务二");
  const mcp = startMcp(makeProjectsRegistry("m4", [a]));
  try {
    await mcp.init();
    const claim = await mcp.call("agent_link_claim_next_task", {});
    assert.equal(claim.obj.task.taskId, "m4-1");

    const noEvidence = await mcp.call("agent_link_submit_result", { project: "proj-a", taskId: "m4-1", ok: true, evidence: [] });
    assert.equal(noEvidence.isError, true);
    assert.equal(noEvidence.obj.code, "EVIDENCE_REQUIRED");

    const unknown = await mcp.call("agent_link_submit_result", { project: "proj-a", taskId: "nope", ok: true, evidence: { a: 1 } });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.obj.code, "TASK_NOT_FOUND");

    const wrongProject = await mcp.call("agent_link_submit_result", { project: "nope", taskId: "m4-1", ok: true, evidence: { a: 1 } });
    assert.equal(wrongProject.isError, true);
    assert.equal(wrongProject.obj.code, "UNKNOWN_PROJECT");

    // m4-2 未领取（NEW）：本实现允许直接提交（外部脚本路径），但阶段校验仍生效
    await mcp.call("agent_link_submit_result", { project: "proj-a", taskId: "m4-2", ok: true, evidence: ["ok"] });
    const again = await mcp.call("agent_link_submit_result", { project: "proj-a", taskId: "m4-2", ok: true, evidence: ["ok"] });
    assert.equal(again.isError, true);
    assert.equal(again.obj.code, "INVALID_STATE", "重复提交必须被拒");
  } finally { mcp.close(); }
});

// ---------- M5 领取后本地 Worker 不重复执行 ----------
await record("M5 任务被 Agent 领取后，本地 Worker 跳过执行（不重复执行同一任务）", async () => {
  const a = makeProject("m5", "proj-a");
  fs.writeFileSync(path.join(a.root, "work", "ok.mjs"), "export const ok = 1;\n", "utf8");
  let workerCalls = 0;
  const service = createTaskService({
    projectsFile: makeProjectsRegistry("m5", [a]),
    tokenFile: path.join(BASE, "m5", "token.txt"),
    worker: async () => { workerCalls++; return { ok: true, results: [] }; },
    log: () => {},
  });
  service.start();
  const sub = service.submit({ project: "proj-a", taskId: "m5-1", summary: "x", actions: [{ op: "node_check", target: "work/ok.mjs" }] });
  assert.equal(sub.ok, true);
  const claim = service.claimNext({ claimedBy: "mcp" });
  assert.equal(claim.task.taskId, "m5-1");
  await service.awaitIdle(10000);
  assert.equal(workerCalls, 0, "已领取任务不得由本地 Worker 再执行一次");
  const st = service.status({ project: "proj-a", taskId: "m5-1" });
  assert.equal(st.task.phase, PHASES.RUNNING);
});

// ---------- M6 提交成功 → 报告可核验 ----------
await record("M6 提交带证据的结果 → REPORTED/ACTIONS_DONE，证据可在报告中取回", async () => {
  const a = makeProject("m6", "proj-a");
  seedTask(a, "m6-1", "创建并验证文件");
  const mcp = startMcp(makeProjectsRegistry("m6", [a]));
  try {
    await mcp.init();
    const claim = await mcp.call("agent_link_claim_next_task", {});
    assert.equal(claim.obj.task.taskId, "m6-1");
    const evidence = { file: "work/hello.txt", content: "R21-EVIDENCE", bytes: 12 };
    const sub = await mcp.call("agent_link_submit_result", {
      project: "proj-a", taskId: "m6-1", ok: true, evidence, summary: "已创建并读回校验",
    });
    assert.equal(sub.isError, false, JSON.stringify(sub.obj));
    assert.equal(sub.obj.phase, PHASES.REPORTED);
    assert.equal(sub.obj.report.status, "ACTIONS_DONE");
    assert.equal(sub.obj.report.goalAchieved, false);
    assert.equal(sub.obj.report.taskComplete, false);
    assert.deepEqual(sub.obj.report.evidence, evidence);

    // 另起一个服务实例（等价外部脚本/HTTP 查询）读取同一份报告
    const svc = createTaskService({ projectsFile: makeProjectsRegistry("m6", [a]), tokenFile: path.join(BASE, "m6", "token.txt"), log: () => {} });
    const rep = svc.report({ project: "proj-a", taskId: "m6-1" });
    assert.equal(rep.ok, true);
    assert.equal(rep.report.status, "ACTIONS_DONE");
    assert.equal(rep.report.evidence.content, "R21-EVIDENCE");
  } finally { mcp.close(); }
});

// ---------- M7 项目隔离 ----------
await record("M7 桥接按项目隔离：限定项目后不会领到别的项目任务", async () => {
  const a = makeProject("m7", "proj-a");
  const b = makeProject("m7", "proj-b");
  seedTask(a, "m7-a", "A 的任务");
  seedTask(b, "m7-b", "B 的任务");
  const mcp = startMcp(makeProjectsRegistry("m7", [a, b]));
  try {
    await mcp.init();
    const onlyB = await mcp.call("agent_link_claim_next_task", { project: "proj-b" });
    assert.equal(onlyB.obj.task.taskId, "m7-b");
    const regA = loadRegistry(path.join(a.tasksDir, "registry.json"));
    assert.equal(findTask(regA, { taskId: "m7-a" }).phase, PHASES.NEW, "A 的任务不应被 B 的领取影响");
  } finally { mcp.close(); }
});

// ---------- M8 agent 模式：经 API 提交 → 本地 Worker 不执行 → 由桥接领取 ----------
await record("M8 agent 模式任务：本地 Worker 不执行，只能由 Agent 通过桥接领取", async () => {
  const a = makeProject("m8", "proj-a");
  fs.writeFileSync(path.join(a.root, "work", "ok.mjs"), "export const ok = 1;\n", "utf8");
  const projectsFile = makeProjectsRegistry("m8", [a]);
  let workerCalls = 0;
  const svc = createTaskService({
    projectsFile, tokenFile: path.join(BASE, "m8", "token.txt"),
    worker: async () => { workerCalls++; return { ok: true, results: [] }; }, log: () => {},
  });
  svc.start();
  const bad = svc.submit({ project: "proj-a", summary: "需要真实 Agent 的工作", mode: "agent", actions: [{ op: "node_check", target: "work/ok.mjs" }] });
  assert.equal(bad.ok, false, "agent 模式不允许携带白名单 actions");
  assert.equal(bad.code, "AGENT_MODE_NO_ACTIONS");
  const okSub = svc.submit({ project: "proj-a", summary: "在 work/ 下创建 hello.txt", mode: "agent" });
  assert.equal(okSub.ok, true, JSON.stringify(okSub));
  assert.equal(okSub.execution, "agent");
  await svc.awaitIdle(5000);
  assert.equal(workerCalls, 0, "agent 模式任务不得由本地 Worker 执行");
  assert.equal(svc.status({ project: "proj-a", taskId: okSub.taskId }).task.phase, PHASES.NEW);

  const mcp = startMcp(projectsFile);
  try {
    await mcp.init();
    const claim = await mcp.call("agent_link_claim_next_task", {});
    assert.equal(claim.obj.task.taskId, okSub.taskId, "Agent 应能领到该任务");
  } finally { mcp.close(); }
});

// ---------- M9 stdout 纯净性（DS 评审第 1 点，最高优先）：stdout 每行都是 JSON-RPC 消息 ----------
await record("M9 stdout 纯净性：所有行均为合法 JSON-RPC（审计/日志只走 stderr）", async () => {
  const a = makeProject("m9", "proj-a");
  const mcp = startMcp(makeProjectsRegistry("m9", [a]));
  try {
    await mcp.init();
    await mcp.list();
    await mcp.call("agent_link_list_projects", {});
    await mcp.call("agent_link_claim_next_task", {});
    // 错误路径也在 stdout 上（DS 评审第 4 点）：协议错误 / 校验错误 / 未知资源
    await mcp.call("no_such_tool", {});
    await mcp.call("agent_link_list_tasks", { project: "proj-a", phase: "HACKED" });   // -32602 校验拒绝
    await mcp.request("resources/read", { uri: "file:///etc/passwd" });                 // -32602
  } finally { mcp.close(); }
  assert.ok(mcp.rawLines.length >= 4, "应收到多条 stdout 消息");
  for (const line of mcp.rawLines) {
    let msg = null;
    try { msg = JSON.parse(line); } catch { assert.fail(`stdout 出现非 JSON 行: ${line.slice(0, 80)}`); }
    assert.equal(msg.jsonrpc, "2.0", `stdout 行缺少 jsonrpc 字段: ${line.slice(0, 80)}`);
  }
});

fs.rmSync(BASE, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`合计: ${results.length - failed.length}/${results.length} 通过` + (failed.length ? " (有失败)" : ""));
process.exit(failed.length ? 1 : 0);
