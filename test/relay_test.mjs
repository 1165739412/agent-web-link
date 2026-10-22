// C9 中转单元测试（不访问 CDP）：配置加载 / 会话选择顺序与回退 / 传输护栏
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadRelayConfig, pickTargetPage, checkRelayGuard, defaultRelayConfig, acquireRelayLock, releaseRelayLock, repairWal, resolveQuarantine } from "./relay.mjs";

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

record("R10b 护栏：SENT/UNKNOWN（可能已发未确认）也阻断，并提示 --recover", () => {
  for (const st of ["SENT", "UNKNOWN"]) {
    const dir = path.join(TMP, `guard-${st}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "r-" + st, status: st }));
    const g = checkRelayGuard(dir);
    assert.equal(g.ok, false, `${st} 应阻断`);
    assert.match(g.reason, /--recover/);
  }
});

record("R11b 护栏：RECOVERED 后放行", () => {
  const dir = path.join(TMP, "guard-recovered");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "r3", status: "RECOVERED" }));
  assert.equal(checkRelayGuard(dir).ok, true);
});

record("R19 发送锁：互斥，释放后可再获取（HIGH-3）", () => {
  const dir = path.join(TMP, "lock1");
  const l1 = acquireRelayLock(dir);
  assert.equal(l1.ok, true);
  const l2 = acquireRelayLock(dir);
  assert.equal(l2.ok, false);
  assert.equal(l2.reason, "RELAY_BUSY");
  releaseRelayLock(l1);
  const l3 = acquireRelayLock(dir);
  assert.equal(l3.ok, true);
  releaseRelayLock(l3);
});

record("R20 发送锁：持有者 pid 存活时不回收（即使 mtime 旧）", () => {
  const dir = path.join(TMP, "lock-alive");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "relay.lock");
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, token: "other", at: 0 }));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(p, old, old);
  const l = acquireRelayLock(dir);
  assert.equal(l.ok, false);
  assert.equal(l.reason, "RELAY_BUSY");
});

record("R21 发送锁：持有者 pid 不存活时回收", () => {
  const dir = path.join(TMP, "lock-dead");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay.lock"), JSON.stringify({ pid: 999999, token: "dead", at: 0 }));
  const l = acquireRelayLock(dir);
  assert.equal(l.ok, true, "死进程的锁应被回收");
  releaseRelayLock(l);
});

record("R22 护栏：损坏 WAL 记录 → WAL_CORRUPT_BLOCK（不允许跳过）", () => {
  const dir = path.join(TMP, "wal-corrupt");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED" }));
  fs.writeFileSync(path.join(dir, "relay_bad.json"), "{broken");
  const g = checkRelayGuard(dir);
  assert.equal(g.ok, false);
  assert.equal(g.code, "WAL_CORRUPT_BLOCK");
});

record("R23 护栏：typing 记录阻断、lock-acquired 放行", () => {
  const dir = path.join(TMP, "wal-typing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED" }));
  fs.writeFileSync(path.join(dir, "relay_a.json"), JSON.stringify({ runId: "a", status: "SENDING", phase: "typing" }));
  assert.equal(checkRelayGuard(dir).ok, false);
  const dir2 = path.join(TMP, "wal-lock");
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED" }));
  fs.writeFileSync(path.join(dir2, "relay_b.json"), JSON.stringify({ runId: "b", status: "SENDING", phase: "lock-acquired" }));
  assert.equal(checkRelayGuard(dir2).ok, true);
});

record("R24 锁：活 pid 但超过硬阈值 → 强制回收并审计（pid 复用兜底）", () => {
  const dir = path.join(TMP, "lock-hard");
  fs.mkdirSync(dir, { recursive: true });
  const lp = path.join(dir, "relay.lock");
  fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, token: "x", at: 0 }));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(lp, old, old);
  process.env.AGENT_LINK_LOCK_HARD_STALE_MS = "3600000";
  try {
    const l = acquireRelayLock(dir);
    assert.equal(l.ok, true, "超硬阈值应强制回收");
    releaseRelayLock(l);
  } finally { delete process.env.AGENT_LINK_LOCK_HARD_STALE_MS; }
  assert.match(fs.readFileSync(path.join(dir, "audit.log"), "utf8"), /lock-force-reclaimed/);
});

record("R25 护栏按会话作用域：其他会话的 pending 不阻断", () => {
  const A = "aaaaaaaa-1111-2222-3333-444444444444";
  const B = "bbbbbbbb-1111-2222-3333-444444444444";
  const dir = path.join(TMP, "guard-scope");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED", targetUrl: `https://chat.deepseek.com/a/chat/s/${A}` }));
  fs.writeFileSync(path.join(dir, "relay_a.json"), JSON.stringify({ runId: "a", status: "SENT", targetUrl: `https://chat.deepseek.com/a/chat/s/${A}` }));
  assert.equal(checkRelayGuard(dir, { convId: B }).ok, true, "其他会话不应阻断");
  assert.equal(checkRelayGuard(dir, { convId: A }).ok, false, "同一会话应阻断");
});

record("R26 损坏 WAL：阻断 → repair-wal 隔离 → 放行（闭环）", () => {
  const dir = path.join(TMP, "wal-repair");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED" }));
  fs.writeFileSync(path.join(dir, "relay_bad.json"), "{broken");
  assert.equal(checkRelayGuard(dir).ok, false);
  const r = repairWal(dir);
  assert.equal(r.ok, true);
  assert.equal(r.blocked, true, "默认隔离应仍阻断（写 UNKNOWN 占位）");
  assert.ok(r.quarantined.some((x) => x.file === "relay_bad.json"));
  assert.equal(fs.existsSync(path.join(dir, "relay_bad.json")), false);
  assert.ok(fs.existsSync(path.join(dir, "quarantine")));
  assert.equal(checkRelayGuard(dir).ok, false, "默认隔离后仍阻断");
  resolveQuarantine(dir, { status: "RECOVERED" });
  assert.equal(checkRelayGuard(dir).ok, true, "人工确认后放行");
});

record("R26b 损坏 WAL + repair-wal --force → 直接放行（显式承担风险）", () => {
  const dir = path.join(TMP, "wal-repair-force");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED" }));
  fs.writeFileSync(path.join(dir, "relay_bad.json"), "{broken");
  assert.equal(checkRelayGuard(dir).ok, false);
  const r = repairWal(dir, { force: true });
  assert.equal(r.blocked, false);
  assert.equal(checkRelayGuard(dir).ok, true);
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes(".tmp-")), "隔离占位应为原子写，无 tmp 残留");
});

