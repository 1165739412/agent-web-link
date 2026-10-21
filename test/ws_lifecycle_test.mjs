// 阶段 C1 最小 WebSocket 生命周期实验（只读，无副作用）
// C2 整改: WSClient 抽取至 cdp_ws_client.mjs 共享模块，本文件仅保留实验流程。
// 用法: node ws_lifecycle_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WSClient, errType, initLog, log, WATCHDOG_MS } from "./cdp_ws_client.mjs";

initLog("ws_lifecycle");

// 本地模拟对象: 永不 open 的 WebSocket 替身
class FakeWS {
  constructor() { this.readyState = 0; this.closeCalled = false; this.l = 0; }
  addEventListener() { this.l++; }
  removeEventListener() { this.l--; }
  close() { this.closeCalled = true; }
}

async function main() {
  log(`脚本=${fileURLToPath(import.meta.url)} node=${process.version} 启动=${new Date().toISOString()}`);
  const results = {};

  // ---- 测试1: 真实连接 + 协议级只读操作 + 正常关闭 ----
  const t0 = Date.now();
  const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  log(`[HTTP] /json/list ok elapsed=${Date.now() - t0}ms targets=${targets.length}`);
  const page = targets.find((t) => t.type === "page" && /chatgpt\.com/.test(t.url));
  if (!page) throw errType("NoChatgptPage");
  log(`[HTTP] 目标 page: title="${page.title}" url=${page.url}`);

  const c = await WSClient.connect(page.webSocketDebuggerUrl);
  try {
    const info = await c.send("Target.getTargetInfo", { targetId: page.id });
    const ti = info.targetInfo;
    log(`[VERIFY] getTargetInfo: title="${ti.title}" url=${ti.url}`);
    results.metaMatch = ti.url === page.url && ti.title === page.title;
    log(`[VERIFY] 与 /json/list 元信息一致=${results.metaMatch}`);
  } finally {
    results.closeOk = await c.close("normal-after-real-test");
  }
  results.closeEvent = c.closeEventSeen;

  // ---- 测试2: 本地 FakeWS 超时清理路径（不触碰浏览器） ----
  const m0 = Date.now();
  try {
    await WSClient.connect(new FakeWS());
    results.mockFail = false;
    log("[MOCK] [FAIL] FakeWS 竟然连接成功？异常");
  } catch (e) {
    results.mockFail = e.errType === "ConnectTimeout";
    log(`[MOCK] 超时路径触发 type=${e.errType} elapsed=${Date.now() - m0}ms 判定=${results.mockFail}`);
  }

  // ---- 汇总 ----
  const pass = results.metaMatch && results.closeOk && results.closeEvent && results.mockFail;
  log(`[SUMMARY] ${JSON.stringify({ ...results, pass })}`);
  process.exitCode = pass ? 0 : 20;
  log(`[DONE] 测试完成 退出码=${process.exitCode}`);
}

const watchdog = setTimeout(() => {
  log(`[WATCHDOG] 全局超时 ${WATCHDOG_MS}ms，强制清理退出`);
  process.exit(8);
}, WATCHDOG_MS);

main().catch((e) => {
  log(`[ERROR] type=${e.errType || e.message} stack=${(e.stack || "").split("\n").slice(0, 3).join(" | ")}`);
  process.exitCode = process.exitCode && process.exitCode !== 0 ? process.exitCode : 3;
}).finally(() => {
  clearTimeout(watchdog);
  log(`结束=${new Date().toISOString()} 退出码=${process.exitCode ?? 0}`);
});
