// CDP WebSocket 客户端共享模块（C1 已验证的生命周期实现，唯一连接管理代码）
// 由 ws_lifecycle_test.mjs 原样抽取；dom_diagnose.mjs 等后续脚本复用。
// 特性: 5s 连接超时 / 请求超时 / finally 统一 close(3s 超时) / 监听器登记与移除 / 耗时日志
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// C9-R7 实机调整: REQ_TIMEOUT 10000→20000。实机证据：用户在同一对话活跃聊天时页面主线程
// 繁忙，typeAndEcho 的 Runtime.evaluate 超过 10s 被判定超时 → 报告回传 UNKNOWN（实际 0 点击未提交）。
// 放宽单次请求等待（不重试、不改变其他语义）可吸收瞬时页面繁忙；连接/关闭超时保持不变。
export const OPEN_TIMEOUT = 5000, CLOSE_TIMEOUT = 3000, REQ_TIMEOUT = 20000, WATCHDOG_MS = 30000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "log");
fs.mkdirSync(LOG_DIR, { recursive: true });
let LOG_FILE = null;

export function initLog(prefix) {
  LOG_FILE = path.join(LOG_DIR, `${prefix}_${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  return LOG_FILE;
}

export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, line + "\n");
}

export const errType = (t) => Object.assign(new Error(t), { errType: t });

export class WSClient {
  constructor(ws) {
    this.ws = ws;
    this.listeners = [];
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.closeEventSeen = false;
  }
  on(type, fn) { this.ws.addEventListener(type, fn); this.listeners.push([type, fn]); }
  removeAll() {
    for (const [t, f] of this.listeners) this.ws.removeEventListener(t, f);
    const n = this.listeners.length;
    this.listeners = [];
    return n;
  }
  static async connect(wsOrUrl) {
    const ws = typeof wsOrUrl === "string" ? new WebSocket(wsOrUrl) : wsOrUrl;
    const c = new WSClient(ws);
    const t0 = Date.now();
    log(`[WS] connect start timeout=${OPEN_TIMEOUT}ms real=${typeof wsOrUrl === "string"}`);
    try {
      await new Promise((res, rej) => {
        const onOpen = () => res();
        const onErr = () => rej(errType("WebSocketError"));
        c.on("open", onOpen);
        c.on("error", onErr);
        const to = setTimeout(() => rej(errType("ConnectTimeout")), OPEN_TIMEOUT);
        to.unref?.();
        c._openTimer = to;
      });
      log(`[WS] connect ok elapsed=${Date.now() - t0}ms`);
      c.on("close", () => { c.closeEventSeen = true; if (!c.closed) log("[WS] remote closed connection"); });
      c.on("message", (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id) c._settle(m.id, m);
      });
    } catch (e) {
      log(`[WS] connect FAIL type=${e.errType || e.message} elapsed=${Date.now() - t0}ms`);
      const n = c.removeAll();
      try { ws.close(); } catch {}
      log(`[WS] connect-fail cleanup: listenersRemoved=${n} closeAttempted=true`);
      throw e;
    } finally {
      clearTimeout(c._openTimer);
    }
    return c;
  }
  send(method, params = {}) {
    const t0 = Date.now();
    return new Promise((res, rej) => {
      if (this.closed || this.ws.readyState > 1) { rej(errType("AlreadyClosed")); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log(`[REQ] ${method} TIMEOUT elapsed=${Date.now() - t0}ms`);
        rej(errType("RequestTimeout"));
      }, REQ_TIMEOUT);
      timer.unref?.();
      this.pending.set(id, { res, rej, timer, method, t0 });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  _settle(id, msg) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.error) {
      log(`[REQ] ${p.method} FAIL type=${msg.error.message} elapsed=${Date.now() - p.t0}ms`);
      p.rej(errType("ProtocolError"));
    } else {
      log(`[REQ] ${p.method} ok elapsed=${Date.now() - p.t0}ms`);
      p.res(msg.result);
    }
  }
  async close(reason = "normal") {
    if (this.closed) return;
    this.closed = true;
    const t0 = Date.now();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.rej(errType("ClosedDuringCleanup")); }
    this.pending.clear();
    try {
      this.ws.close();
      await new Promise((res) => {
        const done = () => res();
        this.on("close", done);
        const to = setTimeout(done, CLOSE_TIMEOUT);
        to.unref?.();
      });
      const n = this.removeAll();
      log(`[WS] close ok reason=${reason} elapsed=${Date.now() - t0}ms closeEventSeen=${this.closeEventSeen} listenersRemoved=${n}`);
      return true;
    } catch (e) {
      const n = this.removeAll();
      log(`[WS] close FAIL type=${e.message} listenersRemoved=${n}`);
      return false;
    }
  }
}
