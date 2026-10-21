// C9 双向消息中转（轻量）：Agent 报告原文 → ChatGPT → 原文回复 → 交给 Agent。
// 设计原则（与本任务约定一致）:
//   - 协调器只做收发/关联/传输状态，不解析语义、不推断决策、不强制任务块；
//   - 会话目标可配置（relay.config.json），支持多候选与就绪回退；
//   - 发送前持久化意图、发送后独立读回；不确定状态安全暂停，不自动重发同一消息；
//   - 复用已验证的 DOM 输入/点击思路与 read_conversation 只读快照。
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WSClient } from "./cdp_ws_client.mjs";
import { readConversation } from "./read_conversation.mjs";
import {
  CHATGPT, DEFAULT_BACKENDS, getBackend, selectBackend, chatPageUrlPatterns, resolveBackends,
  isPageReady as _isPageReady, readComposerText as _readComposerText,
  typeIntoComposer as _typeIntoComposer, clickSendOnce as _clickSendOnce,
  detectContextLimit as _detectContextLimit, readNewReply as _readNewReply,
} from "./agent_backends.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RELAY_CONFIG_DEFAULT = path.join(__dirname, "relay.config.json");
export const CDP_DEFAULT = "http://127.0.0.1:9222";

// 默认后端（保持向后兼容：不传 backend 时按 ChatGPT 处理）
const CG = CHATGPT;
const readSelOf = (b) => ({ user: b.user, assistant: b.assistant, assistantIdAttr: b.assistantIdAttr, regionMarker: b.regionMarker });

// 向后兼容封装：外部调用不传 backend 时沿用 ChatGPT 选择器
export async function isPageReady(c, b = CG) { return _isPageReady(c, b); }
export async function readComposerText(c, b = CG) { return _readComposerText(c, b); }
export async function typeIntoComposer(c, text, b = CG) { return _typeIntoComposer(c, text, b); }
export async function clickSendOnce(c, b = CG) { return _clickSendOnce(c, b); }
export async function detectContextLimit(c, b = CG) { return _detectContextLimit(c, b); }
export async function readNewReply(c, before, b = CG, opts = {}) { return _readNewReply(c, before, b, opts); }

export function defaultRelayConfig() {
  return {
    schemaVersion: 1,
    cdpHost: CDP_DEFAULT,
    conversations: [],
    allowAnyReadyPage: true,
    // 用户自主选择后端（DS 决策①：配置用 preferBackend，CLI 用 --backend，CLI 优先）
    preferBackend: null,
    // DS 决策④：网络异常自动切换默认关闭，显式开关；仅发送前预检阶段生效，绝不重发同一消息
    failoverOnNetworkError: false,
    replyTimeoutMs: 180000,
    pollMs: 1500,
    stableNeed: 3,
  };
}

export function loadRelayConfig({ file = RELAY_CONFIG_DEFAULT } = {}) {
  if (!fs.existsSync(file)) return { ok: true, config: defaultRelayConfig(), source: "default", configPath: file };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { ok: false, error: `relay 配置非合法 JSON: ${e.message}`, config: defaultRelayConfig(), configPath: file }; }
  const cfg = { ...defaultRelayConfig(), ...raw };
  if (!Array.isArray(cfg.conversations)) cfg.conversations = [];
  // DS 决策①③：硬校验——未知/未启用的后端名直接报错，不静默忽略
  const known = DEFAULT_BACKENDS.map((b) => b.id);
  if (cfg.preferBackend != null && !known.includes(cfg.preferBackend)) {
    return { ok: false, error: `未知 preferBackend: ${cfg.preferBackend}（可用: ${known.join(", ")}）`, config: defaultRelayConfig(), configPath: file };
  }
  const unknownB = (Array.isArray(cfg.backends) ? cfg.backends : [])
    .map((b) => (typeof b === "string" ? b : b && b.id))
    .filter((id) => id && !known.includes(id));
  if (unknownB.length) {
    return { ok: false, error: `未知后端: ${unknownB.join(", ")}（可用: ${known.join(", ")}）`, config: defaultRelayConfig(), configPath: file };
  }
  return { ok: true, config: cfg, source: "file", configPath: file };
}

