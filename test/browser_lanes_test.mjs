// lane（浏览器通道）注册表单测：默认 lane 硬编码、新 lane 独立分配、多进程并发不撞端口、
// project 派生 lane、PID 归属与释放、符号链接逃逸防护。不触浏览器、不联网，全部用临时目录。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  resolveLane, listLanes, normalizeLaneId, laneIdFromProject, cdpHostOf,
  markBrowserPid, releaseLane, laneBrowserAlive,
  MAX_LANES, PORT_BASE, PORT_ALLOC_START, LANES_FILE,
} from "./browser_lanes.mjs";

const results = [];
let passed = 0;
function record(name, fn) {
  try { fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}
function recordAsync(name, fn) {
  return fn().then(() => { passed++; results.push(`PASS ${name}`); })
    .catch((e) => { results.push(`FAIL ${name} :: ${e.message}`); });
}

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-lanes-"));
const OPTS = { baseDir: BASE, file: path.join(BASE, "state", "browser_lanes.json") };

record("L1 默认 lane 硬编码（9222/browser-profile/state）且幂等", () => {
  const d = resolveLane(undefined, OPTS);
  assert.equal(d.ok, true);
  assert.equal(d.lane, "default");
  assert.equal(d.builtin, true, "default 应为内置通道");
  assert.equal(d.port, PORT_BASE);
  assert.equal(d.port, 9222);
  assert.equal(d.profile, path.join(BASE, "browser-profile"));
  assert.equal(d.stateDir, path.join(BASE, "state"));
  const d2 = resolveLane("default", OPTS);
  assert.equal(d2.created, false);
  assert.equal(d2.port, d.port);
});

record("L2 default 永不写入注册表文件（零影响承诺不可能被改坏）", () => {
  resolveLane("proj-a", OPTS); // 触发一次写盘
  const raw = JSON.parse(fs.readFileSync(OPTS.file, "utf8"));
  assert.equal(raw.default, undefined, "注册表不得包含 default 条目");
  assert.ok(raw["proj-a"], "应包含 proj-a");
});

record("L3 新 lane 自动分配独立端口/profile/stateDir，大小写归一、幂等", () => {
  const o = { baseDir: BASE, file: path.join(BASE, "state4", "browser_lanes.json") };
  const a = resolveLane("alloc-x", o);
  assert.equal(a.ok, true);
  assert.equal(a.created, true);
  assert.equal(a.port, PORT_ALLOC_START, "全新注册表的首个 lane 应从 9223 起");
  assert.equal(a.profile, path.join(BASE, "browser-profile-alloc-x"));
  assert.equal(a.stateDir, path.join(BASE, "state-alloc-x"));
  const a2 = resolveLane("ALLOC-X", o);
  assert.equal(a2.lane, "alloc-x");
  assert.equal(a2.port, a.port);
  assert.equal(a2.created, false);
  // 第二个 lane 必须顺延，不复用
  const b = resolveLane("alloc-y", o);
  assert.equal(b.port, PORT_ALLOC_START + 1);
});

record("L4 不同 lane 的端口/profile/stateDir 两两不同（真隔离）", () => {
  const a = resolveLane("alloc-x", OPTS);
  const b = resolveLane("alloc-y", OPTS);
  assert.notEqual(a.port, b.port);
  assert.notEqual(a.profile, b.profile);
  assert.notEqual(a.stateDir, b.stateDir);
});

record("L5 非法 lane ID 一律拒绝（路径穿越/分隔符/超长/非法首字符）", () => {
  const bad = ["../evil", "..", ".", "a/b", "a\\b", "a b", "-x", "_x", "x".repeat(33), "a.b", "UPPER!", "a:b"];
  for (const v of bad) {
    assert.equal(normalizeLaneId(v), null, `normalizeLaneId 应拒绝 ${JSON.stringify(v)}`);
    const r = resolveLane(v, OPTS);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "INVALID_LANE");
  }
  for (const v of [undefined, null, ""]) {
    assert.equal(normalizeLaneId(v), "default");
    assert.equal(resolveLane(v, OPTS).lane, "default");
  }
});

record("L6 lane 派生路径全部限制在 baseDir 内（无逃逸）", () => {
  for (const id of ["proj-a", "proj-b", "x1"]) {
    const r = resolveLane(id, OPTS);
    assert.ok(r.profile.startsWith(BASE + path.sep), `profile 逃逸: ${r.profile}`);
    assert.ok(r.stateDir.startsWith(BASE + path.sep), `stateDir 逃逸: ${r.stateDir}`);
  }
});

record("L7 project 派生 lane：无损直接用、有损追加哈希、稳定不碰撞", () => {
  assert.equal(laneIdFromProject("My-Proj"), "my-proj", "仅大小写差异应无损归一");
  assert.equal(laneIdFromProject("my-proj"), "my-proj");
  assert.match(laneIdFromProject("my proj!"), /^my-proj-[0-9a-f]{8}$/, "有损规范化必须追加哈希");
  assert.match(laneIdFromProject("项目名/../../etc"), /^etc-[0-9a-f]{8}$/, "含非法字符必须追加哈希（否则 'etc' 会与别的项目碰撞）");
  assert.notEqual(laneIdFromProject("项目名/../../etc"), laneIdFromProject("etc"), "不同项目名不得碰撞");
  assert.equal(laneIdFromProject("a".repeat(50)), laneIdFromProject("a".repeat(50)), "超长项目名必须稳定");
  assert.notEqual(laneIdFromProject("a".repeat(50)), laneIdFromProject("b".repeat(50)));
  assert.equal(laneIdFromProject(""), "default");
  assert.equal(laneIdFromProject(null), "default");
  // 派生出的 lane 必须能直接使用
  const r = resolveLane(laneIdFromProject("My-Proj"), OPTS);
  assert.equal(r.ok, true);
  assert.equal(r.lane, "my-proj");
});

