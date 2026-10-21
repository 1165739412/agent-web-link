// 阶段 C2：ChatGPT 回复区 DOM 结构只读诊断
// 用法: node dom_diagnose.mjs
// 只读保证: 仅 Target.getTargetInfo / Page.getLayoutMetrics / Runtime.evaluate(纯查询表达式)
//   表达式中无 click/focus/fill/submit/dispatchEvent，不修改任何页面状态。
//   不访问 iframe target；不读取 Cookie/存储；文本片段截断至 100 字符以内。
import { fileURLToPath } from "node:url";
import { WSClient, errType, initLog, log, WATCHDOG_MS } from "./cdp_ws_client.mjs";

initLog("phaseC2_dom");
const CDP_HOST = "http://127.0.0.1:9222";

// 纯只读 DOM 诊断表达式（无任何副作用调用）
const EXPR_DIAG = `(() => {
  const descEl = (el) => ({
    tag: el.tagName,
    id: el.id || undefined,
    role: el.getAttribute("role") || undefined,
    testId: el.getAttribute("data-testid") || undefined,
    msgRole: el.getAttribute("data-message-author-role") || undefined,
    dataAttrs: [...el.attributes].filter(a => a.name.startsWith("data-")).map(a => a.name).join(","),
    cls: (el.getAttribute("class") || "").split(/\\s+/).filter(Boolean).slice(0, 8).join(" "),
    textLen: (el.innerText || "").length,
    snippet: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 100)
  });
  const q = (s) => document.querySelector(s);
  const qa = (s) => document.querySelectorAll(s).length;
  const res = {
    readyState: document.readyState,
    url: location.href,
    title: document.title,
    docLang: document.documentElement.lang,
    main: null, counts: {}, textAnchors: [], input: {}
  };
  const main = q("main");
  if (main) res.main = { childCount: main.children.length, textLen: (main.innerText || "").length };
  res.counts = {
    roleAny: qa("[data-message-author-role]"),
    roleA: qa('[data-message-author-role="assistant"]'),
    roleU: qa('[data-message-author-role="user"]'),
    msgId: qa("[data-message-id]"),
    article: qa("article"),
    turnTest: qa("[data-testid^='conversation-turn']"),
    md: qa(".markdown"),
    mdAny: qa("[class*='markdown']"),
    groupRole: qa("[role='group']"),
    listRole: qa("[role='listitem']"),
    userBubble: qa("[data-user-message-bubble]"),
    dilMsgId: qa("[data-dil-message-id]"),
    dilSourceId: qa("[data-dil-source-message-id]"),
    dilRenderer: qa("[class*='DilRenderer']"),
    markdownRoot: qa("[class*='MarkdownRoot']"),
    textFlow: qa("[data-d-text-flow]")
  };
  let shadowCount = 0;
  for (const e of document.querySelectorAll("*")) if (e.shadowRoot) shadowCount++;
  res.counts.shadowHosts = shadowCount;
  // 文本锚点: 仅在测试对话内查找测试关键词，最多 3 个命中
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n, hits = [];
  while ((n = walker.nextNode())) {
    if ((n.textContent || "").includes("通信测试")) { hits.push(n.parentElement); if (hits.length >= 3) break; }
  }
  res.textAnchors = hits.map(el => ({
    self: descEl(el),
    chainUp: (() => { const out = []; let p = el.parentElement;
      for (let i = 0; i < 6 && p && p !== document.body; i++) { out.push(descEl(p)); p = p.parentElement; }
      return out; })()
  }));
  // 输入区定位（只检查存在性，不聚焦、不读内容）
  res.input = {
    contentEditable: qa("[contenteditable='true']"),
    promptTextarea: !!q("#prompt-textarea"),
    testIdPrompt: !!q("[data-testid='prompt-textarea']"),
    sendButton: !!q("[data-testid='send-button']")
  };
  return JSON.stringify(res);
})()`;

async function main() {
  log(`脚本=${fileURLToPath(import.meta.url)} node=${process.version} 启动=${new Date().toISOString()}`);

  // 步骤 B-1: 协议层只读验证
  const targets = await (await fetch(`${CDP_HOST}/json/list`)).json();
  const page = targets.find((t) => t.type === "page" && /chatgpt\.com/.test(t.url));
  if (!page) throw errType("NoChatgptPage");
  log(`[TARGET] id=${page.id} title="${page.title}" url=${page.url}`);

  const c = await WSClient.connect(page.webSocketDebuggerUrl);
  try {
    const info = await c.send("Target.getTargetInfo", { targetId: page.id });
    log(`[PROTO] Target.getTargetInfo ok title="${info.targetInfo.title}"`);
    const layout = await c.send("Page.getLayoutMetrics", {});
    const cw = layout.cssContentSize || layout.contentSize;
    log(`[PROTO] Page.getLayoutMetrics ok size=${cw ? cw.width + "x" + cw.height : "n/a"}`);

    // 步骤 C: 只读 DOM 诊断（协议层已通才执行）
    const dom = JSON.parse(await c.send("Runtime.evaluate", {
      expression: EXPR_DIAG, returnByValue: true,
    }).then((r) => {
      if (r.exceptionDetails) throw new Error(`诊断表达式异常: ${r.exceptionDetails.text}`);
      return r.result.value;
    }));
    log(`[DIAG] ${JSON.stringify(dom, null, 1)}`);
    log("[DONE] 诊断完成，走 finally 清理后自然退出");
    process.exitCode = 0;
  } finally {
    const ok = await c.close("normal-after-diagnosis");
    if (!ok) { log("[FAIL] 清理未确认关闭"); process.exitCode = 21; }
  }
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
