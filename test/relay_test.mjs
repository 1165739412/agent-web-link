// C9 中转单元测试（不访问 CDP）：配置加载 / 会话选择顺序与回退 / 传输护栏
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadRelayConfig, pickTargetPage, checkRelayGuard, defaultRelayConfig } from "./relay.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, "tmp_relay");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const results = [];
let passed = 0;
function record(name, fn) {
  try { fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}

record("R1 配置缺失回退默认", () => {
  const r = loadRelayConfig({ file: path.join(TMP, "nope.json") });
  assert.equal(r.ok, true);
  assert.equal(r.source, "default");
  assert.deepEqual(r.config.conversations, []);
});

record("R2 配置合法读取", () => {
  const f = path.join(TMP, "cfg.json");
  fs.writeFileSync(f, JSON.stringify({ conversations: [{ id: "abc", url: "https://chatgpt.com/c/abc" }], allowAnyReadyPage: false }));
  const r = loadRelayConfig({ file: f });
  assert.equal(r.ok, true);
  assert.equal(r.source, "file");
  assert.equal(r.config.conversations[0].id, "abc");
  assert.equal(r.config.allowAnyReadyPage, false);
});

record("R3 配置非法 JSON → ok:false", () => {
  const f = path.join(TMP, "bad.json");
  fs.writeFileSync(f, "{not json");
  const r = loadRelayConfig({ file: f });
  assert.equal(r.ok, false);
});

const P = (url, id = url) => ({ type: "page", id, url, webSocketDebuggerUrl: "ws://x" });

record("R4 按配置顺序选择会话", () => {
  const cfg = { ...defaultRelayConfig(), allowAnyReadyPage: false, conversations: [{ id: "convA" }, { id: "convB" }] };
  const pages = [P("https://chatgpt.com/c/convB-zz", "p2"), P("https://chatgpt.com/c/convA-yy", "p1")];
  const r = pickTargetPage(pages, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.page.id, "p1", "应优先 convA（配置顺序）");
  assert.equal(r.how, "configured");
});

record("R5 无匹配 + 允许任意就绪页 → 回退任一会话页", () => {
  const cfg = { ...defaultRelayConfig(), allowAnyReadyPage: true, conversations: [{ id: "convX" }] };
  const pages = [P("https://chatgpt.com/c/other-1", "p1"), P("https://example.com", "p2")];
  const r = pickTargetPage(pages, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.page.id, "p1");
  assert.equal(r.how, "any");
});

record("R6 无匹配 + 禁止任意页 → NO_MATCHING_CONVERSATION", () => {
  const cfg = { ...defaultRelayConfig(), allowAnyReadyPage: false, conversations: [{ id: "convX" }] };
  const pages = [P("https://chatgpt.com/c/other-1", "p1")];
  const r = pickTargetPage(pages, cfg);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "NO_MATCHING_CONVERSATION");
});

record("R7 完全无 ChatGPT 页 → NO_CHATGPT_PAGE", () => {
  const cfg = { ...defaultRelayConfig(), conversations: [{ id: "convX" }] };
  const r = pickTargetPage([P("https://example.com", "p1")], cfg);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "NO_CHATGPT_PAGE");
});

record("R8 忽略非 page / 非 chatgpt 目标", () => {
  const cfg = { ...defaultRelayConfig(), conversations: [{ id: "convA" }] };
  const pages = [{ type: "service_worker", url: "https://chatgpt.com/c/convA" }, P("https://notchat.openai.com/x", "p9")];
  const r = pickTargetPage(pages, cfg);
  assert.equal(r.ok, false, "非 page 与非 chatgpt 都不应命中");
});

record("R9 护栏：无记录放行", () => {
  const dir = path.join(TMP, "guard1");
  assert.equal(checkRelayGuard(dir).ok, true);
});

