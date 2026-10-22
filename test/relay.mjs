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
import { diagnose, explainReason } from "./relay_diagnostics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RELAY_CONFIG_DEFAULT = path.join(__dirname, "relay.config.json");
export const CDP_DEFAULT = "http://127.0.0.1:9222";

const RELAY_USAGE = `用法: node test/relay.mjs [--report-file <f> | --text <s>] [--conv <id>] [--backend deepseek|chatgpt]
       [--json-out <f>] [--config <f>] [--state-dir <dir>] | --probe [--conv <id>] | --diag | --recover [--conv <id>] | --probe-url <url>

  --report-file/--text  发送内容（二选一）
  --conv <id>           只发送到包含该会话 ID 的标签页
  --backend <id>        首选后端（chatgpt/deepseek），优先于 config.preferBackend
  --probe               就绪探测（不带 --conv 走就绪门；带 --conv 与发送同路径）
  --diag / --health     仅诊断 CDP/标签页/登录就绪，不发送
  --repair-wal          隔离损坏 WAL（含 latest）；默认写 UNKNOWN 占位仍阻断，--force 才直接放行
  --force               配合 --repair-wal：显式承担"损坏记录可能已发送"的风险
  --recover             只读恢复（不发送）；需唯一待确认记录 + --expect 指纹
  --run-id <id>         recover 时指定待确认记录（多候选时必须）
  --task-id <id>        recover 时按 reportRef 过滤
  --expect <s>          recover 指纹（回复必须包含，通常是 task_id/nonce）
  --allow-unverified    recover 时显式跳过指纹校验（不推荐）
  --probe-url <url>     导航到指定 URL 后探测
  -h, --help            显示本帮助

输出: RELAY_RESULT <json>（stdout）；日志一律 stderr。
文档: docs/SEND_WORKFLOW.md、docs/TROUBLESHOOTING.md`;

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
  if (!pick.ok) return { ok: false, reason: pick.reason, hint: explainReason(pick.reason, { cdpHost: config.cdpHost || CDP_DEFAULT }) };

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
    return { ok: false, reason: "NO_READY_CONVERSATION", pageUrl: page.url, detail: ready, hint: explainReason("NO_READY_CONVERSATION", { cdpHost: config.cdpHost || CDP_DEFAULT }) };
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

// 传输状态护栏：上一次若停在 SENDING/SENT/UNKNOWN（可能已发送但未确认），拒绝自动重发。
// 崩溃一致性（DS 评审 BLOCKER B1）：SENT/UNKNOWN 也属于"可能已提交"，必须先 --recover 读回确认。
export const PENDING_SEND_STATES = ["SENDING", "SENT", "UNKNOWN"];

// 从 URL 精确提取规范化会话标识（ChatGPT /c/<id> 或 DeepSeek /s/<id>）；禁止 substring 比较
function extractConvId(url) {
  const u = String(url || "");
  const m = u.match(/\/c\/([0-9a-fA-F-]{8,})/) || u.match(/\/s\/([0-9a-fA-F-]{8,})/);
  return m ? m[1].toLowerCase() : null;
}