// 会话挑选核心：conversations 配置顺序 → allowAnyReadyPage 回退
function pickFromPages(chatPages, config) {
  const convs = Array.isArray(config.conversations) ? config.conversations : [];
  for (const c of convs) {
    const id = typeof c === "string" ? c : c && c.id;
    if (!id) continue;
    const m = chatPages.find((p) => p.url.includes(id));
    if (m) return { ok: true, page: m, matched: { id, url: m.url }, how: "configured" };
  }
  if (config.allowAnyReadyPage) {
    return { ok: true, page: chatPages[0], matched: null, how: "any" };
  }
  return { ok: false, reason: "NO_MATCHING_CONVERSATION", chatPages };
}

// 纯函数：挑选目标会话（多后端）。
// 用户自主选择：preferBackend（参数优先于 config.preferBackend，DS 决策①）——
//   先在偏好后端的页面内按 conversations/any 挑选；其无就绪页面时按启用顺序回退其他后端（DS 决策②保序）。
// 返回附带 backendId（实际命中的后端），供发送凭证与审计标注（DS 决策②）。
export function pickTargetPage(pages, config, preferBackend = null) {
  const backends = resolveBackends(config);
  const patterns = chatPageUrlPatterns(backends);
  const chatPages = (pages || []).filter((p) => p && p.type === "page" && patterns.some((rx) => rx.test(p.url || "")));
  if (chatPages.length === 0) return { ok: false, reason: "NO_CHATGPT_PAGE", chatPages };
  const prefer = preferBackend || config.preferBackend || null;
  if (prefer) {
    const order = [prefer, ...backends.map((b) => b.id).filter((id) => id !== prefer)];
    for (const bid of order) {
      const b = backends.find((x) => x.id === bid);
      if (!b) continue;
      let rx;
      try { rx = new RegExp(b.urlPattern); } catch { continue; }
      const subset = chatPages.filter((p) => rx.test(p.url || ""));
      if (subset.length === 0) continue;
      const r = pickFromPages(subset, config);
      if (r.ok) return { ...r, backendId: bid };
    }
  }
  const r = pickFromPages(chatPages, config);
  if (!prefer) return r;
  return { ...r, backendId: r.ok ? ((selectBackend(r.page.url, backends) || {}).id) : undefined };
}

async function probePage(page, b = CG) {
  const c = await WSClient.connect(page.webSocketDebuggerUrl);
  try { return await isPageReady(c, b); } finally { await c.close("relay-probe"); }
}

