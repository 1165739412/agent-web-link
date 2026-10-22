// C9 多项目路由测试：项目身份/任务归属/实际执行目录一致性 + 多项目隔离 + 配置重载 + MCP 新进程加载
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTaskService, loadProjectsRegistry, DEFAULT_PROJECTS_FILE, DEFAULT_TOKEN_FILE } from "./local_service.mjs";
import { PHASES, loadRegistry, saveRegistry, registerTask } from "./task_store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-route-"));

const results = [];
const skips = [];
let passed = 0;

// 真实注册表（test/projects.json + 目标项目根）仅在本地存在时启用；开源默认环境跳过这些用例，
// 避免默认测试依赖私有配置/外部项目（新克隆不应失败）。
function realRegistryAvailable() {
  try {
    if (!fs.existsSync(DEFAULT_PROJECTS_FILE)) return false;
    const r = loadProjectsRegistry(DEFAULT_PROJECTS_FILE);
    return r.ok && r.projects.has("agent-link") && r.projects.has("qwen-bench");
  } catch { return false; }
}
const REAL = realRegistryAvailable();
async function record(name, fn) {
  try { await fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

function makeProject(tag, name, opts = {}) {
  const root = path.join(BASE, tag, name);
  fs.mkdirSync(path.join(root, "work"), { recursive: true });
  fs.writeFileSync(path.join(root, "work", "ok.mjs"), "export const ok = 1;\n", "utf8");
  const cfg = {
    schemaVersion: 1,
    name,
    projectRoot: opts.projectRoot || root,
    projectTests: [],
    agentCommand: null,
    paths: { stateDir: ".state", tasksDir: ".tasks" },
  };
  const cfgPath = path.join(root, "project.config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  return { name, root, cfgPath, tasksDir: path.join(root, ".tasks") };
}
function makeRegistry(tag, projects) {
  const file = path.join(BASE, tag, "projects.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: projects.map((p) => ({ name: p.name, config: p.cfgPath })) }, null, 2), "utf8");
  return file;
}
function newService(projectsFile) {
  const tokenFile = path.join(path.dirname(projectsFile), "token.txt");
  return createTaskService({ projectsFile, tokenFile, log: () => {} });
}
function regOf(p) { return loadRegistry(path.join(p.tasksDir, "registry.json")); }

// M1 真实注册表：agent-link + qwen-bench 均加载，根目录存在且执行器根一致
if (REAL) {
await record("M1 真实注册表加载 agent-link + qwen-bench（路径真实、执行器根一致）", () => {
  const r = loadProjectsRegistry(DEFAULT_PROJECTS_FILE);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.projects.has("agent-link"));
  assert.ok(r.projects.has("qwen-bench"), "qwen-bench 未注册");
  const p = r.projects.get("qwen-bench");
  assert.ok(fs.existsSync(p.config.projectRoot), "qwen-bench 根目录不存在: " + p.config.projectRoot);
  assert.equal(path.resolve(p.executor.root), path.resolve(p.config.projectRoot));
  const svc = createTaskService({ projectsFile: DEFAULT_PROJECTS_FILE, tokenFile: DEFAULT_TOKEN_FILE, log: () => {} });
  assert.deepEqual([...svc.projects].sort(), ["agent-link", "qwen-bench"]);
  assert.deepEqual(svc.projectErrors, {});
});
} else { skips.push("SKIPPED M1 真实注册表（未提供 test/projects.json 或 qwen-bench 根目录）"); }

// M2 两项目分别创建/认领/提交报告（agent 模式，任务归属 project 显式记录）
await record("M2 两项目分别创建/认领/提交报告，project 归属与报告隔离", async () => {
  const a = makeProject("m2", "proj-a");
  const b = makeProject("m2", "proj-b");
  const svc = newService(makeRegistry("m2", [a, b]));
  const sa = svc.submit({ project: "proj-a", taskId: "a-1", summary: "A 任务", mode: "agent" });
  const sb = svc.submit({ project: "proj-b", taskId: "b-1", summary: "B 任务", mode: "agent" });
  assert.equal(sa.ok, true, JSON.stringify(sa));
  assert.equal(sb.ok, true, JSON.stringify(sb));
  assert.equal(sa.execution, "agent");
  const ca = svc.claimNext({ project: "proj-a", claimedBy: "test" });
  const cb = svc.claimNext({ project: "proj-b", claimedBy: "test" });
  assert.equal(ca.task.taskId, "a-1");
  assert.equal(ca.task.project, "proj-a");
  assert.equal(cb.task.taskId, "b-1");
  assert.equal(cb.task.project, "proj-b");
  const ra = svc.submitResult({ project: "proj-a", taskId: "a-1", ok: true, evidence: { route: "A" } });
  const rb = svc.submitResult({ project: "proj-b", taskId: "b-1", ok: true, evidence: { route: "B" } });
  assert.equal(ra.phase, PHASES.REPORTED);
  assert.equal(rb.phase, PHASES.REPORTED);
  assert.equal(ra.report.project, "proj-a");
  assert.equal(rb.report.project, "proj-b");
  // 报告文件隔离
  assert.ok(fs.existsSync(path.join(a.tasksDir, "reports", "a-1.json")));
  assert.ok(fs.existsSync(path.join(b.tasksDir, "reports", "b-1.json")));
  assert.ok(!fs.existsSync(path.join(b.tasksDir, "reports", "a-1.json")));
  // 登记簿记录 project 字段
  assert.equal(regOf(a).tasks.find((t) => t.taskId === "a-1").project, "proj-a");
  assert.equal(regOf(b).tasks.find((t) => t.taskId === "b-1").project, "proj-b");
  assert.ok(!regOf(a).tasks.some((t) => t.taskId === "b-1"));
  assert.ok(!regOf(b).tasks.some((t) => t.taskId === "a-1"));
});

// M3 A 的任务不会被 B 认领
await record("M3 项目 A 的任务不会被项目 B 错误认领", async () => {
  const a = makeProject("m3", "proj-a");
  const b = makeProject("m3", "proj-b");
  const svc = newService(makeRegistry("m3", [a, b]));
  svc.submit({ project: "proj-a", taskId: "only-a", summary: "仅 A", mode: "agent" });
  const cb = svc.claimNext({ project: "proj-b", claimedBy: "test" });
  assert.equal(cb.task, null, "B 不得认领 A 的任务");
  const ca = svc.claimNext({ project: "proj-a", claimedBy: "test" });
  assert.equal(ca.task.taskId, "only-a");
  assert.equal(ca.task.project, "proj-a");
});

// M4 未注册项目明确拒绝（且不静默回退）
await record("M4 未注册项目提交/领取/回报均明确拒绝，不回退到其他项目", async () => {
  const a = makeProject("m4", "proj-a");
  const svc = newService(makeRegistry("m4", [a]));
  svc.submit({ project: "proj-a", taskId: "a-new", summary: "A", mode: "agent" });
  const s = svc.submit({ project: "no-such", taskId: "x", summary: "x", mode: "agent" });
  assert.equal(s.httpStatus, 404); assert.equal(s.code, "UNKNOWN_PROJECT");
  const c = svc.claimNext({ project: "no-such" });
  assert.equal(c.httpStatus, 404); assert.equal(c.code, "UNKNOWN_PROJECT");
  assert.equal(c.task, undefined, "未注册项目不得返回任何任务（无回退）");
  const r = svc.submitResult({ project: "no-such", taskId: "a-new", ok: true, evidence: "x" });
  assert.equal(r.httpStatus, 404); assert.equal(r.code, "UNKNOWN_PROJECT");
});

// M5 路由不匹配：登记簿内任务归属与项目不一致 → 明确失败
await record("M5 任务归属与项目不一致 → PROJECT_ROUTE_MISMATCH", async () => {
  const a = makeProject("m5", "proj-a");
  const svc = newService(makeRegistry("m5", [a]));
  svc.submit({ project: "proj-a", taskId: "mis-1", summary: "错归属", mode: "agent" });
  const regFile = path.join(a.tasksDir, "registry.json");
  const reg = loadRegistry(regFile);
  reg.tasks.find((t) => t.taskId === "mis-1").project = "proj-b";
  saveRegistry(regFile, reg);
  const c = svc.claimNext({ project: "proj-a" });
  assert.equal(c.httpStatus, 500);
  assert.equal(c.code, "PROJECT_ROUTE_MISMATCH");
  const r = svc.submitResult({ project: "proj-a", taskId: "mis-1", ok: true, evidence: "x" });
  assert.equal(r.httpStatus, 409);
  assert.equal(r.code, "PROJECT_ROUTE_MISMATCH");
});

// M6 配置更新后新实例加载（模拟 MCP 重启）；旧实例不热更新
await record("M6 配置更新后新进程加载新项目；旧实例不热更新（需重启 MCP）", async () => {
  const a = makeProject("m6", "proj-a");
  const b = makeProject("m6", "proj-b");
  const regFile = makeRegistry("m6", [a]);
  const svc1 = newService(regFile);
  assert.deepEqual([...svc1.projects], ["proj-a"]);
  // 追加 proj-b 到注册表（模拟更新配置）
  makeRegistry("m6", [a, b]);
  assert.deepEqual([...svc1.projects], ["proj-a"], "旧实例不得热更新");
  const svc2 = newService(regFile);
  assert.deepEqual([...svc2.projects].sort(), ["proj-a", "proj-b"], "新实例应加载新配置");
});

// M7 新 MCP 进程是否正确加载配置（用临时注册表，避免触达真实队列）
await record("M7 新 MCP 进程加载配置：已注册项目 TASK_NOT_FOUND，未注册 UNKNOWN_PROJECT", async () => {
  const a = makeProject("m7", "proj-a");
  const b = makeProject("m7", "proj-b");
  const regFile = makeRegistry("m7", [a, b]);
  const tokenFile = path.join(BASE, "m7", "mcp-token.txt");
  const child = spawn(process.execPath, [path.join(ROOT, "test", "mcp_server.mjs"), "--projects", regFile, "--token-file", tokenFile], { cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", () => {});
  const reqs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_link_get_task", arguments: { project: "proj-b", taskId: "nope" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "agent_link_get_task", arguments: { project: "not-registered", taskId: "nope" } } },
  ];
  for (const r of reqs) child.stdin.write(JSON.stringify(r) + "\n");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (out.includes('"id":4')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  try { child.kill(); } catch {}
  const lines = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const r3 = lines.find((l) => l.id === 3);
  const r4 = lines.find((l) => l.id === 4);
  assert.ok(r3, "缺少 id=3 响应");
  assert.ok(r4, "缺少 id=4 响应");
  const t3 = JSON.stringify(r3);
  const t4 = JSON.stringify(r4);
  assert.ok(t3.includes("TASK_NOT_FOUND"), "已注册项目应返回 TASK_NOT_FOUND: " + t3);
  assert.ok(!t3.includes("UNKNOWN_PROJECT"), "已注册项目不应报 UNKNOWN_PROJECT");
  assert.ok(t4.includes("UNKNOWN_PROJECT"), "未注册项目应报 UNKNOWN_PROJECT: " + t4);
});

// M8 真实 qwen-bench 路由（仅写 .agent-link 状态，不触碰业务代码/模型/权限）
if (REAL) {
await record("M8 真实 qwen-bench：注册→认领→提交报告，归属与目录隔离，agent-link 不受影响", async () => {
  const svc = createTaskService({ projectsFile: DEFAULT_PROJECTS_FILE, tokenFile: DEFAULT_TOKEN_FILE, log: () => {} });
  const taskId = "route-qb-" + Date.now().toString(36);
  const s = svc.submit({ project: "qwen-bench", taskId, summary: "多项目路由验证（真实 qwen-bench）", mode: "agent" });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.execution, "agent");
  const c = svc.claimNext({ project: "qwen-bench", claimedBy: "route-test" });
  assert.equal(c.task.taskId, taskId);
  assert.equal(c.task.project, "qwen-bench");
  const r = svc.submitResult({ project: "qwen-bench", taskId, ok: true, evidence: { route: "qwen-bench", at: new Date().toISOString() } });
  assert.equal(r.phase, PHASES.REPORTED);
  assert.equal(r.report.project, "qwen-bench");
  const cfg = svc.projectConfig("qwen-bench");
  assert.ok(r.report && fs.existsSync(path.join(cfg.tasksDir, "reports", `${taskId}.json`)), "报告应写入 qwen-bench 自己的 tasksDir");
  // agent-link 登记簿不得出现该任务
  const regAgent = loadRegistry(path.join(svc.projectConfig("agent-link").tasksDir, "registry.json"));
  assert.ok(!regAgent.tasks.some((t) => t.taskId === taskId), "qwen-bench 任务不得出现在 agent-link 登记簿");
  // qwen-bench 登记簿记录 project
  const regQb = loadRegistry(path.join(cfg.tasksDir, "registry.json"));
  const tq = regQb.tasks.find((t) => t.taskId === taskId);
  assert.ok(tq, "qwen-bench 登记簿应含该任务");
  assert.equal(tq.project, "qwen-bench");
});
} else { skips.push("SKIPPED M8 真实 qwen-bench 路由（未提供真实项目）"); }

fs.rmSync(BASE, { recursive: true, force: true });
if (skips.length) console.log(skips.join("\n"));
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n合计: ${results.length - failed.length}/${results.length} 通过${failed.length ? " (有失败)" : ""}`);
process.exit(failed.length ? 1 : 0);
