// 自注册 CLI 测试：生成配置、登记、幂等、dry-run、非法名、--force。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadProjectsRegistry } from "./local_service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "register_project.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "awl-register-"));
const results = [];
function record(name, fn) {
  try { fn(); results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

function mkProj(tag) {
  const root = path.join(BASE, tag);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  return root;
}

record("RG1 --help 输出用法且退出 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--name/);
});

record("RG2 生成配置并登记，可由 loadProjectsRegistry 加载", () => {
  const root = mkProj("p1");
  const registry = path.join(BASE, "p1", "projects.json");
  const r = run("--name", "proj-one", "--root", root, "--projects", registry);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const cfgPath = path.join(root, ".agent-link", "project.config.json");
  assert.ok(fs.existsSync(cfgPath), "应生成配置");
  const reg = JSON.parse(fs.readFileSync(registry, "utf8"));
  assert.equal(reg.projects.length, 1);
  assert.equal(reg.projects[0].name, "proj-one");
  const loaded = loadProjectsRegistry(registry);
  assert.equal(loaded.ok, true);
  assert.ok(loaded.projects.has("proj-one"));
  assert.equal(loaded.projectErrors["proj-one"], undefined);
});

record("RG3 幂等：同名同配置重复注册不报错", () => {
  const root = mkProj("p2");
  const registry = path.join(BASE, "p2", "projects.json");
  const a = run("--name", "proj-two", "--root", root, "--projects", registry);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  const b = run("--name", "proj-two", "--root", root, "--projects", registry);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /无需重复注册/);
  const reg = JSON.parse(fs.readFileSync(registry, "utf8"));
  assert.equal(reg.projects.length, 1);
});

record("RG4 同名不同配置：默认拒绝，--force 覆盖", () => {
  const rootA = mkProj("p3a");
  const rootB = mkProj("p3b");
  const registry = path.join(BASE, "p3", "projects.json");
  assert.equal(run("--name", "proj-three", "--root", rootA, "--projects", registry).status, 0);
  const conflict = run("--name", "proj-three", "--root", rootB, "--projects", registry);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /--force/);
  const forced = run("--name", "proj-three", "--root", rootB, "--projects", registry, "--force");
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  const loaded = loadProjectsRegistry(registry);
  assert.equal(path.resolve(loaded.projects.get("proj-three").config.projectRoot), path.resolve(rootB));
});

record("RG5 --dry-run 不写盘", () => {
  const root = mkProj("p4");
  const registry = path.join(BASE, "p4", "projects.json");
  const r = run("--name", "proj-four", "--root", root, "--projects", registry, "--dry-run");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /dry-run/);
  assert.equal(fs.existsSync(path.join(root, ".agent-link")), false, "不得创建配置目录");
  assert.equal(fs.existsSync(registry), false, "不得创建注册表");
});

record("RG6 非法项目名被拒绝", () => {
  const root = mkProj("p5");
  const r = run("--name", "bad/name", "--root", root, "--projects", path.join(BASE, "p5", "projects.json"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /项目名非法/);
});

record("RG7 --emit-report 生成脱敏报告（不含盘符路径）", () => {
  const root = mkProj("p6");
  const registry = path.join(BASE, "p6", "projects.json");
  const report = path.join(BASE, "p6", "review.txt");
  const r = run("--name", "proj-six", "--root", root, "--projects", registry, "--emit-report", report);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const txt = fs.readFileSync(report, "utf8");
  assert.match(txt, /项目自注册复核/);
  assert.ok(!/[A-Za-z]:[\\/]/.test(txt), "复核报告不得包含盘符绝对路径");
});

fs.rmSync(BASE, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n合计: ${results.length - failed.length}/${results.length} 通过${failed.length ? " (有失败)" : ""}`);
process.exit(failed.length ? 1 : 0);
