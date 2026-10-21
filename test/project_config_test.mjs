// C9-R19 跨项目复用测试：配置外置 + 双项目隔离 + 越权/注入拒绝 + 兼容性
// 隔离策略: 仅在系统临时目录创建两个互不相干的测试项目（A/B），不触碰任何真实业务项目数据。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateProjectConfig, loadActiveProjectConfig, loadProjectConfigSafe,
  defaultProjectConfig, failClosedConfig, CONFIG_ENV_VAR,
} from "./project_config.mjs";
import { makeExecutor } from "./agent_executor.mjs";
import { saveRegistry, loadRegistry, registerTask } from "./task_store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const results = [];
async function record(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-cfg-"));
const A = path.join(BASE, "proj-a");
const B = path.join(BASE, "proj-b");
for (const d of [A, B]) fs.mkdirSync(path.join(d, "work"), { recursive: true });

// A 的 runner：读取 drop 文件、在项目内产出真实回执文件（证明任务内容真的到达了被执行进程）
const RUNNER = `import fs from "node:fs";
import path from "node:path";
const tf = process.argv[2];
const task = JSON.parse(fs.readFileSync(tf, "utf8"));
const receipt = {
  taskId: task.taskId,
  summary: task.summary ?? null,
  argv: process.argv.slice(1),
  cwd: process.cwd(),
  sawRaw: typeof task.raw === "string",
};
fs.writeFileSync(path.join(path.dirname(tf), "receipt.json"), JSON.stringify(receipt, null, 2), "utf8");
console.log("RUNNER-OK:" + task.taskId);
`;
fs.writeFileSync(path.join(A, "runner.mjs"), RUNNER, "utf8");

const cfgA = {
  schemaVersion: 1,
  name: "proj-a",
  projectRoot: A,
  projectTests: [{ command: "node", args: ["work/t1.mjs"] }],
  agentCommand: { command: "node", args: ["runner.mjs", ".agent/task.json"], taskFile: ".agent/task.json" },
  paths: { stateDir: ".state", tasksDir: ".tasks" },
};
const cfgB = {
  schemaVersion: 1,
  name: "proj-b",
  projectRoot: B,
  projectTests: [{ command: "node", args: ["work/t2.mjs"] }],
  agentCommand: null,
  paths: { stateDir: ".state", tasksDir: ".tasks" },
};
const fileA = path.join(BASE, "proj-a.config.json");
const fileB = path.join(BASE, "proj-b.config.json");
fs.writeFileSync(fileA, JSON.stringify(cfgA, null, 2), "utf8");
fs.writeFileSync(fileB, JSON.stringify(cfgB, null, 2), "utf8");

// ---------- 配置解析与隔离 ----------
await record("C1 缺配置文件 → 回退默认（向后兼容，与 R18 行为一致）", async () => {
  const r = loadActiveProjectConfig({ file: path.join(BASE, "nope.json"), env: {}, fallbackRoot: REPO_ROOT });
  assert.ok(r.ok, `应 ok: ${JSON.stringify(r.errors)}`);
  assert.equal(r.source, "fallback");
  assert.equal(r.config.projectRoot, REPO_ROOT);
  assert.equal(r.config.agentCommand, null);
  assert.equal(r.config.projectTests.length, 2);
  assert.ok(r.config.stateDir.startsWith(REPO_ROOT), "stateDir 必须在项目根内");
});

await record("C2 两个项目各自解析成功且互不共享根/目录/命令", async () => {
  const ra = loadActiveProjectConfig({ file: fileA, env: {} });
  const rb = loadActiveProjectConfig({ file: fileB, env: {} });
  assert.ok(ra.ok && rb.ok, `应都合法: ${JSON.stringify([ra.errors, rb.errors])}`);
  assert.equal(ra.config.projectRoot, A);
  assert.equal(rb.config.projectRoot, B);
  assert.notEqual(ra.config.stateDir, rb.config.stateDir);
  assert.ok(!ra.config.stateDir.startsWith(rb.config.projectRoot), "A 的状态目录不得落在 B 内");
  assert.ok(!rb.config.stateDir.startsWith(ra.config.projectRoot), "B 的状态目录不得落在 A 内");
  assert.notEqual(ra.config.projectTests[0].args[0], rb.config.projectTests[0].args[0]);
  assert.ok(ra.config.agentCommand, "A 应配置 agentCommand");
  assert.equal(rb.config.agentCommand, null, "B 不应配置 agentCommand");
  assert.equal(ra.config.registryFile, path.join(A, ".tasks", "registry.json"));
});

await record("C3 env 变量指定配置路径（协调器无需改代码即可切换项目）", async () => {
  const r = loadActiveProjectConfig({ env: { [CONFIG_ENV_VAR]: fileB } });
  assert.ok(r.ok, `应 ok: ${JSON.stringify(r.errors)}`);
  assert.equal(r.config.projectRoot, B);
  assert.equal(r.source, "file");
});

// ---------- 越权 / 注入拒绝 ----------
await record("C4 projectRoot 非绝对路径 → 拒绝", async () => {
  const r = validateProjectConfig({ ...cfgA, projectRoot: "relative/dir" });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /绝对路径/.test(e)), `错误应说明绝对路径: ${r.errors}`);
});

