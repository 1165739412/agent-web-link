// C9-R20 本地服务测试：提交/状态/报告、顺序排队、去重、项目隔离、
// 非法路径与未配置 agent 拒绝、任务正文注入、重启恢复（不重试结果未知）、R13 状态契约、Python 客户端。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTaskService, createHttpServer, buildServiceReport } from "./local_service.mjs";
import { PHASES } from "./task_store.mjs";
import { loadRegistry, saveRegistry, registerTask, updatePhase } from "./task_store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-svc-"));
const results = [];
async function record(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

const RUNNER = `import fs from "node:fs";
import path from "node:path";
const tf = process.argv[2];
const task = JSON.parse(fs.readFileSync(tf, "utf8"));
fs.writeFileSync(path.join(path.dirname(tf), "receipt.json"),
  JSON.stringify({ taskId: task.taskId, argv: process.argv.slice(1), cwd: process.cwd() }, null, 2), "utf8");
console.log("RUNNER-OK:" + task.taskId);
`;

function makeProject(tag, name, { withAgent = false } = {}) {
  const root = path.join(BASE, tag, name);
  fs.mkdirSync(path.join(root, "work"), { recursive: true });
  fs.writeFileSync(path.join(root, "work", "ok.mjs"), "export const ok = 1;\n", "utf8");
  const cfg = {
    schemaVersion: 1,
    name,
    projectRoot: root,
    projectTests: [{ command: "node", args: ["work/ok.mjs"] }],
    agentCommand: null,
    paths: { stateDir: ".state", tasksDir: ".tasks" },
  };
  if (withAgent) {
    fs.writeFileSync(path.join(root, "runner.mjs"), RUNNER, "utf8");
    cfg.agentCommand = { command: "node", args: ["runner.mjs", ".agent/task.json"], taskFile: ".agent/task.json" };
  }
  const cfgPath = path.join(root, "project.config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  return { root, cfgPath, name, tasksDir: path.join(root, ".tasks") };
}

function makeProjectsRegistry(tag, projects) {
  const file = path.join(BASE, tag, "projects.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: projects.map((p) => ({ name: p.name, config: p.cfgPath })) }, null, 2), "utf8");
  return file;
}

async function startService({ projectsFile, worker = null }) {
  const tokenFile = path.join(path.dirname(projectsFile), "token.txt");
  const service = createTaskService({ projectsFile, tokenFile, worker, log: () => {} });
  service.start();
  const httpd = createHttpServer(service, { port: 0, log: () => {} });
  const { port } = await httpd.listen();
  return { service, httpd, baseUrl: `http://127.0.0.1:${port}`, token: service.token, close: () => httpd.close() };
}

async function api(baseUrl, token, method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// 异步子进程：不能用 spawnSync——它会阻塞事件循环，使同进程内的 HTTP 服务无法响应
function runChild(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: String(e.message) }); });
  });
}

async function submitAndWait(ctx, project, actions, summary, taskId) {
  const sub = await api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", { project, actions, summary, taskId });
  if (sub.status !== 202) return { sub };
  await ctx.service.awaitIdle(20000);
  const st = await api(ctx.baseUrl, ctx.token, "GET", `/v1/tasks/${encodeURIComponent(sub.json.taskId)}?project=${project}`);
  const rep = await api(ctx.baseUrl, ctx.token, "GET", `/v1/tasks/${encodeURIComponent(sub.json.taskId)}/report?project=${project}`);
  return { sub, st, rep };
}

// ---------- S1 访问控制 ----------
await record("S1 健康检查免令牌；无令牌/错令牌的写操作被拒绝(401)", async () => {
  const a = makeProject("s1", "proj-a", { withAgent: true });
  const ctx = await startService({ projectsFile: makeProjectsRegistry("s1", [a]) });
  try {
    const health = await api(ctx.baseUrl, null, "GET", "/v1/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    const noToken = await api(ctx.baseUrl, null, "POST", "/v1/tasks", { project: "proj-a", actions: [{ op: "node_check", target: "work/ok.mjs" }] });
    assert.equal(noToken.status, 401);
    const wrong = await api(ctx.baseUrl, "x".repeat(64), "POST", "/v1/tasks", { project: "proj-a", actions: [{ op: "node_check", target: "work/ok.mjs" }] });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, "UNAUTHORIZED");
  } finally { await ctx.close(); }
});