// 隔离损坏 WAL（移动到 quarantine/ 并审计）。
// 默认写 UNKNOWN 占位，护栏仍阻断（避免"隔离即静默放行"）；--force 才写 ABORTED（显式承担风险）。
export function quarantineCorrupt(stateDir, file, { force = false } = {}) {
  try {
    const dir = path.join(stateDir, "quarantine");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${path.basename(file)}.${Date.now().toString(36)}`);
    fs.renameSync(file, dest);
    const runId = `r-quarantine-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
    const placeholder = path.join(stateDir, `relay_quarantine_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}.json`);
    const rec = {
      recordType: "relay", schemaVersion: 1, runId,
      status: force ? "ABORTED" : "UNKNOWN", phase: "quarantined",
      targetUrl: "", quarantinedFrom: path.basename(file), riskAccepted: force,
      at: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    writeFileAtomic(placeholder, JSON.stringify(rec, null, 2));
    try {
      fs.appendFileSync(path.join(stateDir, "audit.log"), JSON.stringify({ at: new Date().toISOString(), action: "quarantine-corrupt", file: path.basename(file), dest: path.basename(dest), placeholder: path.basename(placeholder), riskAccepted: force }) + "\n", "utf8");
    } catch {}
    return { dest, placeholder };
  } catch { return null; }
}

// 显式修复：隔离所有损坏的 WAL（含 relay_latest.json），下次发送会重建 latest。
// 默认 blocked=true（UNKNOWN 占位仍阻断）；force=true 才直接放行。
export function repairWal(stateDir, { force = false } = {}) {
  const out = [];
  const handle = (file) => {
    const r = quarantineCorrupt(stateDir, file, { force });
    if (r) out.push({ file: path.basename(file), dest: r.dest, placeholder: r.placeholder });
  };
  const latest = path.join(stateDir, "relay_latest.json");
  if (fs.existsSync(latest)) {
    try { JSON.parse(fs.readFileSync(latest, "utf8")); }
    catch { handle(latest); }
  }
  let files = [];
  try { files = fs.readdirSync(stateDir).filter((f) => /^relay_.+\.json$/.test(f) && f !== "relay_latest.json"); } catch {}
  for (const f of files) {
    const fp = path.join(stateDir, f);
    try { JSON.parse(fs.readFileSync(fp, "utf8")); }
    catch { handle(fp); }
  }
  return { ok: true, quarantined: out, blocked: !force && out.length > 0 };
}

// 人工确认后消除隔离占位（recover 成功时自动调用）
export function resolveQuarantine(stateDir, { status = "RECOVERED", by = null } = {}) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(stateDir).filter((x) => /^relay_quarantine_.+\.json$/.test(x))) {
      const fp = path.join(stateDir, f);
      try {
        const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
        if (rec.status === "UNKNOWN") {
          rec.status = status;
          rec.resolvedBy = by;
          rec.resolvedAt = new Date().toISOString();
          writeFileAtomic(fp, JSON.stringify(rec, null, 2));
          n++;
        }
      } catch {}
    }
  } catch {}
  return { ok: true, resolved: n };
}
export function checkRelayGuard(stateDir, { convId = null, targetId = null } = {}) {
  // fail-safe：目标会话未知（无 convId）或记录目标不可解析 → 视为可能同会话，保守阻断；
  // 仅当双方会话标识都确定且不相等时才放行。
  const targetConv = convId ? (extractConvId(convId) || String(convId).toLowerCase()) : null;
  const targetTab = targetId || null;
  const matches = (rec) => {
    const recTab = rec && rec.targetId ? rec.targetId : null;
    const recConv = extractConvId(rec && rec.targetUrl);
    if (targetTab && recTab) return recTab === targetTab; // 同 tab 阻断，不同 tab 放行
    if (targetTab && !recTab) {
      // 目标是新 tab/新会话：旧记录若有已知会话 → 视为不同；会话未知 → 保守阻断
      if (!targetConv) return !recConv ? true : false;
      if (!recConv) return true;
      return recConv === targetConv;
    }
    if (!targetConv) return true;
    if (!recConv) return true;
    return recConv === targetConv;
  };
  const p = path.join(stateDir, "relay_latest.json");
  let prev = null;
  if (fs.existsSync(p)) {
    try { prev = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) {
      // 正常发送流程遇损坏 WAL：阻断（只有 recover 才允许跳过损坏）
      return { ok: false, code: "WAL_CORRUPT_BLOCK", reason: `WAL_CORRUPT_BLOCK: relay_latest.json 损坏（${e.message}），禁止自动发送；请运行 node test/relay.mjs --repair-wal 隔离损坏文件` };
    }
  }
  // 扫描 WAL 记录：损坏 / typing / SENT / UNKNOWN 一律阻断；lock-acquired 放行
  try {
    const files = fs.readdirSync(stateDir).filter((f) => /^relay_.+\.json$/.test(f) && f !== "relay_latest.json");
    for (const f of files) {
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(path.join(stateDir, f), "utf8")); }
      catch (e) {
        return { ok: false, code: "WAL_CORRUPT_BLOCK", reason: `WAL_CORRUPT_BLOCK: WAL 记录 ${f} 损坏（${e.message}），禁止自动发送；请运行 node test/relay.mjs --repair-wal 隔离损坏文件` };
      }
      if (!rec || !PENDING_SEND_STATES.includes(rec.status)) continue;
      if (!matches(rec)) continue;
      if (rec.status === "SENDING" && rec.phase === "lock-acquired") continue;
      return {
        ok: false, status: rec.status, runId: rec.runId || null,
        reason: `上一次中转状态为 ${rec.status}${rec.phase ? "/" + rec.phase : ""}（${rec.runId || f}），可能已发送但未确认；禁止自动重发。请先 --recover --run-id ${rec.runId || "<runId>"} --expect <指纹> 读回确认`,
      };
    }
  } catch {}
  if (prev && PENDING_SEND_STATES.includes(prev.status) && matches(prev)) {
    if (prev.status === "SENDING" && prev.phase === "lock-acquired") return { ok: true };
    return {
      ok: false, status: prev.status, runId: prev.runId || null,
      reason: `上一次中转状态为 ${prev.status}（${prev.runId || ""}），可能已发送但未确认；禁止自动重发。请先 --recover --run-id ${prev.runId || "<runId>"} --expect <指纹> 读回确认`,
    };
  }
  return { ok: true };
}

