// C9 对话读取器：只读读取专用 Edge 中当前 ChatGPT 对话的消息列表
// 用法:
//   import { readConversation } from "./read_conversation.mjs"   // 供编排器复用
//   node read_conversation.mjs                                   // CLI：输出 JSON 到 stdout
// 只读保证: 仅 Runtime.evaluate 纯查询，无输入/点击/导航；不读取 Cookie/存储。
// 用户消息无服务端 id → 以 (role, hash) 作为签名参与差分；助手消息以 data-dil-message-id 为 id。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WSClient, errType, initLog, log, WATCHDOG_MS } from "./cdp_ws_client.mjs";

initLog("phaseC9_read");
const CDP_HOST = "http://127.0.0.1:9222";

// C9-R6 实机缺陷修复: 助手消息文本截断 4000 → 12000。
// R6 任务块所在消息长 5809 字符，4000 截断会丢失 AGENT_TASK_END → 解析为 incomplete → 任务无法发现。
// 任务块可能较长（含 echo/验收标准），截断上限须显著大于典型任务块；仍保留有界上限避免 CDP 载荷失控。
export const TEXT_CAP = 12000;

// ChatGPT 默认读取选择集（与 agent_backends 的 CHATGPT 保持一致）
export const CHATGPT_READ_SEL = {
  user: "[data-user-message-bubble]",
  assistant: "[data-dil-message-id]",
  assistantIdAttr: "data-dil-message-id",
  regionMarker: "最新一条回复",
};

// 根据选择器集动态构造读取表达式（支持不同网页后端）
export function buildReadExpr(sel) {
  const s = sel || CHATGPT_READ_SEL;
  return `(() => {
  const san = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const hash = (t) => [...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  // C9-R16 修复: ChatGPT SPA 在切换会话时，会把上一个会话的消息节点以隐藏方式(display:none/高度0)残留在 DOM，
  // 旧的全局 querySelectorAll 会把这些隐藏残留也读进来，污染当前会话（表现为"聊天干扰读取"）。
  // 只保留"可见"消息节点（offsetParent 非空且渲染高度>0），确保只读当前活动会话。
  const isVisible = (el) => {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return !r || r.height > 0;
  };
  const users = [...document.querySelectorAll(${JSON.stringify(s.user)})].filter(isVisible).map((el, i) => {
    const t = san(el.innerText);
    return { role: "user", id: null, uid: "u" + i, len: t.length, hash: hash(t), text: t.slice(0, 2000) };
  });
  const assistants = [...document.querySelectorAll(${JSON.stringify(s.assistant)})].filter(isVisible).map((el, i) => {
    const t = san(el.innerText);
    const idAttr = ${JSON.stringify(s.assistantIdAttr)};
    // 无稳定 id 属性的后端（如 DeepSeek）回退为位置化 id，保证 readNewReply 的新消息差分可用
    return { role: "assistant", id: (idAttr && el.getAttribute(idAttr)) || ("a" + i), len: t.length, hash: hash(t), text: t.slice(0, ${TEXT_CAP}) };
  });
  // “最新一条回复”区域（C9）: 最新回复可能渲染在该区域而非历史消息容器中
  const regionText = (() => {
    const marker = ${JSON.stringify(s.regionMarker || "")};
    if (!marker) return null;
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n2;
    while ((n2 = w2.nextNode())) {
      if ((n2.textContent || "").trim() === marker) {
        const p = n2.parentElement && n2.parentElement.parentElement;
        if (p) return (p.innerText || "").replace(new RegExp("^" + marker + "\\\\s*"), "").slice(0, ${TEXT_CAP});
      }
    }
    return null;
  })();
  return JSON.stringify({ ts: Date.now(), url: location.href, latestRegion: regionText, msgs: [...users, ...assistants] });
})()`;
}

// cdp: 已连接的 CDP WSClient（由调用方管理连接生命周期）
// sel: 可选的后端读取选择集（默认 ChatGPT）。不同网页后端传入各自 user/assistant 选择器。
export async function readConversation(cdp, sel) {
  const expr = buildReadExpr(sel);
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error("对话读取表达式异常: " + r.exceptionDetails.text);
  return JSON.parse(r.result.value);
}

async function main() {
  const targets = await (await fetch(`${CDP_HOST}/json/list`)).json();
  const page = targets.find((t) => t.type === "page" && /chatgpt\.com/.test(t.url));
  if (!page) throw errType("NoChatgptPage");
  log(`[TARGET] id=${page.id} title="${page.title}"`);
  const c = await WSClient.connect(page.webSocketDebuggerUrl);
  try {
    const snap = await readConversation(c);
    console.log(JSON.stringify(snap, null, 1));
    log(`[DONE] msgs=${snap.msgs.length}`);
  } finally {
    const ok = await c.close("normal-after-read");
    if (!ok) { log("[FAIL] 清理未确认关闭"); process.exitCode = 21; }
  }
}

const __isMain = process.argv[1]
  && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (__isMain) {
  const watchdog = setTimeout(() => { log("[WATCHDOG] 超时"); process.exit(8); }, WATCHDOG_MS);
  main().catch((e) => { log(`[ERROR] ${e.message}`); process.exitCode = 3; })
    .finally(() => { clearTimeout(watchdog); });
}