record("R10 护栏：上次 SENDING 阻断", () => {
  const dir = path.join(TMP, "guard2");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "r1", status: "SENDING" }));
  const g = checkRelayGuard(dir);
  assert.equal(g.ok, false);
  assert.ok(/SENDING/.test(g.reason));
});

record("R11 护栏：已回复的上一轮放行", () => {
  const dir = path.join(TMP, "guard3");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "r2", status: "REPLY_RECEIVED" }));
  assert.equal(checkRelayGuard(dir).ok, true);
});

record("R12 护栏：指针损坏 → 阻断", () => {
  const dir = path.join(TMP, "guard4");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), "{broken");
  assert.equal(checkRelayGuard(dir).ok, false);
});

// ---- 用户自主选择后端（DS 决策①②⑤） ----

record("R13 CLI/参数覆盖配置（--backend 优先于 preferBackend）", () => {
  const cfg = { ...defaultRelayConfig(), allowAnyReadyPage: true, preferBackend: "chatgpt", conversations: [{ id: "convA" }] };
  const pages = [P("https://chatgpt.com/c/convA", "p1"), P("https://chat.deepseek.com/a/chat/s/11112222-3333-4444-5555-666677778888", "p2")];
  const r = pickTargetPage(pages, cfg, "deepseek");
  assert.equal(r.ok, true);
  assert.equal(r.page.id, "p2", "参数 preferBackend 应覆盖配置");
  assert.equal(r.backendId, "deepseek");
});

record("R14 preferBackend 命中：优先于 conversations 顺序", () => {
  const cfg = { ...defaultRelayConfig(), allowAnyReadyPage: true, preferBackend: "deepseek", conversations: [{ id: "convA" }] };
  const pages = [P("https://chatgpt.com/c/convA", "p1"), P("https://chat.deepseek.com/a/chat/s/11112222-3333-4444-5555-666677778888", "p2")];
  const r = pickTargetPage(pages, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.page.id, "p2", "preferBackend 应优先于 conversations 命中的 chatgpt 页");
  assert.equal(r.backendId, "deepseek");
});

record("R15 preferBackend 无就绪页面 → 保序回退并标注实际后端", () => {
  const cfg = { ...defaultRelayConfig(), allowAnyReadyPage: true, preferBackend: "deepseek", conversations: [{ id: "convA" }] };
  const pages = [P("https://chatgpt.com/c/convA", "p1")];
  const r = pickTargetPage(pages, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.page.id, "p1", "deepseek 无页面应回退 chatgpt");
  assert.equal(r.backendId, "chatgpt", "回退后应标注实际后端");
});

record("R16 未配置 preferBackend → 行为与旧版一致", () => {
  const cfg = { ...defaultRelayConfig(), allowAnyReadyPage: true, conversations: [{ id: "convA" }] };
  const pages = [P("https://chat.deepseek.com/a/chat/s/11112222-3333-4444-5555-666677778888", "p2"), P("https://chatgpt.com/c/convA", "p1")];
  const r = pickTargetPage(pages, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.page.id, "p1", "conversations 顺序仍最优先");
});

record("R17 硬校验：未知 preferBackend → ok:false", () => {
  const f = path.join(TMP, "badprefer.json");
  fs.writeFileSync(f, JSON.stringify({ preferBackend: "gemini" }));
  const r = loadRelayConfig({ file: f });
  assert.equal(r.ok, false);
  assert.ok(/未知 preferBackend/.test(r.error));
});

record("R18 硬校验：未知 backends 条目 → ok:false", () => {
  const f = path.join(TMP, "badbackends.json");
  fs.writeFileSync(f, JSON.stringify({ backends: [{ id: "chatgpt" }, { id: "nope" }] }));
  const r = loadRelayConfig({ file: f });
  assert.equal(r.ok, false);
  assert.ok(/未知后端/.test(r.error));
});

console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);
if (passed === results.length) { fs.rmSync(TMP, { recursive: true, force: true }); console.log("临时目录已清理"); }
else process.exitCode = 1;