// WAL 原子写（temp + rename），避免半写文件出现在最终路径（DS HIGH-3r 前提）
function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(2).toString("hex")}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function writeRelayRecord(stateDir, rec) {
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
  const file = path.join(stateDir, `relay_${rec.runId}.json`);
  writeFileAtomic(file, JSON.stringify(rec, null, 2));
  writeFileAtomic(path.join(stateDir, "relay_latest.json"), JSON.stringify({ runId: rec.runId, status: rec.status, phase: rec.phase || null, targetUrl: rec.targetUrl, updatedAt: rec.updatedAt }, null, 2));
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

// ---- HIGH-3：单 relay 进程锁（O_EXCL 锁文件），保证"检查—写入"与 CDP 操作串行 ----
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function acquireRelayLock(stateDir) {
  const lockPath = path.join(stateDir, "relay.lock");
  const token = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  // 陈旧阈值仅用于"无法判定 pid"的兜底；有 pid 时以存活性为准（DS HIGH-3r）
  const staleMs = Math.max(30000, Number(process.env.AGENT_LINK_LOCK_STALE_MS || 600000));
  // pid 存活但锁极旧（如 pid 被 OS 复用）时强制回收，避免永久死锁；阈值远大于单次发送耗时
  const hardMs = Math.max(10 * 60 * 1000, Number(process.env.AGENT_LINK_LOCK_HARD_STALE_MS || 2 * 60 * 60 * 1000));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      // 一次 writeFile 携带 pid/token，缩小"文件已建、内容未写"窗口
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: "wx", encoding: "utf8" });
      return { ok: true, path: lockPath, token };
    } catch (e) {
      if (e.code !== "EEXIST") return { ok: false, reason: "RELAY_LOCK_ERROR", error: e.message };
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch {}
      if (owner && Number.isInteger(owner.pid)) {
        if (isPidAlive(owner.pid)) {
          let mtime = 0;
          try { mtime = fs.statSync(lockPath).mtimeMs; } catch {}
          if (mtime && Date.now() - mtime > hardMs) {
            try { fs.rmSync(lockPath, { force: true }); } catch {}
            try { fs.appendFileSync(path.join(stateDir, "audit.log"), JSON.stringify({ at: new Date().toISOString(), action: "lock-force-reclaimed", owner }) + "\n", "utf8"); } catch {}
            continue;
          }
          return { ok: false, reason: "RELAY_BUSY", owner, hint: `进程 ${owner.pid} 持有锁` };
        }
        try { fs.rmSync(lockPath, { force: true }); } catch {}
        continue;
      }
      // 无 pid（锁文件损坏）→ mtime 兜底
      let stale = false;
      try { const st = fs.statSync(lockPath); stale = Date.now() - st.mtimeMs > staleMs; } catch {}
      if (stale) { try { fs.rmSync(lockPath, { force: true }); } catch {} continue; }
      return { ok: false, reason: "RELAY_BUSY", owner };
    }
  }
  return { ok: false, reason: "RELAY_BUSY" };
}