// ---------- S2 提交 / 状态 / 报告 ----------
await record("S2 外部提交获得 taskId，可查状态与报告（真实执行 node_check）", async () => {
  const a = makeProject("s2", "proj-a");
  const ctx = await startService({ projectsFile: makeProjectsRegistry("s2", [a]) });
  try {
    const { sub, st, rep } = await submitAndWait(ctx, "proj-a", [{ op: "node_check", target: "work/ok.mjs" }], "语法检查");
    assert.equal(sub.status, 202, JSON.stringify(sub.json));
    assert.ok(sub.json.taskId);
    assert.equal(sub.json.phase, PHASES.NEW);
    assert.equal(st.status, 200);
    assert.equal(st.json.task.phase, PHASES.REPORTED);
    assert.equal(st.json.task.reportAvailable, true);
    assert.equal(rep.status, 200);
    assert.equal(rep.json.report.status, "ACTIONS_DONE");
    assert.equal(rep.json.report.results[0].op, "node_check");
    assert.equal(rep.json.report.results[0].ok, true);
  } finally { await ctx.close(); }
});

// ---------- S3 报告未就绪 ----------
await record("S3 任务未完成时取报告 → 409 REPORT_NOT_READY（不返回假报告）", async () => {
  const a = makeProject("s3", "proj-a");
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = await startService({
    projectsFile: makeProjectsRegistry("s3", [a]),
    worker: async () => { await gate; return { ok: true, results: [{ action: { op: "node_check", target: "work/ok.mjs" }, ok: true, exitCode: 0 }] }; },
  });
  try {
    const sub = await api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", { project: "proj-a", actions: [{ op: "node_check", target: "work/ok.mjs" }], summary: "慢任务" });
    assert.equal(sub.status, 202);
    await new Promise((r) => setTimeout(r, 150));
    const rep = await api(ctx.baseUrl, ctx.token, "GET", `/v1/tasks/${sub.json.taskId}/report?project=proj-a`);
    assert.equal(rep.status, 409);
    assert.equal(rep.json.code, "REPORT_NOT_READY");
    const st = await api(ctx.baseUrl, ctx.token, "GET", `/v1/tasks/${sub.json.taskId}?project=proj-a`);
    assert.equal(st.json.task.phase, PHASES.RUNNING);
    assert.equal(st.json.task.running, true);
    release();
    await ctx.service.awaitIdle(10000);
    const rep2 = await api(ctx.baseUrl, ctx.token, "GET", `/v1/tasks/${sub.json.taskId}/report?project=proj-a`);
    assert.equal(rep2.status, 200);
  } finally { await ctx.close(); }
});

// ---------- S4 双项目隔离 ----------
await record("S4 两个隔离项目各用各的配置，状态与报告不串写", async () => {
  const a = makeProject("s4", "proj-a");
  const b = makeProject("s4", "proj-b");
  const ctx = await startService({ projectsFile: makeProjectsRegistry("s4", [a, b]) });
  try {
    const ra = await submitAndWait(ctx, "proj-a", [{ op: "node_check", target: "work/ok.mjs" }], "A 的任务", "iso-a-1");
    const rb = await submitAndWait(ctx, "proj-b", [{ op: "node_check", target: "work/ok.mjs" }], "B 的任务", "iso-b-1");
    assert.equal(ra.sub.status, 202);
    assert.equal(rb.sub.status, 202);
    assert.ok(fs.existsSync(path.join(a.tasksDir, "registry.json")));
    assert.ok(fs.existsSync(path.join(b.tasksDir, "registry.json")));
    const regA = loadRegistry(path.join(a.tasksDir, "registry.json"));
    const regB = loadRegistry(path.join(b.tasksDir, "registry.json"));
    assert.ok(regA.tasks.some((t) => t.taskId === "iso-a-1"));
    assert.ok(!regA.tasks.some((t) => t.taskId === "iso-b-1"), "A 不得看到 B 的任务");
    assert.ok(!regB.tasks.some((t) => t.taskId === "iso-a-1"), "B 不得看到 A 的任务");
    assert.ok(!fs.existsSync(path.join(b.tasksDir, "reports", "iso-a-1.json")), "B 不得写入 A 的报告");
    assert.ok(ra.rep.json.report.taskId === "iso-a-1" && ra.rep.json.report.project === "proj-a");
  } finally { await ctx.close(); }
});