// 解析目标：配置顺序 → 就绪检查 → 必要时导航 → 退回其他就绪候选；都失败则明确报告
export async function resolveTarget({ config, log = () => {}, preferBackend = null }) {
  const cdp = config.cdpHost || CDP_DEFAULT;
  const backends = resolveBackends(config);
  const patterns = chatPageUrlPatterns(backends);
  const list = await (await fetch(cdp + "/json/list")).json();
  const pick = pickTargetPage(list, config, preferBackend);
  if (!pick.ok) return { ok: false, reason: pick.reason };

  let page = pick.page;
  let ready = await probePage(page, selectBackend(page.url, backends) || CG);

  // 若命中的是配置会话但未就绪，尝试导航到其完整 URL
  const matchedConv = (config.conversations || []).find((c) => {
    const id = typeof c === "string" ? c : c && c.id;
    return id && page.url.includes(id);
  });
  if (!ready.ready && matchedConv && matchedConv.url) {
    log(`[RELAY] 目标未就绪(${ready.loadErr ? "加载失败" : "无编辑器"})，导航到 ${matchedConv.url}`);
    const c = await WSClient.connect(page.webSocketDebuggerUrl);
    try { await c.send("Page.navigate", { url: matchedConv.url }); } finally { await c.close("relay-nav"); }
    await new Promise((r) => setTimeout(r, 8000));
    const list2 = await (await fetch(cdp + "/json/list")).json();
    const p2 = list2.find((t) => t.type === "page" && t.url.includes(matchedConv.id));
    if (p2) { page = p2; ready = await probePage(p2, selectBackend(p2.url, backends) || CG); }
  }

  // 仍未就绪：按配置顺序尝试其它已就绪候选
  if (!ready.ready) {
    for (const c of config.conversations || []) {
      const id = typeof c === "string" ? c : c && c.id;
      if (!id || page.url.includes(id)) continue;
      const l2 = await (await fetch(cdp + "/json/list")).json();
      const p2 = l2.find((t) => t.type === "page" && patterns.some((rx) => rx.test(t.url)) && t.url.includes(id));
      if (!p2) continue;
      const r2 = await probePage(p2, selectBackend(p2.url, backends) || CG);
      if (r2.ready) { log(`[RELAY] 回退到备用就绪对话 ${id}`); return { ok: true, page: p2, url: p2.url, ready: r2, how: "fallback", backendId: (selectBackend(p2.url, backends) || {}).id }; }
    }
    return { ok: false, reason: "NO_READY_CONVERSATION", pageUrl: page.url, detail: ready };
  }
  // DS 决策②③：preferBackend 无就绪页面而回退时，告警日志而非静默降级
  const chosen = selectBackend(page.url, backends) || CG;
  if (preferBackend && chosen.id !== preferBackend) {
    log(`[RELAY] 回退告警: preferBackend=${preferBackend} 无就绪页面，实际使用 ${chosen.id}（fallback=true）`);
  }
  return { ok: true, page, url: page.url, ready, how: pick.how, backendId: chosen.id };
}

// 注：以上 typeIntoComposer / clickSendOnce / readNewReply 的实际实现已迁移至 agent_backends.mjs，
// 此处仅保留向后兼容的封装（见文件顶部），避免重复导出导致语法错误。