record("L8 create:false 时未注册 lane 返回 LANE_NOT_FOUND（不烧端口）", () => {
  const r = resolveLane("never-created", { ...OPTS, create: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "LANE_NOT_FOUND");
  assert.ok(/browser_open/.test(r.hint), "提示应指引先创建通道");
  const raw = JSON.parse(fs.readFileSync(OPTS.file, "utf8"));
  assert.equal(raw["never-created"], undefined, "不得顺带创建注册项");
});

record("L9 lane 数量上限生效，且报错可操作", () => {
  const o2 = { baseDir: BASE, file: path.join(BASE, "state2", "browser_lanes.json") };
  for (let i = 0; i < MAX_LANES; i++) assert.equal(resolveLane(`l${i}`, o2).ok, true);
  const over = resolveLane("overflow", o2);
  assert.equal(over.ok, false);
  assert.equal(over.reason, "LANE_LIMIT");
  assert.ok(over.hint.includes("browser_lanes.json"), "提示应说明编辑哪个文件");
  assert.ok(over.hint.includes(String(PORT_ALLOC_START)), "提示应说明端口范围");
});

record("L10 分配结果持久化，重读一致；cdpHostOf 正确", () => {
  const lanes = listLanes(OPTS);
  assert.ok(lanes["proj-a"]);
  assert.equal(lanes["proj-a"].port, resolveLane("proj-a", OPTS).port);
  assert.equal(lanes.default.builtin, true, "listLanes 应展示内置 default");
  assert.equal(cdpHostOf(lanes["proj-a"].port), `http://127.0.0.1:${lanes["proj-a"].port}`);
});

record("L11 markBrowserPid / laneBrowserAlive / releaseLane", () => {
  const pid = process.pid; // 当前进程必然存活
  const m = markBrowserPid("proj-a", pid, OPTS);
  assert.equal(m.ok, true);
  const e = resolveLane("proj-a", OPTS);
  assert.equal(e.browserPid, pid);
  assert.equal(laneBrowserAlive(e), true, "存活 PID 应判定为在用");
  assert.equal(laneBrowserAlive({ browserPid: 999999999 }), false, "不存在的 PID 应判定为不在用");
  assert.equal(laneBrowserAlive({}), false);
  // default 不记录 PID
  assert.equal(markBrowserPid("default", pid, OPTS).skipped, true);
  // 无发送记录 → 可释放
  const rel = releaseLane("proj-c", OPTS);
  assert.equal(rel.ok, true);
  assert.equal(resolveLane("proj-c", { ...OPTS, create: false }).reason, "LANE_NOT_FOUND");
});

record("L12 有发送记录的 lane 不被自动释放（保历史）", () => {
  const e = resolveLane("proj-d", OPTS);
  fs.mkdirSync(e.stateDir, { recursive: true });
  fs.writeFileSync(path.join(e.stateDir, "relay_r-test.json"), JSON.stringify({ status: "DONE" }), "utf8");
  const rel = releaseLane("proj-d", OPTS);
  assert.equal(rel.ok, false);
  assert.equal(rel.reason, "LANE_HAS_STATE");
  assert.ok(rel.hint.includes("browser_lanes.json"));
  assert.equal(releaseLane("proj-d", { ...OPTS, force: true }).ok, true);
});

record("L13 stateDir 被换成联接点/符号链接时拒绝（防逃逸）", () => {
  const e = resolveLane("proj-e", OPTS);
  const outside = path.join(BASE, "outside-state");
  fs.mkdirSync(outside, { recursive: true });
  fs.rmSync(e.stateDir, { recursive: true, force: true });
  let linked = false;
  try { fs.symlinkSync(outside, e.stateDir, "junction"); linked = true; } catch {}
  try { fs.symlinkSync(outside, e.stateDir, "dir"); linked = true; } catch {}
  if (!linked) { results.push("SKIP L13（本环境不允许创建联接点/符号链接）"); return; }
  const r = resolveLane("proj-e", OPTS);
  assert.equal(r.ok, false, "符号链接 stateDir 必须被拒绝");
  assert.equal(r.reason, "LANE_PATH_UNSAFE");
});

// L14：多进程并发注册不同 lane，不得撞端口、不得丢注册（DS 评审 P0-1 回归）
await recordAsync("L14 多进程并发注册：端口唯一、注册不丢失", async () => {
  const file = path.join(BASE, "state3", "browser_lanes.json");
  const names = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const runs = names.map((n) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["-e", `
      import(${JSON.stringify(new URL("./browser_lanes.mjs", import.meta.url).href)}).then((m) => {
        const r = m.resolveLane(${JSON.stringify(n)}, { baseDir: ${JSON.stringify(BASE)}, file: ${JSON.stringify(file)} });
        process.stdout.write(JSON.stringify(r));
      }).catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: String(e) })); });
    `], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("close", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error("子进程输出无法解析: " + out.slice(0, 120))); } });
    c.on("error", reject);
  }));
  const got = await Promise.all(runs);
  for (const g of got) assert.equal(g.ok, true, `并发注册应成功: ${JSON.stringify(g).slice(0, 160)}`);
  const ports = got.map((g) => g.port);
  assert.equal(new Set(ports).size, ports.length, `并发注册不得撞端口: ${ports.join(",")}`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const n of names) assert.ok(raw[n], `注册不得丢失: ${n}`);
  assert.equal(Object.keys(raw).length, names.length, "注册表不得出现多余条目");
});

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`\n合计: ${passed}/${results.length} 通过` + (failed.length ? " (有失败)" : ""));
fs.rmSync(BASE, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