export function verifyRelayLock(lock) {
  if (!lock || !lock.ok) return false;
  try {
    const cur = JSON.parse(fs.readFileSync(lock.path, "utf8"));
    return !!cur && cur.token === lock.token && cur.pid === process.pid;
  } catch { return false; }
}

export function releaseRelayLock(lock) {
  if (!lock || !lock.ok) return;
  try {
    const cur = JSON.parse(fs.readFileSync(lock.path, "utf8"));
    if (cur && cur.token === lock.token) fs.rmSync(lock.path, { force: true });
  } catch {}
}

// 发送 + 独立读回：先取单进程锁，再执行；失败安全返回不重发
export async function sendAndRead(opts = {}) {
  const stateDir = opts.stateDir || path.join(__dirname, "state");
  const lock = acquireRelayLock(stateDir);
  if (!lock.ok) {
    return {
      ok: false,
      reason: lock.reason,
      hint: lock.reason === "RELAY_BUSY" ? "另一个 relay 发送正在进行（relay.lock）；请等待或检查冲突进程" : `获取发送锁失败: ${lock.error || ""}`,
      runId: `r-lock-${Date.now().toString(36)}`,
    };
  }
  // 拿到锁后立刻校验（防陈旧回收后原进程恢复继续发送）
  if (!verifyRelayLock(lock)) {
    releaseRelayLock(lock);
    return { ok: false, reason: "RELAY_LOCK_LOST", hint: "锁已被回收，放弃本次发送", runId: `r-lock-${Date.now().toString(36)}` };
  }
  const runId = `r-relay-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  try {
    // 任何 CDP 动作之前先落 WAL（SENDING），压缩"锁已取、WAL 未写"窗口
    writeRelayRecord(stateDir, {
      recordType: "relay", schemaVersion: 1, runId, targetUrl: "", status: "SENDING",
      phase: "lock-acquired", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    return await _sendAndRead({ ...opts, stateDir, runId, _lock: lock });
  } finally { releaseRelayLock(lock); }
}

// 支持 preferConvId（定向到指定对话）与 overridePage（刚新建、尚无 /c/id 的页面）
async function _sendAndRead({ config, text, stateDir, log = () => {}, preferConvId = null, overridePage = null, reportRef = null, preferBackend = null, runId: preRunId = null, _lock = null }) {
  const runId = preRunId || `r-relay-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const cdpHost = config.cdpHost || CDP_DEFAULT;

  // M6：发送限流（同一 stateDir 下最小间隔），降低触发网页风控的概率
  const minInterval = Math.max(0, Number(process.env.AGENT_LINK_MIN_SEND_INTERVAL_MS || 1500));
  if (minInterval > 0) {
    const f = path.join(stateDir, "relay_last_send.json");
    let last = 0;
    try { last = Number(JSON.parse(fs.readFileSync(f, "utf8")).at || 0); } catch {}
    const wait = last + minInterval - Date.now();
    if (wait > 0) { log(`[RELAY] 限流等待 ${wait}ms（最小发送间隔 ${minInterval}ms）`); await new Promise((r) => setTimeout(r, wait)); }
  }

  let tgt;
  let convMissing = false;
  if (overridePage) {
    tgt = { ok: true, page: overridePage, url: overridePage.url || "", how: "override" };
  } else {
    let page = null;
    if (preferConvId) {
      const list = await (await fetch((config.cdpHost || CDP_DEFAULT) + "/json/list")).json();
      page = list.find((t) => t.type === "page" && String(t.url || "").includes(preferConvId));
      if (!page) { convMissing = true; log(`[RELAY] 未找到会话 ${preferConvId} 的标签页，将回退到其他就绪会话（请确认 DS_CONV 正确）`); }
    }
    if (page) tgt = { ok: true, page, url: page.url, how: "preferConvId" };
    else {
      tgt = await resolveTarget({ config, log, preferBackend });
      if (!tgt.ok) {
        log(`[RELAY] 目标解析失败: ${tgt.reason}`);
        return { ok: false, reason: tgt.reason, runId, detail: tgt, convMissing, hint: tgt.hint || explainReason(tgt.reason, { cdpHost }) };
      }
    }
  }

  const backends = resolveBackends(config);
  let backend = selectBackend(tgt.url, backends) || CG;
  // DS 决策②：页面级回退（preferBackend 命中了其他后端）也要在凭证中标注
  let fallbackUsed = !!(preferBackend && backend.id !== preferBackend);

  // 护栏放在目标解析之后（HIGH-B'）：此时 targetId / convId 已定型，避免新会话首发被 fail-safe 误挡
  const targetConv = preferConvId || convIdOf(tgt.url, backend);
  const targetTab = (tgt.page && (tgt.page.id || tgt.page.targetId)) || null;
  const guard = checkRelayGuard(stateDir, { convId: targetConv, targetId: targetTab });
  if (!guard.ok) {
    log(`[RELAY] 护栏阻断: ${guard.reason}`);
    writeRelayRecord(stateDir, { recordType: "relay", schemaVersion: 1, runId, targetUrl: tgt.url, targetId: targetTab, status: "ABORTED", reason: guard.reason, updatedAt: new Date().toISOString() });
    return { ok: false, reason: guard.reason, hint: guard.reason, runId, targetUrl: tgt.url };
  }

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
      return { ok: false, reason: "NETWORK_UNAVAILABLE", network: netPre, runId, targetUrl: tgt.url, backend: backend.id, fallback: fallbackUsed, hint: explainReason("NETWORK_UNAVAILABLE", { cdpHost }) };
    }
  } else if (netPre && netPre.unavailable) {
    await c.close("relay-net-preflight");
    return { ok: false, reason: "NETWORK_UNAVAILABLE", network: netPre, runId, targetUrl: tgt.url, backend: backend.id, fallback: fallbackUsed, hint: explainReason("NETWORK_UNAVAILABLE", { cdpHost }) };
  }
  const textHash = createHash("sha256").update(text || "", "utf8").digest("hex").slice(0, 16);
  const rec = { recordType: "relay", schemaVersion: 1, runId, targetUrl: tgt.url, targetId: targetTab, how: tgt.how, status: "SENDING", startedAt: new Date().toISOString(), textLen: (text || "").length, textHash, reportRef, backend: backend.id, fallback: fallbackUsed, requestedBackend: preferBackend || null };
  let before;
  try {
    before = await readConversation(c, readSelOf(backend));
  } catch (e) {
    await c.close("relay-read-fail");
    return { ok: false, reason: `读取基线失败: ${e.message}`, hint: `无法读取页面消息基线（${e.message}）。请确认页面已加载、登录正常且选择器有效。`, runId };
  }
  rec.beforeCount = (before.msgs || []).length;
  rec.phase = "typing";
  writeRelayRecord(stateDir, rec);

  // 记录本次发送时间（限流基准）
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, "relay_last_send.json"), JSON.stringify({ at: Date.now() }), "utf8"); } catch {}
  // 发送临界区前再次校验锁（防原进程恢复后二次发送）
  if (_lock && !verifyRelayLock(_lock)) {
    await c.close("relay-lock-lost");
    rec.status = "ABORTED"; rec.reason = "RELAY_LOCK_LOST"; rec.updatedAt = new Date().toISOString();
    writeRelayRecord(stateDir, rec);
    return { ok: false, reason: "RELAY_LOCK_LOST", hint: "发送前锁校验失败（锁已被回收），放弃发送", runId, targetUrl: tgt.url };
  }
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
    return { ok: false, reason: reasonCode, contextLimit: limitHit, network: netDown, limitSignals: limit ? limit.signals : null, runId, targetUrl: tgt.url, hint: explainReason(reasonCode, { cdpHost }) };
  }

  // 点击前最后校验（输入与点击之间也可能被回收）
  if (_lock && !verifyRelayLock(_lock)) {
    await c.close("relay-lock-lost");
    rec.status = "ABORTED"; rec.reason = "RELAY_LOCK_LOST"; rec.updatedAt = new Date().toISOString();
    writeRelayRecord(stateDir, rec);
    return { ok: false, reason: "RELAY_LOCK_LOST", hint: "点击前锁校验失败（锁已被回收），放弃发送", runId, targetUrl: tgt.url };
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
    return { ok: false, reason: reasonCode, network: netDown, runId, targetUrl: tgt.url, hint: explainReason(reasonCode, { cdpHost }) };
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
      return { ok: false, reason: "CLICK_NO_EFFECT", runId, targetUrl: tgt.url, hint: explainReason("CLICK_NO_EFFECT", { cdpHost }) };
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
  // M5：回复落盘上限，避免超大回复耗尽磁盘/内存（截断标记随结果返回）
  const MAX_REPLY_CHARS = Math.max(1000, Number(process.env.AGENT_LINK_MAX_REPLY_CHARS || 1000000));
  let replyText = reply.replyText || "";
  let replyTruncated = false;
  if (replyText.length > MAX_REPLY_CHARS) { replyText = replyText.slice(0, MAX_REPLY_CHARS); replyTruncated = true; }
  if (!reply.ok) {
    const netDown = !!(netReply && netReply.unavailable);
    const reason = netDown ? "NETWORK_REPLY_TIMEOUT" : reply.reason;
    rec.status = "UNKNOWN"; rec.reason = reason; rec.network = netDown; rec.afterCount = reply.afterCount; rec.targetUrl = finalUrl; rec.replyText = replyText; rec.replyTruncated = replyTruncated; rec.updatedAt = new Date().toISOString();
    writeRelayRecord(stateDir, rec);
    return { ok: false, reason, network: netDown, runId, targetUrl: finalUrl, convId, replyText, replyTruncated, backend: backend.id, fallback: fallbackUsed, hint: explainReason(reason, { cdpHost, replyText }) };
  }
  rec.status = "REPLY_RECEIVED"; rec.targetUrl = finalUrl; rec.replyId = reply.replyId; rec.replyText = replyText; rec.replyTruncated = replyTruncated; rec.afterCount = reply.afterCount; rec.updatedAt = new Date().toISOString();
  const file = writeRelayRecord(stateDir, rec);
  return { ok: true, runId, targetUrl: finalUrl, convId, how: tgt.how, replyText, replyTruncated, replyId: reply.replyId, beforeCount: rec.beforeCount, afterCount: reply.afterCount, recordFile: file, backend: backend.id, fallback: fallbackUsed };
}