await record("C5 projectRoot 不存在 → 拒绝", async () => {
  const r = validateProjectConfig({ ...cfgA, projectRoot: path.join(BASE, "no-such-dir") });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /不存在/.test(e)));
});

await record("C6 stateDir 越界 → 拒绝（防跨项目状态串扰）", async () => {
  const r = validateProjectConfig({ ...cfgA, paths: { stateDir: "../outside-state", tasksDir: ".tasks" } });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /stateDir 越界/.test(e)), `实际 ${r.errors}`);
});

await record("C7 tasksDir 绝对路径越界 → 拒绝", async () => {
  const r = validateProjectConfig({ ...cfgA, paths: { stateDir: ".state", tasksDir: path.join(BASE, "outside") } });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /tasksDir 越界/.test(e)), `实际 ${r.errors}`);
});

await record("C8 命令白名单：cmd/powershell 等 shell → 拒绝", async () => {
  for (const bad of ["cmd.exe", "powershell", "bash", "claude"]) {
    const r = validateProjectConfig({ ...cfgA, agentCommand: { ...cfgA.agentCommand, command: bad } });
    assert.ok(!r.ok, `${bad} 必须被拒绝`);
    assert.ok(r.errors.some((e) => /白名单/.test(e)), `${bad} 的错误应说明白名单: ${r.errors}`);
  }
});

await record("C9 命令白名单：项目根外的绝对路径 → 拒绝", async () => {
  const outside = path.join(BASE, "outside-node.exe");
  fs.writeFileSync(outside, "", "utf8");
  const r = validateProjectConfig({ ...cfgA, agentCommand: { ...cfgA.agentCommand, command: outside } });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /越界/.test(e)), `实际 ${r.errors}`);
});

await record("C10 agentCommand.taskFile 越界 → 拒绝（防止配置把文件写到项目外）", async () => {
  const r = validateProjectConfig({ ...cfgA, agentCommand: { ...cfgA.agentCommand, taskFile: "../../secret.json" } });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /taskFile 越界/.test(e)), `实际 ${r.errors}`);
});

await record("C11 projectTests args 非字符串数组 → 拒绝；相对路径命令 → 拒绝", async () => {
  const r1 = validateProjectConfig({ ...cfgA, projectTests: [{ command: "node", args: ["a", 1] }] });
  assert.ok(!r1.ok);
  assert.ok(r1.errors.some((e) => /字符串数组/.test(e)));
  const r2 = validateProjectConfig({ ...cfgA, projectTests: [{ command: "node test/x.mjs", args: [] }] });
  assert.ok(!r2.ok, "带参数的复合命令必须被拒绝（防止命令注入）");
  assert.ok(r2.errors.some((e) => /白名单|相对路径/.test(e)), `实际 ${r2.errors}`);
  const r3 = validateProjectConfig({ ...cfgA, projectTests: [{ command: "node", args: "not-array" }] });
  assert.ok(!r3.ok);
  assert.ok(r3.errors.some((e) => /字符串数组/.test(e)));
});

await record("C12 非法 JSON → 失败关闭（无测试命令、无 agent、无任何可执行能力）", async () => {
  const bad = path.join(BASE, "bad.config.json");
  fs.writeFileSync(bad, "{ not json", "utf8");
  const raw = loadActiveProjectConfig({ file: bad, env: {} });
  assert.ok(!raw.ok, "非法 JSON 必须 ok=false");
  const safe = loadProjectConfigSafe({ file: bad, env: {}, fallbackRoot: REPO_ROOT });
  assert.ok(!safe.ok);
  assert.equal(safe.config.projectTests.length, 0);
  assert.equal(safe.config.agentCommand, null);
  assert.ok(safe.errors.length > 0);
  const ex = makeExecutor(safe.config);
  assert.ok(!ex.validateAction({ op: "run_project_tests" }).ok, "失败关闭后不得执行测试");
  assert.ok(!ex.validateAction({ op: "agent_dispatch" }).ok, "失败关闭后不得派发 agent");
  assert.ok(!failClosedConfig(REPO_ROOT).agentCommand);
});

// ---------- 隔离 + 真实进程执行 ----------
await record("C13 登记簿隔离：A 的写入不产生 B 的任何文件", async () => {
  const ra = loadActiveProjectConfig({ file: fileA, env: {} }).config;
  const rb = loadActiveProjectConfig({ file: fileB, env: {} }).config;
  const reg = loadRegistry(ra.registryFile);
  assert.ok(Array.isArray(reg.tasks));
  registerTask(reg, { taskId: "tk-iso-a", assistantMsgId: "msg-a", type: "ASSISTANT_TASK", actions: [], summary: "iso" });
  saveRegistry(ra.registryFile, reg);
  assert.ok(fs.existsSync(ra.registryFile), "A 的登记簿应存在");
  assert.ok(!fs.existsSync(rb.registryFile), "B 的登记簿不得被创建");
  assert.ok(!fs.existsSync(rb.tasksDir), "B 的任务目录不得被创建");
  const rbReg = loadRegistry(rb.registryFile);
  assert.equal(rbReg.tasks.length, 0, "B 不得看到 A 的任务");
});