// 传输状态护栏：上一次发送若停在 SENDING（崩溃/未确认），拒绝自动重发
export function checkRelayGuard(stateDir) {
  const p = path.join(stateDir, "relay_latest.json");
  if (!fs.existsSync(p)) return { ok: true };
  try {
    const prev = JSON.parse(fs.readFileSync(p, "utf8"));
    if (prev && prev.status === "SENDING") {
      return { ok: false, reason: `上一次中转发送未确认（${prev.runId || ""} status=SENDING），需人工复核，禁止自动重发` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `relay 指针损坏: ${e.message}，需人工复核` };
  }
}

function writeRelayRecord(stateDir, rec) {
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
  const file = path.join(stateDir, `relay_${rec.runId}.json`);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
  fs.writeFileSync(path.join(stateDir, "relay_latest.json"), JSON.stringify({ runId: rec.runId, status: rec.status, targetUrl: rec.targetUrl, updatedAt: rec.updatedAt }, null, 2), "utf8");
  return file;
}

// ---- 跨对话：URL/上限检测/新建对话 ----
export function convIdOf(url, backend = CG) {
  const m = String(url || "").match(new RegExp(backend.convIdPattern));
  return m ? m[1] : null;
}
export async function readLocation(c) {
  const r = await c.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
  return r.result.value;
}
// 注：detectContextLimit 的实际实现已迁移至 agent_backends.mjs（见文件顶部兼容封装）。


// 网络异常判别：离线 / chrome 错误页 / 页面网络错误提示（与上下文耗尽区分）
export async function detectNetworkIssue(c) {
  const expr = `(() => {
    const t = (document.body && document.body.innerText) || "";
    const offline = (typeof navigator !== "undefined" && navigator.onLine === false);
    const url = String(location.href || "");
    const chromeErr = /^chrome-error:/.test(url);
    const markers = ["网络错误","连接中断","无法连接","请检查网络","网络连接","Check your connection","Network error","Something went wrong","ERR_INTERNET_DISCONNECTED","ERR_NETWORK_CHANGED","ERR_CONNECTION","ERR_NAME_NOT_RESOLVED","ERR_TIMED_OUT"];
    const hits = markers.filter((m) => t.includes(m));
    return JSON.stringify({ offline, chromeErr, hits, unavailable: offline || chromeErr || hits.length > 0 });
  })()`;
  const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  try { return JSON.parse(r.result.value); } catch { return { offline: null, chromeErr: false, hits: [], unavailable: false }; }
}
// 新建对话并确认"真正可用"（编辑器存在且未处于上下文耗尽）；有限次尝试，避免无限创建
export async function createNewConversation({ config, log = () => {}, attempts = 2, waitMs = 30000, backend = CG } = {}) {
  const cdp = config.cdpHost || CDP_DEFAULT;
  let lastTargetId = null;
  for (let a = 1; a <= attempts; a++) {
    const ver = await (await fetch(cdp + "/json/version")).json();
    const c0 = await WSClient.connect(ver.webSocketDebuggerUrl);
    let created;
    try { created = await c0.send("Target.createTarget", { url: backend.newConvUrl }); }
    finally { await c0.close("new-conv-create"); }
    const targetId = created && created.targetId;
    if (!targetId) { log(`[RELAY] 新建对话失败（attempt ${a}/${attempts}）`); continue; }
    lastTargetId = targetId;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const list = await (await fetch(cdp + "/json/list")).json();
      const page = list.find((t) => t.type === "page" && (t.id === targetId || t.targetId === targetId));
      if (!page) continue;
      const c = await WSClient.connect(page.webSocketDebuggerUrl);
      let ready;
      try { ready = await isPageReady(c, backend); } finally { await c.close("new-conv-probe"); }
      if (ready.limit) { log(`[RELAY] 新对话仍显示上下文耗尽，放弃该目标（attempt ${a}）`); break; }
      if (ready.ready) { log(`[RELAY] 新对话可用: ${page.url}（attempt ${a}）`); return { ok: true, targetId, page, attempts: a }; }
    }
    log(`[RELAY] 新对话未就绪（attempt ${a}/${attempts}）`);
  }
  return { ok: false, reason: "NEW_CONV_NOT_READY", targetId: lastTargetId, attempts };
}