// ---------- S5 非法请求拒绝 ----------
await record("S5 未注册项目/未知动作/越界路径/未配置 agent 一律拒绝", async () => {
  const a = makeProject("s5", "proj-a");
  const b = makeProject("s5", "proj-b");
  const ctx = await startService({ projectsFile: makeProjectsRegistry("s5", [a, b]) });
  try {
    const p404 = await api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", { project: "not-registered", actions: [{ op: "node_check", target: "work/ok.mjs" }] });
    assert.equal(p404.status, 404);
    assert.equal(p404.json.code, "UNKNOWN_PROJECT");

    const op400 = await api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", { project: "proj-a", actions: [{ op: "shell", target: "x" }] });
    assert.equal(op400.status, 400);
    assert.equal(op400.json.code, "OP_NOT_ALLOWED");

    const esc400 = await api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", { project: "proj-a", actions: [{ op: "node_check", target: "../../etc/passwd" }] });
    assert.equal(esc400.status, 400);
    assert.equal(esc400.json.code, "ACTION_REJECTED");

    const agent400 = await api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", { project: "proj-b", actions: [{ op: "agent_dispatch" }] });
    assert.equal(agent400.status, 400);
    assert.equal(agent400.json.code, "AGENT_NOT_CONFIGURED");

    const id400 = await api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", { project: "proj-a", taskId: "bad id!", actions: [{ op: "node_check", target: "work/ok.mjs" }] });
    assert.equal(id400.status, 400);
    assert.equal(id400.json.code, "INVALID_TASK_ID");
  } finally { await ctx.close(); }
});

// ---------- S6 并发提交顺序排队 ----------
await record("S6 并发请求按提交顺序串行执行，同一时刻只有一个任务在跑", async () => {
  const a = makeProject("s6", "proj-a");
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const ctx = await startService({
    projectsFile: makeProjectsRegistry("s6", [a]),
    worker: async (job) => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(job.taskId);
      await new Promise((r) => setTimeout(r, 60));
      concurrent--;
      return { ok: true, results: [{ action: { op: "node_check", target: "work/ok.mjs" }, ok: true, exitCode: 0 }] };
    },
  });
  try {
    const ids = ["q1", "q2", "q3", "q4", "q5"];
    const settled = await Promise.all(ids.map((id) => api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", {
      project: "proj-a", taskId: id, summary: id, actions: [{ op: "node_check", target: "work/ok.mjs" }],
    })));
    assert.ok(settled.every((s) => s.status === 202), JSON.stringify(settled.map((s) => s.status)));
    await ctx.service.awaitIdle(20000);
    assert.equal(maxConcurrent, 1, `并发度必须为 1，实际 ${maxConcurrent}`);
    assert.deepEqual(order, ids, `执行顺序必须与提交顺序一致，实际 ${order}`);
    for (const id of ids) {
      const st = await api(ctx.baseUrl, ctx.token, "GET", `/v1/tasks/${id}?project=proj-a`);
      assert.equal(st.json.task.phase, PHASES.REPORTED);
    }
  } finally { await ctx.close(); }
});

