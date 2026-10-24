// C9 智能体/网页适配器层：把"具体网页的 DOM 选择器"从中转逻辑中抽离。
// 每个后端只描述：页面特征(urlPattern)、输入框、发送按钮、消息容器、上下文耗尽提示、新建对话入口。
// 中转协议(report/decision 文本模板)与调度逻辑与具体网页无关，可复用。
// 新增一个网页只需在此登记一个后端 + 在 relay.config.json 的 backends 中引用；选择器可热改、可标注 unverified。
import { WSClient } from "./cdp_ws_client.mjs";
import { readConversation } from "./read_conversation.mjs";

// ---- ChatGPT（参考实现，已真机验证） ----
export const CHATGPT = {
  id: "chatgpt",
  urlPattern: "chatgpt\\.com",
  composer: "div[contenteditable='true'][aria-label='询问 ChatGPT'], #prompt-textarea",
  sendButton: "[data-testid='send-button'], button[aria-label*='发送'], button[aria-label*='Send']",
  stopButton: "[data-testid='stop-button']",
  user: "[data-user-message-bubble]",
  assistant: "[data-dil-message-id]",
  assistantIdAttr: "data-dil-message-id",
  regionMarker: "最新一条回复",
  convIdPattern: "c/([0-9a-fA-F-]{8,})",
  newConvUrl: "https://chatgpt.com/",
  loadErrPattern: "无法加载此 ChatGPT 对话",
  limitPatterns: [
    "/聊天上下文已用完/", "/上下文已用完/", "/在新聊天中继续/",
    "/conversation is too long/i", "/maximum context length/i",
    "/context length exceeded/i", "/you'?ve reached the (maximum|limit)/i",
    "/continue in a new chat/i", "/start a new chat to continue/i",
    "/此对话过长/", "/对话已达到.{0,6}上限/", "/消息长度.{0,6}上限/",
  ],
  newChatButtonPattern: "在新聊天中继续|continue in a new chat",
  unverified: false,
};

// ---- DeepSeek 网页版（2026-10-21 真实登录页校准，探针 deepseek_probe*.mjs） ----
// 已验证：composer=textarea(placeholder「给 DeepSeek 发送消息」)；发送=div[role=button].ds-button--primary.ds-button--filled
//         （真实点击已成功发送并收到回复）；助手正文=.ds-markdown.ds-assistant-message-main-content（排除「已思考」推理块）；
//         消息容器=.ds-message；会话 URL=/a/chat/s/<uuid>。
// 注意：「开启新对话」按钮在侧边栏常驻，不能作为上下文耗尽信号 → newChatButtonPattern 留空禁用。
export const DEEPSEEK = {
  id: "deepseek",
  urlPattern: "chat\\.deepseek\\.com",
  composer: "textarea",
  sendButton: "div[role='button'].ds-button--primary.ds-button--filled",
  stopButton: "[class*='stop'], [aria-label*='停止']",
  user: ".ds-message",
  assistant: ".ds-markdown.ds-assistant-message-main-content",
  assistantIdAttr: "", // DeepSeek 助手消息无稳定 id 属性 → 读取器回退为位置化 id（"a"+序号）
  regionMarker: "",
  convIdPattern: "s/([0-9a-fA-F-]{8,})",
  newConvUrl: "https://chat.deepseek.com/",
  loadErrPattern: "",
  limitPatterns: [
    "/上下文长度上限/", "/对话长度已达上限/", "/已达到.{0,6}上限/",
    "/maximum context length/i", "/context length exceeded/i", "/conversation is too long/i",
  ],
  newChatButtonPattern: "",
  // 真实校准发现：输入事件后立即点击会被 DeepSeek 框架忽略（状态未同步）→ 点击前静置 800ms；
  // 且发送成功后 composer 会清空 → 用 verifyClearAfterSend 验证提交真正生效，防止假 SENT。
  preClickSettleMs: 800,
  verifyClearAfterSend: true,
  unverified: false,
};

export const DEFAULT_BACKENDS = [CHATGPT, DEEPSEEK];

export function getBackend(id, backends = DEFAULT_BACKENDS) {
  return backends.find((b) => b.id === id) || null;
}

export function selectBackend(url, backends = DEFAULT_BACKENDS) {
  const u = String(url || "");
  for (const b of backends) {
    try { if (new RegExp(b.urlPattern).test(u)) return b; } catch {}
  }
  return null;
}

// 配置中的 backends 只是"启用列表"（id 或 {id}），真正的选择器来自注册表。
// 未配置或为空时回退到全部默认后端。
export function resolveBackends(config) {
  const cfgBackends = config && Array.isArray(config.backends) ? config.backends : null;
  if (!cfgBackends || cfgBackends.length === 0) return DEFAULT_BACKENDS;
  const ids = cfgBackends.map((b) => (typeof b === "string" ? b : (b && b.id))).filter(Boolean);
  const filt = DEFAULT_BACKENDS.filter((b) => ids.includes(b.id));
  return filt.length ? filt : DEFAULT_BACKENDS;
}