// 只读恢复（DS HIGH-1）：attach 已有会话，读回最后一条助手回复，不发送。
// 必须唯一命中待确认记录，并用 --expect 指纹校验；零候选/多候选/不匹配一律拒绝，避免静默张冠李戴。
export async function recover({ config, stateDir, convId = null, taskId = null, runId = null, expect = null, allowUnverified = false, log = () => {} }) {
  const cdp = config.cdpHost || CDP_DEFAULT;
  const backends = resolveBackends(config);
  // 损坏的 latest 先隔离（recover 末尾会重建）
  const latestPath = path.join(stateDir, "relay_latest.json");
  if (fs.existsSync(latestPath)) {
    try { JSON.parse(fs.readFileSync(latestPath, "utf8")); }
    catch { quarantineCorrupt(stateDir, latestPath); }
  }
  // 1) 找待确认记录（SENDING/SENT/UNKNOWN）
  let candidates = [];
  try {
    const files = fs.readdirSync(stateDir).filter((f) => /^relay_.+\.json$/.test(f) && f !== "relay_latest.json");
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(stateDir, f), "utf8"));
        if (!PENDING_SEND_STATES.includes(rec.status)) continue;
        if (convId && !String(rec.targetUrl || "").includes(convId)) continue;
        if (taskId && rec.reportRef && rec.reportRef !== taskId) continue;
        candidates.push(rec);
      } catch {
        // 损坏记录：隔离（移动到 quarantine/ 并审计），使后续发送不再被永久阻断
        quarantineCorrupt(stateDir, path.join(stateDir, f));
      }
    }
  } catch {}
  if (runId) candidates = candidates.filter((r) => r.runId === runId);
  if (candidates.length === 0) return { ok: false, reason: "RECOVER_NO_PENDING", hint: "没有待确认的发送记录（SENDING/SENT/UNKNOWN）" };
  if (candidates.length > 1) {
    return {
      ok: false, reason: "RECOVER_AMBIGUOUS",
      runIds: candidates.slice(0, 20).map((c) => c.runId),
      candidatesTruncated: candidates.length > 20,
      hint: "存在多条待确认记录，请用 --run-id 指定，避免张冠李戴",
    };
  }
  const pending = candidates[0];
  // 2) 读回
  const list = await (await fetch(cdp + "/json/list")).json();
  const pages = (list || []).filter((t) => t && t.type === "page");
  let page = convId ? pages.find((t) => String(t.url || "").includes(convId)) : null;
  if (!page) {
    const pats = chatPageUrlPatterns(backends);
    page = pages.find((t) => pats.some((rx) => rx.test(t.url || "")));
  }
  if (!page) return { ok: false, reason: "NO_CHATGPT_PAGE", hint: explainReason("NO_CHATGPT_PAGE", { cdpHost: cdp }) };
  const backend = selectBackend(page.url, backends) || CG;
  const c = await WSClient.connect(page.webSocketDebuggerUrl);
  let snap;
  try { snap = await readConversation(c, readSelOf(backend)); }
  finally { await c.close("recover-read"); }
  const assistants = (snap.msgs || []).filter((m) => m.role === "assistant");
  const last = assistants.length ? assistants[assistants.length - 1] : null;
  const finalConvId = convIdOf(page.url, backend);
  if (!last || !last.text) {
    return { ok: false, reason: "NO_REPLY_FOUND", convId: finalConvId, targetUrl: page.url, backend: backend.id, pendingRunId: pending.runId };
  }
  // 3) 指纹匹配：默认必须带 --expect；无校验需显式 --allow-unverified
  const matchedBy = expect ? "expect" : "allow-unverified";
  if (expect && !String(last.text).includes(expect)) {
    return { ok: false, reason: "RECOVER_NO_MATCH", convId: finalConvId, pendingRunId: pending.runId, hint: `最后一条回复未包含指纹 ${expect}，拒绝归属` };
  }
  if (!expect && !allowUnverified) {
    return { ok: false, reason: "RECOVER_UNVERIFIED", convId: finalConvId, pendingRunId: pending.runId, hint: "请用 --expect <task_id/nonce> 校验回复；确需无校验请加 --allow-unverified" };
  }
  const newRunId = `r-recover-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  // 把被恢复的旧记录标记为 RECOVERED，避免正常发送流程继续扫描到 pending
  try {
    pending.status = "RECOVERED";
    pending.recoveredAt = new Date().toISOString();
    pending.recoveredBy = newRunId;
    writeFileAtomic(path.join(stateDir, `relay_${pending.runId}.json`), JSON.stringify(pending, null, 2));
  } catch {}
  const rec = {
    recordType: "relay", schemaVersion: 1, runId: newRunId, targetUrl: page.url,
    status: "RECOVERED", replyId: last.id || null, replyText: last.text,
    backend: backend.id, recoveredFrom: pending.runId, matchedBy, candidates: candidates.length,
    unverifiedRecovery: !expect,
    recoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const file = writeRelayRecord(stateDir, rec);
  // 人工确认成功：消除本次 recover 产生的隐藏隔离占位（避免继续阻断）
  resolveQuarantine(stateDir, { status: "RECOVERED", by: newRunId });
  try {
    fs.appendFileSync(path.join(stateDir, "audit.log"), JSON.stringify({ at: new Date().toISOString(), action: "recover", recoveredFrom: pending.runId, convId: finalConvId, matchedBy, unverifiedRecovery: !expect }) + "\n", "utf8");
  } catch {}
  log(`[RELAY] 恢复读回成功：${finalConvId || page.url}（来自 ${pending.runId}, matchedBy=${matchedBy}）`);
  return { ok: true, convId: finalConvId, targetUrl: page.url, replyText: last.text, backend: backend.id, recordFile: file, runId: newRunId, recoveredFrom: pending.runId, matchedBy };
}

// ---- CLI ----
function parseArgs(argv) {
  const out = { reportFile: null, text: null, conv: null, jsonOut: null, configFile: null, stateDir: null, probe: false, probeUrl: null, backend: null, diag: false, recover: false, recoverRun: null, recoverTask: null, recoverExpect: null, recoverUnverified: false, repairWal: false, force: false, help: false };
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
    else if (argv[i] === "--diag" || argv[i] === "--health") out.diag = true;
    else if (argv[i] === "--recover") out.recover = true;
    else if (argv[i] === "--repair-wal") out.repairWal = true;
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--run-id") out.recoverRun = argv[++i];
    else if (argv[i] === "--task-id") out.recoverTask = argv[++i];
    else if (argv[i] === "--expect") out.recoverExpect = argv[++i];
    else if (argv[i] === "--allow-unverified") out.recoverUnverified = true;
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
  }
  return out;
}

const __isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (__isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(RELAY_USAGE); process.exit(0); }
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
  if (opts.diag) {
    const d = await diagnose({ cdpHost: config.cdpHost || CDP_DEFAULT, backends: resolveBackends(config), convId: opts.conv || null, backend: opts.backend || null });
    console.log("DIAG " + JSON.stringify(d, null, 2));
    process.exit(d.cdp && d.cdp.up ? 0 : 3);
  }
  if (opts.repairWal) {
    const r = repairWal(stateDir, { force: opts.force });
    console.log("REPAIR_WAL " + JSON.stringify(r, null, 2));
    if (r.blocked) console.error("已隔离但写入 UNKNOWN 占位，发送仍被阻断；确认风险后加 --force，或用 --recover 读回确认。");
    process.exit(0);
  }
  if (opts.recover) {
    const r = await recover({
      config, stateDir, convId: opts.conv || null,
      taskId: opts.recoverTask || null, runId: opts.recoverRun || null,
      expect: opts.recoverExpect || null, allowUnverified: opts.recoverUnverified,
      log: (m) => console.error(m),
    });
    console.log("RECOVER " + JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  if (opts.probe) {
    let out;
    if (opts.conv) {
      // 按会话探测：与 sendAndRead(preferConvId) 走同一条路径，避免"探的是另一个标签页"导致误报
      const list = await (await fetch((config.cdpHost || CDP_DEFAULT) + "/json/list")).json();
      const page = list.find((t) => t.type === "page" && String(t.url || "").includes(opts.conv));
      if (!page) {
        out = { ok: false, reason: "CONV_PAGE_NOT_FOUND", hint: explainReason("CONV_PAGE_NOT_FOUND", { cdpHost: config.cdpHost || CDP_DEFAULT }) };
      } else {
        const backend = selectBackend(page.url, resolveBackends(config)) || CG;
        const ready = await probePage(page, backend);
        out = { ok: ready.ready, mode: "sessionDirect", url: page.url, backend: backend.id, ready, note: "此路径与 sendAndRead(preferConvId) 一致；ready=false 仅表示就绪信号缺失，不代表不能发送" };
      }
    } else {
      const r = await resolveTarget({ config, log: (m) => console.error(m), preferBackend: opts.backend || null });
      out = { ok: r.ok, mode: "readinessGate", reason: r.reason, url: r.url, how: r.how, ready: r.ready, hint: r.hint || (r.ok ? undefined : explainReason(r.reason, { cdpHost: config.cdpHost || CDP_DEFAULT })), note: "就绪门检查；不代表会话发送可用性（会话发送请用 --probe --conv <id>）" };
    }
    console.log("PROBE " + JSON.stringify(out, null, 2));
    if (!out.ok) {
      const d = await diagnose({ cdpHost: config.cdpHost || CDP_DEFAULT, backends: resolveBackends(config), convId: opts.conv || null, backend: opts.backend || null });
      console.error("PROBE_HINTS " + JSON.stringify(d.hints, null, 2));
      if (out.hint) console.error("PROBE_EXPLAIN " + out.hint);
    }
    process.exit(out.ok ? 0 : 1);
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