// ---------- S7 去重 ----------
await record("S7 相同 taskId 重复提交 → 409，且登记簿只有一条", async () => {
  const a = makeProject("s7", "proj-a");
  const ctx = await startService({ projectsFile: makeProjectsRegistry("s7", [a]) });
  try {
    const first = await api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", { project: "proj-a", taskId: "dup-1", actions: [{ op: "node_check", target: "work/ok.mjs" }] });
    assert.equal(first.status, 202);
    const second = await api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", { project: "proj-a", taskId: "dup-1", actions: [{ op: "node_check", target: "work/ok.mjs" }] });
    assert.equal(second.status, 409);
    assert.equal(second.json.code, "DUPLICATE_TASK");
    await ctx.service.awaitIdle(10000);
    const reg = loadRegistry(path.join(a.tasksDir, "registry.json"));
    assert.equal(reg.tasks.filter((t) => t.taskId === "dup-1").length, 1);
  } finally { await ctx.close(); }
});

// ---------- S8 任务正文注入 ----------
await record("S8 任务正文含 shell 元字符不进入命令行，只经 drop 文件传递", async () => {
  const a = makeProject("s8", "proj-a", { withAgent: true });
  const ctx = await startService({ projectsFile: makeProjectsRegistry("s8", [a]) });
  try {
    const summary = '注入: "; rm -rf / # $(whoami) `id` | echo pwned';
    const { sub, st, rep } = await submitAndWait(ctx, "proj-a", [{ op: "agent_dispatch" }], summary, "inj-1");
    assert.equal(sub.status, 202, JSON.stringify(sub.json));
    assert.equal(st.json.task.phase, PHASES.REPORTED);
    assert.equal(rep.json.report.status, "ACTIONS_DONE");
    const receipt = JSON.parse(fs.readFileSync(path.join(a.root, ".agent", "receipt.json"), "utf8"));
    assert.equal(receipt.taskId, "inj-1");
    assert.equal(receipt.argv.length, 2, `argv 必须与配置一致，实际 ${JSON.stringify(receipt.argv)}`);
    assert.equal(receipt.argv[1], ".agent/task.json");
    assert.ok(!JSON.stringify(receipt.argv).includes("rm -rf"), "任务正文不得进入 argv");
    assert.ok(!JSON.stringify(receipt.argv).includes("whoami"), "任务正文不得进入 argv");
    assert.ok(receipt.cwd.toLowerCase().startsWith(a.root.toLowerCase()));
  } finally { await ctx.close(); }
});

// ---------- S9 重启恢复：RUNNING → REPORT_UNKNOWN，不重试 ----------
await record("S9 服务重启时残留 RUNNING → REPORT_UNKNOWN，且不自动重新执行", async () => {
  const a = makeProject("s9", "proj-a");
  const regFile = path.join(a.tasksDir, "registry.json");
  const reg = loadRegistry(regFile);
  registerTask(reg, { taskId: "crash-1", assistantMsgId: "api:crash-1", type: "ASSISTANT_TASK", actions: [{ op: "node_check", target: "work/ok.mjs" }], summary: "崩溃前执行中" });
  reg.tasks[0].source = "api";
  updatePhase(reg, "crash-1", PHASES.RUNNING);
  saveRegistry(regFile, reg);

  let executed = 0;
  const ctx = await startService({
    projectsFile: makeProjectsRegistry("s9", [a]),
    worker: async () => { executed++; return { ok: true, results: [] }; },
  });
  try {
    const st = await api(ctx.baseUrl, ctx.token, "GET", "/v1/tasks/crash-1?project=proj-a");
    assert.equal(st.json.task.phase, PHASES.REPORT_UNKNOWN);
    assert.equal(executed, 0, "结果未知的任务不得自动重试");
    assert.equal(ctx.service.queueDepth(), 0);
    assert.ok(ctx.service.recovered.some((r) => r.taskId === "crash-1" && r.to === PHASES.REPORT_UNKNOWN));
  } finally { await ctx.close(); }
});

