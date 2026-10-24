// 多通道（lane）注册表：让多个项目/模型真正并行使用浏览器中继。
//
// 不变量（关键）：**锁的粒度必须等于浏览器的粒度**。
//   - 同一个浏览器实例（同一个 CDP 端口）必须共用同一个 stateDir（同一把 relay.lock / 同一份 WAL）；
//   - 只有"独立浏览器实例"才配"独立 stateDir"，否则两把锁互不知情，会同时往同一浏览器打字、读错回复。
//
// 一个 lane = 三件套：
//   port     CDP 调试端口（独立浏览器实例）
//   profile  浏览器用户数据目录（登录态隔离，可绑不同账号）
//   stateDir relay 发送状态目录（锁 + WAL + 限流，独立）
//
// 默认 lane（`default`）是**硬编码**的共享主浏览器：9222 / test/browser-profile / test/state，
// 永不写入注册表，因此"不传 lane/project 的既有调用零影响"不可能被改坏。
//
// 并发安全（DS 评审 P0-1）：注册表的"读-算-写"整段临界区用独占锁（wx）串行化，
// 避免两个进程同时注册不同 lane 时都分到同一空闲端口、且后写覆盖前写导致注册丢失。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LANES_FILE = path.join(__dirname, "state", "browser_lanes.json");
export const DEFAULT_LANE = "default";
export const MAX_LANES = 16;
export const PORT_BASE = 9222;          // default lane 固定端口
export const PORT_ALLOC_START = 9223;   // 其余 lane 从这里递增分配
// lane ID 白名单：仅小写字母/数字/下划线/连字符，且不以连字符开头 —— 杜绝路径穿越（../、\、. 均不允许）
export const LANE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LOCK_FILE_NAME = "browser_lanes.lock";
const LOCK_STALE_MS = 30000;   // 持有者存活但锁很久没动 → 仍等待到截止，避免误抢
const LOCK_WAIT_MS = 4000;     // 拿不到锁就明确失败，不无限阻塞调用方

export function cdpHostOf(port) { return `http://127.0.0.1:${port}`; }

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

export function normalizeLaneId(lane) {
  const id = String(lane == null || lane === "" ? DEFAULT_LANE : lane).trim().toLowerCase();
  if (!LANE_ID_RE.test(id)) return null;
  return id;
}

// 由项目名派生稳定 lane ID。
// 规则：规范化后若与原文"无损相同"（仅大小写差异）→ 直接用，名字可读；
// 否则（含非法字符/过长等有损规范化）→ 追加 sha1 短哈希，保证不同项目名不会碰撞到同一通道。
export function laneIdFromProject(project) {
  const raw = String(project == null ? "" : project).trim().toLowerCase();
  if (!raw) return DEFAULT_LANE;
  const norm = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 20).replace(/-+$/, "") || "p";
  if (norm === raw && LANE_ID_RE.test(norm)) return norm;
  return `${norm}-${createHash("sha1").update(raw).digest("hex").slice(0, 8)}`;
}

function defaultLane(baseDir) {
  return { port: PORT_BASE, profile: path.join(baseDir, "browser-profile"), stateDir: path.join(baseDir, "state") };
}

function isPlainDir(p) {
  try { return !fs.lstatSync(p).isSymbolicLink(); } catch { return true; } // 不存在 → 允许创建
}

function sanitizeEntry(v) {
  if (!v || typeof v !== "object") return null;
  const port = Number(v.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof v.profile !== "string" || typeof v.stateDir !== "string") return null;
  const out = { port, profile: v.profile, stateDir: v.stateDir };
  if (typeof v.createdAt === "string") out.createdAt = v.createdAt;
  if (Number.isInteger(v.browserPid)) out.browserPid = v.browserPid;
  return out;
}

function readLanes(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === DEFAULT_LANE) continue;               // default 永不持久化
    const e = sanitizeEntry(v);
    if (e && normalizeLaneId(k)) out[k] = e;
  }
  return out;
}

