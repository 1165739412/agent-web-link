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
// 默认 lane（`default`）恒等于历史行为：9222 / test/browser-profile / test/state，
// 因此不传 lane 的既有调用完全不受影响。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LANES_FILE = path.join(__dirname, "state", "browser_lanes.json");
export const DEFAULT_LANE = "default";
export const MAX_LANES = 16;
export const PORT_BASE = 9222;          // default lane 固定端口
export const PORT_ALLOC_START = 9223;   // 其余 lane 从这里递增分配
// lane ID 白名单：仅小写字母/数字/下划线/连字符，且不以连字符开头 —— 杜绝路径穿越（../、\、. 均不允许）
export const LANE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function normalizeLaneId(lane) {
  const id = String(lane == null || lane === "" ? DEFAULT_LANE : lane).trim().toLowerCase();
  if (!LANE_ID_RE.test(id)) return null;
  return id;
}

export function cdpHostOf(port) {
  return `http://127.0.0.1:${port}`;
}

function readLanes(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function writeLanes(file, lanes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, JSON.stringify(lanes, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function defaultLane(baseDir) {
  return { port: PORT_BASE, profile: path.join(baseDir, "browser-profile"), stateDir: path.join(baseDir, "state") };
}

/**
 * 幂等解析 lane → { port, profile, stateDir }。
 * 首次使用某 lane 时自动分配（端口递增、profile/stateDir 按 lane 名派生），并持久化。
 * 并发安全：写入前重读，避免两个进程给同一 lane 分到不同端口。
 */
export function resolveLane(lane, opts = {}) {
  const baseDir = opts.baseDir || __dirname;
  const file = opts.file || path.join(baseDir, "state", "browser_lanes.json");
  const id = normalizeLaneId(lane);
  if (!id) return { ok: false, reason: "INVALID_LANE", hint: `非法 lane：仅允许小写字母/数字/下划线/连字符，1-32 字符，且不以连字符开头（收到 ${JSON.stringify(String(lane)).slice(0, 40)}）` };

  const lanes = readLanes(file);
  if (lanes[id]) return { ok: true, lane: id, ...lanes[id], created: false };

  if (id === DEFAULT_LANE) {
    const entry = defaultLane(baseDir);
    lanes[id] = entry;
    writeLanes(file, lanes);
    return { ok: true, lane: id, ...entry, created: true };
  }

  if (Object.keys(lanes).length >= MAX_LANES) {
    return { ok: false, reason: "LANE_LIMIT", hint: `lane 数量已达上限 ${MAX_LANES}；请复用已有 lane 或清理 ${path.basename(file)}` };
  }
  const used = new Set(Object.values(lanes).map((l) => Number(l && l.port)).filter((n) => Number.isInteger(n)));
  let port = PORT_ALLOC_START;
  while (used.has(port) && port < PORT_ALLOC_START + MAX_LANES) port++;
  if (used.has(port)) return { ok: false, reason: "LANE_LIMIT", hint: `端口已分配殆尽（${PORT_ALLOC_START}-${PORT_ALLOC_START + MAX_LANES - 1}）` };

  const entry = { port, profile: path.join(baseDir, `browser-profile-${id}`), stateDir: path.join(baseDir, `state-${id}`) };
  const cur = readLanes(file); // 并发重读
  if (cur[id]) return { ok: true, lane: id, ...cur[id], created: false };
  cur[id] = entry;
  writeLanes(file, cur);
  return { ok: true, lane: id, ...entry, created: true };
}

export function listLanes(opts = {}) {
  const baseDir = opts.baseDir || __dirname;
  const file = opts.file || path.join(baseDir, "state", "browser_lanes.json");
  return readLanes(file);
}

// 便于脚本/CLI 直接查看当前通道分配
const __isMain = process.argv[1]
  && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (__isMain) {
  const lanes = listLanes();
  console.log("LANES " + JSON.stringify(lanes, null, 2));
}