// ---------- S10 执行异常 → UNKNOWN，不重试 ----------
await record("S10 执行过程异常 → REPORT_UNKNOWN，报告标 UNKNOWN，且只执行一次", async () => {
  const a = makeProject("s10", "proj-a");
  let calls = 0;
  const ctx = await startService({
    projectsFile: makeProjectsRegistry("s10", [a]),
    worker: async () => { calls++; throw new Error("模拟执行崩溃"); },
  });
  try {
    const sub = await api(ctx.baseUrl, ctx.token, "POST", "/v1/tasks", { project: "proj-a", taskId: "boom-1", actions: [{ op: "node_check", target: "work/ok.mjs" }] });
    assert.equal(sub.status, 202);
    await ctx.service.awaitIdle(10000);
    const st = await api(ctx.baseUrl, ctx.token, "GET", "/v1/tasks/boom-1?project=proj-a");
    assert.equal(st.json.task.phase, PHASES.REPORT_UNKNOWN);
    const rep = await api(ctx.baseUrl, ctx.token, "GET", "/v1/tasks/boom-1/report?project=proj-a");
    assert.equal(rep.json.report.status, "UNKNOWN");
    assert.equal(rep.json.report.goalAchieved, false);
    assert.equal(calls, 1, "不得自动重试");
  } finally { await ctx.close(); }
});

// ---------- S11 R13 契约 ----------
await record("S11 R13 契约：报告永不产出 DONE/taskComplete，失败任务标 FAILED", async () => {
  const a = makeProject("s11", "proj-a");
  fs.writeFileSync(path.join(a.root, "work", "broken.mjs"), "const = ;\n", "utf8");
  const ctx = await startService({ projectsFile: makeProjectsRegistry("s11", [a]) });
  try {
    const { st, rep } = await submitAndWait(ctx, "proj-a", [{ op: "node_check", target: "work/broken.mjs" }], "语法错误文件", "fail-1");
    assert.equal(st.json.task.phase, PHASES.FAILED);
    assert.equal(rep.json.report.status, "FAILED");
    assert.equal(rep.json.report.goalAchieved, false);
    assert.equal(rep.json.report.taskComplete, false);

    const okRun = await submitAndWait(ctx, "proj-a", [{ op: "node_check", target: "work/ok.mjs" }], "正常文件", "ok-1");
    assert.equal(okRun.rep.json.report.status, "ACTIONS_DONE");
    assert.equal(okRun.rep.json.report.taskComplete, false);
    assert.equal(okRun.rep.json.report.goalAchieved, false);
    assert.notEqual(okRun.rep.json.report.status, "DONE");

    // 直接构造 BLOCKED 语义
    const blockedReport = buildServiceReport({
      job: { taskId: "b-1", project: "proj-a", summary: "" },
      ex: { ok: false, results: [{ action: { op: "agent_dispatch" }, ok: false, blocked: true, reason: "未配置" }] },
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", reportToken: "t",
    });
    assert.equal(blockedReport.status, "BLOCKED");
    assert.equal(blockedReport.taskComplete, false);
  } finally { await ctx.close(); }
});