function writeLanes(file, lanes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, JSON.stringify(lanes, null, 2), "utf8");
  fs.renameSync(tmp, file);                          // 原子替换
}

// ---- 注册表互斥锁（DS 评审 P0-1）：把"读-算-写"变成临界区 ----
function acquireMutex(file) {
  const lockPath = path.join(path.dirname(file), LOCK_FILE_NAME);
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: "wx", encoding: "utf8" });
      return { ok: true, path: lockPath, token };
    } catch (e) {
      if (e.code !== "EEXIST") return { ok: false, reason: "LANE_LOCK_ERROR", hint: `注册表锁异常: ${e.message}` };
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch {}
      const ownerAlive = !!(owner && Number.isInteger(owner.pid) && isPidAlive(owner.pid));
      if (ownerAlive) {
        let mtime = 0;
        try { mtime = fs.statSync(lockPath).mtimeMs; } catch {}
        if (mtime && Date.now() - mtime > LOCK_STALE_MS) { try { fs.rmSync(lockPath, { force: true }); } catch {} continue; }
        if (Date.now() > deadline) return { ok: false, reason: "LANE_LOCK_BUSY", hint: `注册表锁被进程 ${owner.pid} 持有（${LOCK_WAIT_MS}ms 内未释放），请稍后重试` };
      } else {
        try { fs.rmSync(lockPath, { force: true }); } catch {}   // 持有者已退出 → 回收
      }
    }
    sleepSync(20 + Math.floor(Math.random() * 40));             // 抖动退避，避免惊群
  }
}

function releaseMutex(m) {
  if (!m || !m.ok) return;
  try {
    const cur = JSON.parse(fs.readFileSync(m.path, "utf8"));
    if (cur && cur.token === m.token) fs.rmSync(m.path, { force: true });
  } catch {}
}

function limitHint(file) {
  return `通道数已达上限 ${MAX_LANES}（端口 ${PORT_ALLOC_START}-${PORT_ALLOC_START + MAX_LANES - 1}）。请复用已有通道，或编辑 ${path.basename(file)} 删除不再使用的条目；查看当前分配：node test/browser_lanes.mjs`;
}

function withMutex(file, fn) {
  const m = acquireMutex(file);
  if (!m.ok) return { ok: false, reason: m.reason, hint: m.hint };
  try { return fn(); } finally { releaseMutex(m); }
}

/**
 * 解析 lane → { port, profile, stateDir, browserPid? }。
 * - `default` 硬编码，永不持久化（builtin:true）。
 * - 其余 lane 首次使用时在互斥区内分配并持久化；`create:false` 时未注册则返回 LANE_NOT_FOUND。
 * - 已有 lane 的 profile/stateDir 若被换成符号链接 → 拒绝（路径逃逸防护）。
 */
