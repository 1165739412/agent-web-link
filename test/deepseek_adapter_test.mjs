// DeepSeek 网页版适配器真实测试（真实 CDP + 真实登录页 + 真实发送一条冒烟报告）
// 覆盖：
//   D1 selectBackend 按 URL 路由到 deepseek 后端（纯逻辑）
//   D2 pickTargetPage 识别 deepseek 页面（纯逻辑，合成 /json/list）
//   D3 真实页 isPageReady(DEEPSEEK) → ready=true（需已登录）
//   D4 真实输入框回显 typeIntoComposer(DEEPSEEK).echoed=true
//   D5 真实全链路 relay.sendAndRead → 真实发送报告并读回回复
//   D6 DeepSeek 回复含协议决策行（要求附带唯一 task_id，保证回复文本可差分）
// CDP 不可用或未登录时明确 SKIPPED，不伪造通过、不崩溃。
import assert from "node:assert/strict";
import { WSClient } from "./cdp_ws_client.mjs";
import { DEEPSEEK, selectBackend, resolveBackends } from "./agent_backends.mjs";
import { loadRelayConfig, pickTargetPage, sendAndRead } from "./relay.mjs";
import { isPageReady, typeIntoComposer } from "./relay.mjs";

const CDP = "http://127.0.0.1:9222";
const results = [];
let passed = 0;
async function rec(name, fn) {
  try { await fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}
// 瞬态错误重试（提交可能触发 DeepSeek 上下文重建）
async function retryEval(fn, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; await new Promise((r) => setTimeout(r, 2500)); }
  }
  throw err;
}

// CDP 不可用 → 明确跳过
let ver = null;
try { ver = await (await fetch(CDP + "/json/version")).json(); }
catch {
  console.log("SKIPPED: CDP_UNAVAILABLE (" + CDP + ") — 需 Chrome 远程调试端口 9222 就绪后重跑");
  console.log("\n合计: 0/0 通过（SKIPPED: CDP_UNAVAILABLE）");
  process.exit(0);
}

// D1/D2 纯逻辑
await rec("D1 selectBackend 按 URL 路由 deepseek", () => {
  assert.equal(selectBackend("https://chat.deepseek.com/a/chat/s/00000000-0000-0000-0000-0000000000ab").id, "deepseek");
  assert.equal(selectBackend("https://chatgpt.com/c/abc").id, "chatgpt");
});
await rec("D2 pickTargetPage 识别 deepseek 页面", () => {
  const cfg = loadRelayConfig().config;
  const pages = [
    { type: "page", id: "ds", url: "https://chat.deepseek.com/a/chat/s/00000000-0000-0000-0000-0000000000ab", webSocketDebuggerUrl: "ws://x" },
    { type: "page", id: "ex", url: "https://example.com", webSocketDebuggerUrl: "ws://y" },
  ];
  const r = pickTargetPage(pages, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.page.id, "ds");
});
assert.equal(resolveBackends({ backends: ["deepseek"] }).length, 1, "resolveBackends 启用列表生效");

// 找到真实 DeepSeek 页（没有则新建；仍未登录则明确跳过）
const list = await (await fetch(CDP + "/json/list")).json();
let dsPage = list.find((p) => p.type === "page" && /chat\.deepseek\.com/.test(p.url || ""));
let browser = null, createdTarget = null;
if (!dsPage) {
  browser = await WSClient.connect(ver.webSocketDebuggerUrl);
  const created = await browser.send("Target.createTarget", { url: DEEPSEEK.newConvUrl });
  createdTarget = created.targetId;
  await new Promise((r) => setTimeout(r, 10000));
  const list2 = await (await fetch(CDP + "/json/list")).json();
  dsPage = list2.find((p) => p.type === "page" && (p.id === createdTarget || p.targetId === createdTarget) && /deepseek/.test(p.url || ""));
}
if (!dsPage) {
  console.log("SKIPPED: NO_DEEPSEEK_PAGE — 无法打开 chat.deepseek.com，请检查网络/浏览器");
  console.log("\n合计: " + passed + "/" + passed + " 通过（SKIPPED: NO_DEEPSEEK_PAGE）");
  process.exit(0);
}