// ---------- S12 Python 客户端跨语言 ----------
await record("S12 Python 客户端可提交任务、查状态、取报告（跨语言复用）", async () => {
  const a = makeProject("s12", "proj-a");
  const ctx = await startService({ projectsFile: makeProjectsRegistry("s12", [a]) });
  try {
    const client = path.join(__dirname, "clients", "agent_link_client.py");
    const tokenFile = path.join(BASE, "s12", "token.txt");
    const r = await runChild("python", [client, "--base-url", ctx.baseUrl, "--token-file", tokenFile, "node-check",
      "--project", "proj-a", "--target", "work/ok.mjs", "--summary", "python 客户端冒烟"]);
    assert.equal(r.status, 0, `python 客户端失败: ${r.stderr || r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status.task.phase, PHASES.REPORTED);
    assert.equal(out.report.report.status, "ACTIONS_DONE");
    assert.equal(out.report.report.taskComplete, false);
  } finally { await ctx.close(); }
});

// ---------- S13 队列模式（C9-R24）：只登记不执行，供外部循环接管 ----------
await record("S13 queue-only：提交后保持 NEW，本地 Worker 不执行", async () => {
  const a = makeProject("s13", "proj-a");
  fs.writeFileSync(path.join(a.root, "work", "ok.mjs"), "export const ok = 1;\n", "utf8");
  let workerCalls = 0;
  const svc = createTaskService({
    projectsFile: makeProjectsRegistry("s13", [a]),
    tokenFile: path.join(BASE, "s13", "token.txt"),
    worker: async () => { workerCalls++; return { ok: true, results: [] }; },
    autoExecute: false,
    log: () => {},
  });
  svc.start();
  const sub = svc.submit({ project: "proj-a", taskId: "q1", summary: "交给循环执行", actions: [{ op: "node_check", target: "work/ok.mjs" }] });
  assert.equal(sub.ok, true, JSON.stringify(sub));
  assert.equal(sub.execution, "worker");
  await svc.awaitIdle(3000);
  assert.equal(workerCalls, 0, "queue-only 不得自行执行");
  const st = svc.status({ project: "proj-a", taskId: "q1" });
  assert.equal(st.task.phase, PHASES.NEW, "应保持 NEW 等待外部执行器");
});

// LS-BIG 报告大小上限（DS 评审：resources/read 天然保护 + stdio 不被超大读阻塞）
await record("LS-BIG 报告 >1MB → 413 REPORT_TOO_LARGE", async () => {
  const a = makeProject("lsbig", "proj-a");
  const svc = createTaskService({
    projectsFile: makeProjectsRegistry("lsbig", [a]), tokenFile: path.join(BASE, "lsbig", "token.txt"),
    worker: async () => ({ ok: true, results: [] }), log: () => {},
  });
  svc.start();
  const sub = svc.submit({ project: "proj-a", summary: "big report", mode: "agent" });
  assert.equal(sub.ok, true, JSON.stringify(sub));
  const regFile = path.join(a.tasksDir, "registry.json");
  const bigFile = path.join(a.tasksDir, "reports", "big.json");
  fs.mkdirSync(path.dirname(bigFile), { recursive: true });
  fs.writeFileSync(bigFile, JSON.stringify({ pad: "x".repeat(1_100_000) }), "utf8");
  const reg = loadRegistry(regFile);
  updatePhase(reg, sub.taskId, PHASES.REPORTED, { reportFile: bigFile });
  saveRegistry(regFile, reg);
  const r = svc.report({ project: "proj-a", taskId: sub.taskId });
  assert.equal(r.ok, false);
  assert.equal(r.code, "REPORT_TOO_LARGE");
});

// LS-CFG 配置错误可诊断且脱敏（反馈：configErrorCount 无详情）
await record("LS-CFG listProjects 返回脱敏的 configErrors（不回显绝对路径）", async () => {
  const good = makeProject("lscfg", "proj-a");
  const badCfgPath = path.join(BASE, "lscfg", "missing", "nope.config.json");
  const file = path.join(BASE, "lscfg", "projects.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: [
    { name: "proj-a", config: good.cfgPath },
    { name: "bad-proj", config: badCfgPath },
  ] }, null, 2), "utf8");
  const svc = createTaskService({ projectsFile: file, tokenFile: path.join(BASE, "lscfg", "token.txt"), worker: async () => ({ ok: true, results: [] }), log: () => {} });
  const lp = svc.listProjects();
  assert.equal(lp.configErrorCount, 1);
  assert.equal(lp.configErrors.length, 1);
  assert.equal(lp.configErrors[0].project, "bad-proj");
  assert.ok(lp.configErrors[0].code, "应给出结构化错误码");
  assert.equal(lp.configErrors[0].message, undefined, "不得回传原始 message");
  assert.ok(!/[A-Za-z]:[\\/]/.test(JSON.stringify(lp.configErrors)), "不得回显盘符绝对路径");
});

fs.rmSync(BASE, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`合计: ${results.length - failed.length}/${results.length} 通过` + (failed.length ? " (有失败)" : ""));
process.exit(failed.length ? 1 : 0);
