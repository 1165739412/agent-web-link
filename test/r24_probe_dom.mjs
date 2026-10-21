// 只读探针：检查指定对话页面 DOM 是否就绪（不输入、不发送）
import { WSClient } from "./cdp_ws_client.mjs";

const CDP = "http://127.0.0.1:9222";
const CONV = process.argv[2] || "6ad790e5";

const list = await (await fetch(CDP + "/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes(CONV));
if (!page) { console.log("NO_PAGE_FOR " + CONV); process.exit(2); }
const c = await WSClient.connect(page.webSocketDebuggerUrl);

const expr = `(() => {
  const eds = [...document.querySelectorAll('div[contenteditable="true"]')];
  const labels = eds.map(e => e.getAttribute('aria-label'));
  const pt = document.querySelector('#prompt-textarea');
  const lines = (document.body.innerText || "").split("\\n").length;
  return JSON.stringify({
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    editableCount: eds.length,
    editableLabels: labels,
    hasPromptTextarea: !!pt,
    turnCount: document.querySelectorAll('[data-testid="turn"]').length,
    msgCount: document.querySelectorAll('[data-message-author-role]').length,
    stopButtons: document.querySelectorAll('[data-testid="stop-button"]').length,
    bodyLen: (document.body.innerText || "").length,
    lineCount: lines,
    bodyText: (document.body.innerText || "").slice(0, 400)
  });
})()`;

const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
console.log("PROBE=" + (r.result && r.result.value));
await c.close("probe-done");