record("R27 损坏 latest：阻断 → 隔离 → 确认后放行", () => {
  const dir = path.join(TMP, "wal-repair-latest");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), "{broken");
  assert.equal(checkRelayGuard(dir).ok, false);
  repairWal(dir);
  assert.equal(checkRelayGuard(dir).ok, false, "默认隔离仍阻断");
  resolveQuarantine(dir, { status: "RECOVERED" });
  assert.equal(checkRelayGuard(dir).ok, true);
});

record("R30 护栏 tab 作用域：不同 tab 放行、同 tab 阻断", () => {
  const dir = path.join(TMP, "guard-tab");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED" }));
  fs.writeFileSync(path.join(dir, "relay_a.json"), JSON.stringify({ runId: "a", status: "SENT", targetId: "T1", targetUrl: "https://chat.deepseek.com/a/chat/s/aaaaaaaa-1111-2222-3333-444444444444" }));
  assert.equal(checkRelayGuard(dir, { targetId: "T2" }).ok, true, "不同 tab 不阻断");
  assert.equal(checkRelayGuard(dir, { targetId: "T1" }).ok, false, "同 tab 阻断");
});

record("R31 新会话首发：目标 tab 已知、旧记录为其他会话 → 放行", () => {
  const dir = path.join(TMP, "guard-newconv");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED" }));
  fs.writeFileSync(path.join(dir, "relay_a.json"), JSON.stringify({ runId: "a", status: "SENT", targetUrl: "https://chat.deepseek.com/a/chat/s/aaaaaaaa-1111-2222-3333-444444444444" }));
  assert.equal(checkRelayGuard(dir, { targetId: "TNEW" }).ok, true, "新会话首发不应被旧会话 pending 挡住");
});

record("R32 新 tab 但旧记录同会话 → 阻断", () => {
  const A = "aaaaaaaa-1111-2222-3333-444444444444";
  const dir = path.join(TMP, "guard-newtab-sameconv");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED" }));
  fs.writeFileSync(path.join(dir, "relay_a.json"), JSON.stringify({ runId: "a", status: "SENT", targetUrl: `https://chat.deepseek.com/a/chat/s/${A}` }));
  assert.equal(checkRelayGuard(dir, { targetId: "TNEW", convId: A }).ok, false);
});

record("R28 会话未知（记录无 targetUrl）→ 保守阻断", () => {
  const dir = path.join(TMP, "guard-unknown");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED" }));
  fs.writeFileSync(path.join(dir, "relay_u.json"), JSON.stringify({ runId: "u", status: "SENT" }));
  assert.equal(checkRelayGuard(dir, { convId: "012a2f54-897c-409d-974b-5fb05ade18af" }).ok, false);
});

record("R29 未指定目标会话 + 存在 SENT → 阻断（fail-safe）", () => {
  const dir = path.join(TMP, "guard-noconv");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay_latest.json"), JSON.stringify({ runId: "ok", status: "REPLY_RECEIVED" }));
  fs.writeFileSync(path.join(dir, "relay_s.json"), JSON.stringify({ runId: "s", status: "SENT", targetUrl: "https://chat.deepseek.com/a/chat/s/012a2f54-897c-409d-974b-5fb05ade18af" }));
  assert.equal(checkRelayGuard(dir).ok, false);
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