// 用于 pickTargetPage 的"聊天页"URL 模式联合（默认仅 chatgpt.com，保持向后兼容）
export function chatPageUrlPatterns(backends = DEFAULT_BACKENDS) {
  const arr = (backends && backends.length ? backends : [CHATGPT]).map((b) => b.urlPattern);
  return arr.map((p) => new RegExp(p));
}

// 后端对应的 readConversation 选择集
function readSelOf(b) {
  return { user: b.user, assistant: b.assistant, assistantIdAttr: b.assistantIdAttr, regionMarker: b.regionMarker };
}

// ---- 通用 DOM 操作（全部以 b 为选择器来源；b 缺省时调用方负责传入默认后端）----

// 把 "/pattern/flags" 形式的模式串还原为 RegExp（JSON 注入后斜杠不再是定界符，需显式解析）
const RE_PARSE_HELPER = `const toRe = (s) => { if (s.length > 1 && s[0] === "/") { const j = s.lastIndexOf("/"); if (j > 0) { try { return new RegExp(s.slice(1, j), s.slice(j + 1)); } catch (e) {} } } try { return new RegExp(s); } catch (e) { return null; } };`;

// R-002 修复（DS 批次 8）：页面上下文损坏时，带 awaitPromise 的 Runtime.evaluate 会永久挂起
// （实机证据：同步求值正常、异步求值永不返回），CDP 层 REQ_TIMEOUT 只会报 RequestTimeout。
// 因此所有 awaitPromise 求值必须经本包装：Node 侧外部超时（默认 8s < REQ_TIMEOUT 20s），
// 超时抛 EVAL_BUDGET_EXCEEDED，由调用方转为结构化失败而不是永久卡死。
export const EVAL_BUDGET_MS = 8000;

export async function evalWithBudget(c, expr, { awaitPromise = true, budgetMs = EVAL_BUDGET_MS } = {}) {
  let timer;
  const budget = Promise.race([
    c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise }),
    new Promise((_res, rej) => {
      timer = setTimeout(() => {
        const e = new Error("EVAL_BUDGET_EXCEEDED");
        e.name = "EVAL_BUDGET_EXCEEDED";
        rej(e);
      }, budgetMs);
    }),
  ]);
  try {
    return await budget;
  } finally {
    clearTimeout(timer);
  }
}

export async function isPageReady(c, b) {
  const expr = `(() => {
    ${RE_PARSE_HELPER}
    const t = document.body ? (document.body.innerText || "") : "";
    const loadErr = ${JSON.stringify(b.loadErrPattern)} ? (() => { const re = toRe(${JSON.stringify(b.loadErrPattern)}); return re ? re.test(t) : false; })() : false;
    const strong = ${JSON.stringify(b.limitPatterns)};
    const signals = [];
    for (const p of strong) { const re = toRe(p); const m = re ? t.match(re) : null; if (m) signals.push(m[0]); }
    const btnPat = ${JSON.stringify(b.newChatButtonPattern)};
    const btn = btnPat ? [...document.querySelectorAll("button,a")].find((b2) => new RegExp(btnPat, "i").test((b2.innerText || "") + " " + (b2.getAttribute("aria-label") || ""))) : null;
    if (btn) signals.push("button:new-chat");
    const limit = signals.length > 0;
    const el = document.querySelector(${JSON.stringify(b.composer)});
    return JSON.stringify({
      loadErr, limit, signals,
      composer: !!el,
      readyState: document.readyState,
      msgCount: document.querySelectorAll(${JSON.stringify(b.user + "," + b.assistant)}).length
    });
  })()`;
  const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  const v = JSON.parse(r.result.value);
  return { ready: !v.loadErr && !v.limit && !!v.composer, ...v };
}

