// lane（浏览器通道）注册表单测：默认 lane 恒等于历史行为、新 lane 独立分配、隔离性、非法 ID 拒绝。
// 不触浏览器、不联网；全部用临时目录，不污染 test/state。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveLane, listLanes, normalizeLaneId, cdpHostOf,
  MAX_LANES, PORT_BASE, PORT_ALLOC_START,
} from "./browser_lanes.mjs";

const results = [];
let passed = 0;
function record(name, fn) {
  try { fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-lanes-"));
const OPTS = { baseDir: BASE, file: path.join(BASE, "state", "browser_lanes.json") };

record("L1 默认 lane 恒等于历史行为（9222 / browser-profile / state）", () => {
  const d = resolveLane(undefined, OPTS);
  assert.equal(d.ok, true, "默认 lane 应解析成功");
  assert.equal(d.lane, "default");
  assert.equal(d.port, PORT_BASE);
  assert.equal(d.port, 9222);
  assert.equal(d.profile, path.join(BASE, "browser-profile"));
  assert.equal(d.stateDir, path.join(BASE, "state"));
  const d2 = resolveLane("default", OPTS);
  assert.equal(d2.created, false, "重复解析不得重复创建");
  assert.equal(d2.port, d.port);
  assert.equal(d2.profile, d.profile);
  assert.equal(d2.stateDir, d.stateDir);
});

record("L2 新 lane 自动分配独立端口/profile/stateDir，且大小写归一、幂等", () => {
  const a = resolveLane("proj-a", OPTS);
  assert.equal(a.ok, true);
  assert.equal(a.created, true);
  assert.equal(a.port, PORT_ALLOC_START);
  assert.equal(a.profile, path.join(BASE, "browser-profile-proj-a"));
  assert.equal(a.stateDir, path.join(BASE, "state-proj-a"));
  const a2 = resolveLane("PROJ-A", OPTS);
  assert.equal(a2.lane, "proj-a", "lane ID 应归一为小写");
  assert.equal(a2.port, a.port, "同一 lane 必须拿到同一端口");
  assert.equal(a2.created, false);
});

record("L3 不同 lane 的端口/profile/stateDir 两两不同（真隔离）", () => {
  const a = resolveLane("proj-a", OPTS);
  const b = resolveLane("proj-b", OPTS);
  assert.notEqual(a.port, b.port);
  assert.notEqual(a.profile, b.profile);
  assert.notEqual(a.stateDir, b.stateDir);
});

record("L4 非法 lane ID 一律拒绝（路径穿越/分隔符/超长/非法首字符）", () => {
  const bad = ["../evil", "..", ".", "a/b", "a\\b", "a b", "-x", "_x", "x".repeat(33), "a.b", "UPPER!", "a:b", "a\tb"];
  for (const v of bad) {
    assert.equal(normalizeLaneId(v), null, `normalizeLaneId 应拒绝 ${JSON.stringify(v)}`);
    const r = resolveLane(v, OPTS);
    assert.equal(r.ok, false, `resolveLane 应拒绝 ${JSON.stringify(v)}`);
    assert.equal(r.reason, "INVALID_LANE");
  }
  // 空值/null 表示"用默认通道"，不是错误
  for (const v of [undefined, null, ""]) {
    assert.equal(normalizeLaneId(v), "default");
    assert.equal(resolveLane(v, OPTS).lane, "default");
  }
});

record("L5 lane 派生路径全部限制在 baseDir 内（无逃逸）", () => {
  for (const id of ["default", "proj-a", "proj-b", "x1"]) {
    const r = resolveLane(id, OPTS);
    assert.ok(r.profile.startsWith(BASE + path.sep), `profile 逃逸: ${r.profile}`);
    assert.ok(r.stateDir.startsWith(BASE + path.sep), `stateDir 逃逸: ${r.stateDir}`);
  }
});

record("L6 lane 数量上限生效", () => {
  const o2 = { baseDir: BASE, file: path.join(BASE, "state2", "browser_lanes.json") };
  for (let i = 0; i < MAX_LANES; i++) {
    const r = resolveLane(`l${i}`, o2);
    assert.equal(r.ok, true, `第 ${i} 个 lane 应分配成功`);
  }
  const over = resolveLane("overflow", o2);
  assert.equal(over.ok, false);
  assert.equal(over.reason, "LANE_LIMIT");
});

record("L7 分配结果持久化，重读一致", () => {
  const lanes = listLanes(OPTS);
  assert.ok(lanes["proj-a"], "应已持久化 proj-a");
  assert.equal(lanes["proj-a"].port, resolveLane("proj-a", OPTS).port);
  assert.equal(cdpHostOf(lanes["proj-a"].port), `http://127.0.0.1:${lanes["proj-a"].port}`);
});

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`合计: ${passed}/${results.length} 通过` + (failed.length ? " (有失败)" : ""));
fs.rmSync(BASE, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