const c = await WSClient.connect(dsPage.webSocketDebuggerUrl);
try {
  // D3 真实就绪探测（登录后 textarea 存在）
  let ready = null;
  await rec("D3 真实页就绪: composer=true ready=true", async () => {
    ready = await retryEval(() => isPageReady(c, DEEPSEEK));
    assert.equal(ready.composer, true, "textarea 应存在（未登录时此项失败=需先登录）");
    assert.equal(ready.ready, true);
  });
  if (!ready || !ready.composer) {
    console.log("SKIPPED: DEEPSEEK_NOT_LOGGED_IN — 检测到无输入框（登录页），请登录后重跑");
    console.log(results.join("\n"));
    console.log(`\n合计: ${passed}/${results.length} 通过（SKIPPED: DEEPSEEK_NOT_LOGGED_IN）`);
    process.exit(0);
  }

  // D4 真实输入回显（短探针文本；随后 D5 会覆盖输入）
  await rec("D4 真实输入回显 echoed=true", async () => {
    const probe = "适配器回显测试 " + Date.now().toString(36);
    const typed = await retryEval(() => typeIntoComposer(c, probe, DEEPSEEK));
    assert.equal(typed.ok, true);
    assert.equal(typed.echoed, true);
  });

  // D5/D6 真实全链路：走生产 relay.sendAndRead 发送报告并读回决策
  // 回复要求附带唯一 task_id（nonce），使文本差分在"历史已有相同决策行"时仍可靠。
  const ts = Date.now().toString(36);
  const taskId = `ds-adapter-smoke-${ts}`;
  const report = [
    "AGENT_TASK_BEGIN",
    `task_id: ${taskId}`,
    "status: ACTIONS_DONE",
    "goal: DeepSeek 网页版适配器真实冒烟测试",
    "completed: 已按真实 DOM 校准 textarea/发送按钮/消息容器选择器并接入 relay 适配层",
    "evidence: agent_backends.mjs DEEPSEEK 选择器来自 deepseek_probe*.mjs 真实探针",
    "next_suggestion: 若你理解本报告，请按协议回复一行决策",
    "AGENT_TASK_END",
    "",
    `请严格按以下格式回复一行决策（除该行外不要输出其他内容，# 后必须原样附带本任务 id ${taskId}）：`,
    `decision: COMPLETE # ${taskId}`,
  ].join("\n");
  let rr = null;
  await rec("D5 真实全链路 sendAndRead ok=true", async () => {
    const cfg = loadRelayConfig().config;
    cfg.replyTimeoutMs = 120000; cfg.pollMs = 1500; cfg.stableNeed = 2;
    const preferConvId = (dsPage.url.match(/s\/([0-9a-fA-F-]{8,})/) || [])[1] || null;
    rr = await sendAndRead({ config: cfg, text: report, stateDir: "test/state", preferConvId, log: (m) => console.error(m) });
    assert.equal(rr.ok, true, "sendAndRead 失败: " + (rr.reason || "") + (rr.detail ? " " + JSON.stringify(rr.detail).slice(0, 200) : ""));
    assert.ok((rr.replyText || "").length > 0, "应有非空回复");
  });
  await rec("D6 回复含协议决策行", () => {
    assert.match(rr && rr.replyText || "", /decision\s*[:：]\s*(COMPLETE|CONTINUE|FIX|STOP|ASK_USER)/i, "回复应含 decision 行");
    assert.ok((rr && rr.replyText || "").includes(taskId), "决策行应附带唯一 task_id（保证差分可靠）");
  });
  console.error("ROUND_TRIP " + JSON.stringify({ ok: rr && rr.ok, convId: rr && rr.convId, replyId: rr && rr.replyId, runId: rr && rr.runId, replyHead: ((rr && rr.replyText) || "").slice(0, 90) }));
} finally {
  try { await c.close("deepseek-adapter-test"); } catch {}
  if (createdTarget && browser) { try { await browser.send("Target.closeTarget", { targetId: createdTarget }); } catch {} }
  try { if (browser) await browser.close("deepseek-adapter-browser"); } catch {}
}

console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);
if (passed !== results.length) process.exitCode = 1;