export async function readComposerText(c, b) {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(b.composer)});
    if (!el) return JSON.stringify({ found: false, text: "" });
    const text = (el.tagName === "TEXTAREA" ? el.value : el.innerText) || "";
    return JSON.stringify({ found: true, text });
  })()`;
  const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return JSON.parse(r.result.value);
}

export async function typeIntoComposer(c, text, b) {
  const expectKey = (text || "").replace(/\s+/g, "");
  const head = expectKey.slice(0, 30);
  const tail = expectKey.slice(-30);
  const expr = `(async () => {
    const el = document.querySelector(${JSON.stringify(b.composer)});
    if (!el) return JSON.stringify({ ok: false, err: "composer not found" });
    el.focus();
    const isTa = el.tagName === "TEXTAREA";
    if (isTa) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, ${JSON.stringify(text)});
    }
    // 页面内回显等待预算 80×100ms=8s，必须 < CDP REQ_TIMEOUT(20s)（R-002 不变量，
    // 见文件头 evalWithBudget 注释）；超预算返回 echoed:false，由 relay 的
    // 点击发送 + verifyClearAfterSend 兜底判定，绝不让 evaluate 撞 CDP 超时。
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 100));
      const raw = (isTa ? el.value : (el.innerText || el.textContent)) || "";
      const key = raw.replace(/\\s+/g, "");
      const lenOk = Math.abs(key.length - ${JSON.stringify(expectKey.length)}) <= Math.max(10, ${JSON.stringify(expectKey.length)} * 0.05);
      if (lenOk && key.includes(${JSON.stringify(head)}) && key.includes(${JSON.stringify(tail)})) {
        return JSON.stringify({ ok: true, echoed: true, len: raw.length });
      }
    }
    const raw2 = (isTa ? el.value : (el.innerText || el.textContent)) || "";
    return JSON.stringify({ ok: true, echoed: false, len: raw2.length });
  })()`;
  let r;
  try {
    r = await evalWithBudget(c, expr);
  } catch (e) {
    return { ok: false, err: "eval hang/budget: " + e.message + "（页面上下文可能损坏，建议换标签）" };
  }
  if (r.exceptionDetails) return { ok: false, err: "type exception: " + r.exceptionDetails.text };
  return JSON.parse(r.result.value);
}

export async function clickSendOnce(c, b) {
  // 静置放在 Node 侧：页面内长挂起的 Promise 会在提交触发的上下文重建中被回收（Promise collected），
  // 导致点击被误判失败；页面内求值必须"点了就返回"。
  const settle = b.preClickSettleMs || 0;
  if (settle > 0) await new Promise((r) => setTimeout(r, settle));
  const expr = `(async () => {
    const t0 = Date.now(); const deadline = t0 + 5000;
    while (Date.now() < deadline) {
      const btn = document.querySelector(${JSON.stringify(b.sendButton)});
      if (btn) {
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") { await new Promise(r => setTimeout(r, 200)); continue; }
        btn.click();
        return JSON.stringify({ ok: true, waitedMs: Date.now() - t0 });
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return JSON.stringify({ ok: false, err: "send button not found within 5s" });
  })()`;
  let r;
  try {
    r = await evalWithBudget(c, expr);
  } catch (e) {
    return { ok: false, err: "eval hang/budget: " + e.message + "（页面上下文可能损坏）" };
  }
  if (r.exceptionDetails) return { ok: false, err: "click exception: " + r.exceptionDetails.text };
  return JSON.parse(r.result.value);
}

export async function detectContextLimit(c, b) {
  const expr = `(() => {
    ${RE_PARSE_HELPER}
    const t = (document.body && document.body.innerText) || "";
    const strong = ${JSON.stringify(b.limitPatterns)};
    const signals = [];
    for (const p of strong) { const re = toRe(p); const m = re ? t.match(re) : null; if (m) signals.push(m[0]); }
    const btnPat = ${JSON.stringify(b.newChatButtonPattern)};
    const btn = btnPat ? [...document.querySelectorAll("button,a")].find((b2) => new RegExp(btnPat, "i").test((b2.innerText || "") + " " + (b2.getAttribute("aria-label") || ""))) : null;
    if (btn) signals.push("button:new-chat");
    return JSON.stringify({ limit: signals.length > 0, strong: signals.length > 0, signals });
  })()`;
  const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return JSON.parse(r.result.value);
}

export async function readNewReply(c, before, b, { pollMs = 1500, timeoutMs = 180000, stableNeed = 3, log = () => {} } = {}) {
  const beforeIds = new Set((before.msgs || []).filter((m) => m.role === "assistant" && m.id).map((m) => m.id));
  // 无稳定 id 的后端（如 DeepSeek 虚拟列表）：按"基线中不存在的回复文本"做差分，
  // 避免虚拟化把旧消息移出 DOM 后位置化 id 错位导致漏检（真实缺陷：误报 REPLY_TIMEOUT）。
  const useTextDiff = !b.assistantIdAttr;
  const beforeTexts = new Set((before.msgs || []).filter((m) => m.role === "assistant").map((m) => m.text));
  const deadline = Date.now() + timeoutMs;
  let lastText = null, stable = 0, lastCount = null;
  while (Date.now() < deadline) {
    let snap = null;
    try { snap = await readConversation(c, readSelOf(b)); } catch (e) { log(`[RELAY] 读取异常: ${e.message}`); }
    if (snap) {
      const newA = (snap.msgs || []).filter((m) => m.role === "assistant" && (useTextDiff ? !beforeTexts.has(m.text) : (m.id && !beforeIds.has(m.id))));
      lastCount = (snap.msgs || []).length;
      if (newA.length > 0) {
        const cand = newA[newA.length - 1];
        const txt = cand.text || "";
        let stop = 0;
        try { const r = await c.send("Runtime.evaluate", { expression: `document.querySelectorAll(${JSON.stringify(b.stopButton)}).length`, returnByValue: true }); stop = r.result.value || 0; } catch {}
        if (txt && txt === lastText && stop === 0) {
          stable++;
          if (stable >= stableNeed) return { ok: true, replyText: txt, replyId: cand.id, afterCount: lastCount };
        } else { stable = 0; }
        lastText = txt;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, reason: "REPLY_TIMEOUT", replyText: lastText, afterCount: lastCount };
}

export { WSClient, readConversation };