// 发送 + 独立读回：返回 {ok, targetUrl, convId, replyText, replyId, ...}；失败安全返回不重发
// 支持 preferConvId（定向到指定对话）与 overridePage（刚新建、尚无 /c/id 的页面）
export async function sendAndRead({ config, text, stateDir, log = () => {}, preferConvId = null, overridePage = null, reportRef = null, preferBackend = null }) {
  const runId = `r-relay-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const guard = checkRelayGuard(stateDir);
  if (!guard.ok) { log(`[RELAY] 护栏阻断: ${guard.reason}`); return { ok: false, reason: guard.reason, runId }; }

  let tgt;
  if (overridePage) {
    tgt = { ok: true, page: overridePage, url: overridePage.url || "", how: "override" };
  } else {
    let page = null;
    if (preferConvId) {
      const list = await (await fetch((config.cdpHost || CDP_DEFAULT) + "/json/list")).json();
      page = list.find((t) => t.type === "page" && String(t.url || "").includes(preferConvId));
    }
    if (page) tgt = { ok: true, page, url: page.url, how: "preferConvId" };
    else {
      tgt = await resolveTarget({ config, log, preferBackend });
      if (!tgt.ok) { log(`[RELAY] 目标解析失败: ${tgt.reason}`); return { ok: false, reason: tgt.reason, runId, detail: tgt }; }
    }
  }

  const backends = resolveBackends(config);
  let backend = selectBackend(tgt.url, backends) || CG;
  // DS 决策②：页面级回退（preferBackend 命中了其他后端）也要在凭证中标注
  let fallbackUsed = !!(preferBackend && backend.id !== preferBackend);

  let c = await WSClient.connect(tgt.page.webSocketDebuggerUrl);
  // 网络预检：离线/错误页时直接安全返回，不输入、不点击。
  // DS 决策④：failoverOnNetworkError 显式开启时，按启用顺序回退其他后端一次——
  // 预检失败发生在任何输入/点击之前，切换后发送不构成"重发同一消息"。
  let netPre = null;
  try { netPre = await detectNetworkIssue(c); } catch {}
  if (netPre && netPre.unavailable && config.failoverOnNetworkError) {
    try { await c.close("relay-failover"); } catch {}
    let switched = false;
    for (const bid of resolveBackends(config).map((b) => b.id).filter((id) => id !== backend.id)) {
      const b2 = resolveBackends(config).find((x) => x.id === bid);
      if (!b2) continue;
      let rx;
      try { rx = new RegExp(b2.urlPattern); } catch { continue; }
      let cand = null;
      try {
        const listF = await (await fetch((config.cdpHost || CDP_DEFAULT) + "/json/list")).json();
        cand = listF.find((t) => t.type === "page" && rx.test(t.url || ""));
      } catch {}
      if (!cand) continue;
      let ready = null;
      try { ready = await probePage(cand, b2); } catch { continue; }
      if (!ready || !ready.ready) continue;
      let c2 = null, np2 = null;
      try {
        c2 = await WSClient.connect(cand.webSocketDebuggerUrl);
        try { np2 = await detectNetworkIssue(c2); } catch {}
      } catch { try { if (c2) await c2.close("relay-failover-err"); } catch {} continue; }
      if (np2 && np2.unavailable) { try { await c2.close("relay-failover-skip"); } catch {} continue; }
      log(`[RELAY] 网络回退: 后端 ${backend.id} 预检失败 → 切换到 ${bid}（fallback=true）`);
      c = c2; netPre = np2;
      tgt = { ok: true, page: cand, url: cand.url, how: "failover" };
      backend = b2; fallbackUsed = true; switched = true; break;
    }
    if (!switched) {
      try { await c.close("relay-net-preflight"); } catch {}
      return { ok: false, reason: "NETWORK_UNAVAILABLE", network: netPre, runId, targetUrl: tgt.url, backend: backend.id, fallback: fallbackUsed };
    }
  } else if (netPre && netPre.unavailable) {
    await c.close("relay-net-preflight");
    return { ok: false, reason: "NETWORK_UNAVAILABLE", network: netPre, runId, targetUrl: tgt.url, backend: backend.id, fallback: fallbackUsed };
  }
  const textHash = createHash("sha256").update(text || "", "utf8").digest("hex").slice(0, 16);
  const rec = { recordType: "relay", schemaVersion: 1, runId, targetUrl: tgt.url, how: tgt.how, status: "SENDING", startedAt: new Date().toISOString(), textLen: (text || "").length, textHash, reportRef, backend: backend.id, fallback: fallbackUsed, requestedBackend: preferBackend || null };
  let before;
  try {
    before = await readConversation(c, readSelOf(backend));
  } catch (e) {
    await c.close("relay-read-fail");
    return { ok: false, reason: `读取基线失败: ${e.message}`, runId };
  }
  rec.beforeCount = (before.msgs || []).length;
  writeRelayRecord(stateDir, rec);

  let typed;
  try { typed = await _typeIntoComposer(c, text, backend); }
  catch (e) { typed = { ok: false, err: "type exception: " + e.message }; } // 提交可能触发页面上下文重建，异常需安全化
  log(`[RELAY] TYPE ok=${typed.ok} echoed=${typed.echoed} len=${typed.len}`);
  if (!typed.ok || !typed.echoed) {
    let limit = null, net = null;
    try { limit = await _detectContextLimit(c, backend); } catch {}
    try { net = await detectNetworkIssue(c); } catch {}
    const limitHit = !!(limit && limit.limit);
    const netDown = !!(net && net.unavailable);
    const reasonCode = netDown ? (limitHit ? "NETWORK_AND_CONTEXT_LIMIT" : "NETWORK_TYPE_FAILED") : (limitHit ? "CONTEXT_LIMIT" : (typed.err || "TYPE_FAILED"));
    rec.status = "ABORTED"; rec.reason = `回显失败: ${reasonCode}`; rec.contextLimit = limitHit; rec.network = netDown; rec.limitSignals = limit ? limit.signals : null; rec.updatedAt = new Date().toISOString();
    writeRelayRecord(stateDir, rec);
    await c.close("relay-type-fail");
    return { ok: false, reason: reasonCode, contextLimit: limitHit, network: netDown, limitSignals: limit ? limit.signals : null, runId, targetUrl: tgt.url };
  }

  let clicked;
  try { clicked = await _clickSendOnce(c, backend); }
  catch (e) { clicked = { ok: false, err: "click exception: " + e.message }; } // 提交可能触发上下文重建（Promise collected）
  log(`[RELAY] CLICK ${JSON.stringify(clicked)}`);
  if (!clicked.ok) {
    let net = null;
    try { net = await detectNetworkIssue(c); } catch {}
    const netDown = !!(net && net.unavailable);
    const reasonCode = netDown ? "NETWORK_CLICK_FAILED" : (clicked.err || "CLICK_FAILED");
    rec.status = "ABORTED"; rec.reason = `点击未执行: ${reasonCode}`; rec.network = netDown; rec.updatedAt = new Date().toISOString();
    writeRelayRecord(stateDir, rec);
    await c.close("relay-click-fail");
    return { ok: false, reason: reasonCode, network: netDown, runId, targetUrl: tgt.url };
  }
  // 提交生效校验（仅对声明 verifyClearAfterSend 的后端）：发送成功后输入框应清空；
  // 若仍有残留文本说明点击未真正提交，标 ABORTED 而非 SENT，防止假 SENT/假发送凭证。
  if (backend.verifyClearAfterSend) {
    await new Promise((r) => setTimeout(r, 1500));
    let after = null;
    try { after = await _readComposerText(c, backend); } catch {}
    if (after && after.found && (after.text || "").trim().length > 0) {
      rec.status = "ABORTED"; rec.reason = "点击未真正提交（输入框未清空）"; rec.updatedAt = new Date().toISOString();
      writeRelayRecord(stateDir, rec);
      await c.close("relay-click-noeffect");
      return { ok: false, reason: "CLICK_NO_EFFECT", runId, targetUrl: tgt.url };
    }
  }
  rec.status = "SENT"; rec.sentAt = new Date().toISOString();
  writeRelayRecord(stateDir, rec);

  const reply = await _readNewReply(c, before, backend, { pollMs: config.pollMs, timeoutMs: config.replyTimeoutMs, stableNeed: config.stableNeed, log });
  let netReply = null;
  if (!reply.ok) { try { netReply = await detectNetworkIssue(c); } catch {} }
  const href = await readLocation(c).catch(() => null);
  await c.close("relay-done");
  const finalUrl = href || tgt.url;
  const convId = convIdOf(finalUrl, backend) || convIdOf(tgt.url, backend);
  if (!reply.ok) {
    const netDown = !!(netReply && netReply.unavailable);
    const reason = netDown ? "NETWORK_REPLY_TIMEOUT" : reply.reason;
    rec.status = "UNKNOWN"; rec.reason = reason; rec.network = netDown; rec.afterCount = reply.afterCount; rec.targetUrl = finalUrl; rec.updatedAt = new Date().toISOString();
    writeRelayRecord(stateDir, rec);
    return { ok: false, reason, network: netDown, runId, targetUrl: finalUrl, convId, replyText: reply.replyText, backend: backend.id, fallback: fallbackUsed };
  }
  rec.status = "REPLY_RECEIVED"; rec.targetUrl = finalUrl; rec.replyId = reply.replyId; rec.replyText = reply.replyText; rec.afterCount = reply.afterCount; rec.updatedAt = new Date().toISOString();
  const file = writeRelayRecord(stateDir, rec);
  return { ok: true, runId, targetUrl: finalUrl, convId, how: tgt.how, replyText: reply.replyText, replyId: reply.replyId, beforeCount: rec.beforeCount, afterCount: reply.afterCount, recordFile: file, backend: backend.id, fallback: fallbackUsed };
}

// ---- CLI ----
function parseArgs(argv) {
  const out = { reportFile: null, text: null, conv: null, jsonOut: null, configFile: null, stateDir: null, probe: false, probeUrl: null, backend: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report-file") out.reportFile = argv[++i];
    else if (argv[i] === "--text") out.text = argv[++i];
    else if (argv[i] === "--conv") out.conv = argv[++i];
    else if (argv[i] === "--json-out") out.jsonOut = argv[++i];
    else if (argv[i] === "--config") out.configFile = argv[++i];
    else if (argv[i] === "--state-dir") out.stateDir = argv[++i];
    else if (argv[i] === "--backend") out.backend = argv[++i];
    else if (argv[i] === "--probe") out.probe = true;
    else if (argv[i] === "--probe-url") out.probeUrl = argv[++i];
  }
  return out;
}

const __isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (__isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const loaded = loadRelayConfig({ file: opts.configFile || RELAY_CONFIG_DEFAULT });
  if (!loaded.ok) { console.error("CFG_ERROR " + loaded.error); process.exit(64); }
  const config = loaded.config;
  if (opts.backend) {
    // DS 决策①：CLI 优先于配置；未知后端名硬报错，不静默忽略
    const known = resolveBackends(config).map((b) => b.id);
    if (!known.includes(opts.backend)) {
      console.error("CFG_ERROR 未知 --backend: " + opts.backend + "（可用: " + known.join(", ") + "）");
      process.exit(64);
    }
  }
  if (opts.conv) config.conversations = [{ id: opts.conv, url: `https://chatgpt.com/c/${opts.conv}` }, ...(config.conversations || [])];
  const stateDir = opts.stateDir || path.join(__dirname, "state");

  if (opts.probeUrl) {
    const list = await (await fetch((config.cdpHost || CDP_DEFAULT) + "/json/list")).json();
    const page = list.find((p) => p.type === "page");
    const c = await WSClient.connect(page.webSocketDebuggerUrl);
    await c.send("Page.navigate", { url: opts.probeUrl });
    await new Promise((r) => setTimeout(r, 8000));
    const ready = await isPageReady(c);
    await c.close("relay-probe-url");
    console.log("PROBE_URL " + JSON.stringify({ url: opts.probeUrl, ...ready }, null, 2));
    process.exit(0);
  }
  if (opts.probe) {
    const r = await resolveTarget({ config, log: (m) => console.error(m) });
    console.log("PROBE " + JSON.stringify({ ok: r.ok, reason: r.reason, url: r.url, how: r.how, ready: r.ready }, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  const text = opts.text != null ? opts.text : (opts.reportFile ? fs.readFileSync(opts.reportFile, "utf8") : null);
  if (text == null) { console.error("缺少 --text 或 --report-file"); process.exit(64); }
  sendAndRead({ config, text, stateDir, preferBackend: opts.backend || null, log: (m) => console.error(m) })
    .then((res) => {
      const out = JSON.stringify(res, null, 2);
      if (opts.jsonOut) fs.writeFileSync(opts.jsonOut, out, "utf8");
      console.log("RELAY_RESULT " + out);
      process.exit(res.ok ? 0 : 1);
    })
    .catch((e) => { console.error("RELAY_ERROR " + e.message); process.exit(3); });
}