await record("C14 通过协调器同一执行路径真实派发：任务落盘 → 进程读取 → 产出回执", async () => {
  const ca = loadActiveProjectConfig({ file: fileA, env: {} }).config;
  const ex = makeExecutor(ca);
  const v = ex.validateAction({ op: "agent_dispatch" });
  assert.ok(v.ok, `A 应允许 agent_dispatch: ${v.reason}`);
  const taskContext = {
    taskId: "tk-real-a",
    summary: '注入试探: "; rm -rf / # $(whoami) `id`',
    raw: 'AGENT_TASK_BEGIN {"taskId":"tk-real-a"} AGENT_TASK_END',
  };
  const r = ex.executeActions([{ op: "agent_dispatch" }], { taskContext });
  assert.ok(r.ok, `执行应成功: ${JSON.stringify(r.results)}`);
  assert.equal(r.results[0].exitCode, 0);
  assert.ok(String(r.results[0].stdout).includes("RUNNER-OK:tk-real-a"), `stdout 应含回执: ${r.results[0].stdout}`);

  const receiptFile = path.join(A, ".agent", "receipt.json");
  assert.ok(fs.existsSync(receiptFile), "runner 必须在项目内产出真实回执文件");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.equal(receipt.taskId, "tk-real-a");
  assert.equal(receipt.sawRaw, true, "任务原文必须经 drop 文件到达执行进程");
  assert.ok(receipt.cwd.toLowerCase().startsWith(A.toLowerCase()), `cwd 应为项目 A: ${receipt.cwd}`);
  // 关键安全断言：脚本路径由 node 解析为绝对路径（属预期），其余参数与配置逐字一致；
  // 任务正文（含 shell 元字符）不得出现在任何命令行参数中。
  assert.equal(receipt.argv.length, 2, `参数个数必须与配置一致，实际 ${JSON.stringify(receipt.argv)}`);
  assert.ok(fs.realpathSync(receipt.argv[0]).toLowerCase() === fs.realpathSync(path.join(A, "runner.mjs")).toLowerCase(), `脚本路径应为项目内 runner，实际 ${receipt.argv[0]}`);
  assert.equal(receipt.argv[1], ".agent/task.json", `第二参数必须逐字来自配置，实际 ${receipt.argv[1]}`);
  assert.ok(!JSON.stringify(receipt.argv).includes("rm -rf"), "任务正文不得进入命令行");
  assert.ok(!JSON.stringify(receipt.argv).includes("whoami"), "任务正文不得进入命令行");
});

await record("C15 同一套代码按项目配置切换行为：A 允许派发 / B 拒绝派发", async () => {
  const ca = loadActiveProjectConfig({ file: fileA, env: {} }).config;
  const cb = loadActiveProjectConfig({ file: fileB, env: {} }).config;
  const exA = makeExecutor(ca);
  const exB = makeExecutor(cb);
  assert.ok(exA.validateAction({ op: "agent_dispatch" }).ok);
  const vb = exB.validateAction({ op: "agent_dispatch" });
  assert.ok(!vb.ok, "B 未配置 agentCommand，必须拒绝");
  assert.ok(/未配置 agent 命令/.test(vb.reason));
  assert.ok(exB.validateAction({ op: "run_project_tests" }).ok, "B 自己的测试命令仍可用");
});

// ---------- 与现有协调器兼容 ----------
await record("C16 现有协调器导入兼容：项目根/状态目录/登记簿仍指向本仓库", async () => {
  const mod = await import("./collab_once.mjs");
  assert.equal(mod.CONFIG_ERROR, null, `本仓库配置必须合法: ${mod.CONFIG_ERROR}`);
  assert.equal(mod.CONFIG_SOURCE, "file", "本仓库应读取 project.config.json");
  assert.equal(mod.PROJECT_CONFIG.projectRoot.toLowerCase(), REPO_ROOT.toLowerCase());
  assert.equal(mod.STATE_DIR.toLowerCase(), path.join(REPO_ROOT, "test", "state").toLowerCase());
  assert.equal(mod.REGISTRY_FILE.toLowerCase(), path.join(REPO_ROOT, "test", "tasks", "registry.json").toLowerCase());
  assert.equal(mod.OUTBOX_DIR.toLowerCase(), path.join(REPO_ROOT, "test", "tasks", "outbox").toLowerCase());
  assert.equal(mod.PROJECT_CONFIG.agentCommand, null, "真实 agent 未认证前必须保持禁用");
});

fs.rmSync(BASE, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`合计: ${results.length - failed.length}/${results.length} 通过` + (failed.length ? " (有失败)" : ""));
process.exit(failed.length ? 1 : 0);