export function resolveLane(lane, opts = {}) {
  const baseDir = opts.baseDir || __dirname;
  const file = opts.file || path.join(baseDir, "state", "browser_lanes.json");
  const create = opts.create !== false;
  const id = normalizeLaneId(lane);
  if (!id) {
    return { ok: false, reason: "INVALID_LANE", hint: `非法 lane：仅允许小写字母/数字/下划线/连字符，1-32 字符，且不以连字符开头（收到 ${JSON.stringify(String(lane)).slice(0, 40)}）` };
  }
  if (id === DEFAULT_LANE) return { ok: true, lane: DEFAULT_LANE, ...defaultLane(baseDir), created: false, builtin: true };

  return withMutex(file, () => {
    const lanes = readLanes(file);
    const existing = lanes[id];
    if (existing) {
      if (!isPlainDir(existing.stateDir) || !isPlainDir(existing.profile)) {
        return { ok: false, lane: id, reason: "LANE_PATH_UNSAFE", hint: `通道 ${id} 的 profile/state 目录被符号链接指向外部，已拒绝（防路径逃逸）。请删除 ${path.basename(file)} 中该条目后重建。` };
      }
      return { ok: true, lane: id, ...existing, created: false };
    }
    if (!create) {
      return { ok: false, lane: id, reason: "LANE_NOT_FOUND", hint: `通道 ${id} 尚未创建；请先调用 agent_link_browser_open { "lane": "${id}" } 启动该通道的浏览器并登录` };
    }
    if (Object.keys(lanes).length >= MAX_LANES) return { ok: false, lane: id, reason: "LANE_LIMIT", hint: limitHint(file) };
    const used = new Set(Object.values(lanes).map((l) => Number(l && l.port)).filter((n) => Number.isInteger(n)));
    let port = PORT_ALLOC_START;
    while (used.has(port) && port < PORT_ALLOC_START + MAX_LANES) port++;
    if (used.has(port)) return { ok: false, lane: id, reason: "LANE_LIMIT", hint: limitHint(file) };

    const entry = { port, profile: path.join(baseDir, `browser-profile-${id}`), stateDir: path.join(baseDir, `state-${id}`), createdAt: new Date().toISOString() };
    lanes[id] = entry;
    writeLanes(file, lanes);
    return { ok: true, lane: id, ...entry, created: true };
  });
}

// 记录"这个 lane 的浏览器是我们拉起的"（PID），用于私有通道只附着于自己的实例。
export function markBrowserPid(lane, pid, opts = {}) {
  const baseDir = opts.baseDir || __dirname;
  const file = opts.file || path.join(baseDir, "state", "browser_lanes.json");
  const id = normalizeLaneId(lane);
  if (!id || id === DEFAULT_LANE) return { ok: true, skipped: true };
  return withMutex(file, () => {
    const lanes = readLanes(file);
    if (!lanes[id]) return { ok: false, reason: "LANE_NOT_FOUND" };
    if (Number.isInteger(pid)) lanes[id].browserPid = pid; else delete lanes[id].browserPid;
    writeLanes(file, lanes);
    return { ok: true };
  });
}

// 释放通道注册（仅当其 state 目录不存在或无任何 relay 记录时才允许，避免丢发送历史）。
export function releaseLane(lane, opts = {}) {
  const baseDir = opts.baseDir || __dirname;
  const file = opts.file || path.join(baseDir, "state", "browser_lanes.json");
  const id = normalizeLaneId(lane);
  if (!id || id === DEFAULT_LANE) return { ok: false, reason: "INVALID_LANE" };
  return withMutex(file, () => {
    const lanes = readLanes(file);
    const e = lanes[id];
    if (!e) return { ok: true, removed: false };
    let hasState = false;
    try { hasState = fs.readdirSync(e.stateDir).some((f) => /^relay_.+\.json$/.test(f)); } catch {}
    if (hasState && !opts.force) {
      return { ok: false, reason: "LANE_HAS_STATE", hint: `通道 ${id} 已有发送记录（${e.stateDir}），为保历史不自动释放；确认无用后可手动编辑 ${path.basename(file)} 删除该条目` };
    }
    delete lanes[id];
    writeLanes(file, lanes);
    return { ok: true, removed: true };
  });
}

// 该 lane 的浏览器是否仍是我们拉起的那个实例（PID 存活）。
export function laneBrowserAlive(entry) {
  return !!(entry && Number.isInteger(entry.browserPid) && isPidAlive(entry.browserPid));
}

// 展示用：注册表 + 硬编码的 default
export function listLanes(opts = {}) {
  const baseDir = opts.baseDir || __dirname;
  const file = opts.file || path.join(baseDir, "state", "browser_lanes.json");
  const lanes = readLanes(file);
  const d = defaultLane(baseDir);
  return { [DEFAULT_LANE]: { ...d, builtin: true }, ...lanes };
}

const __isMain = process.argv[1]
  && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (__isMain) console.log("LANES " + JSON.stringify(listLanes(), null, 2));
