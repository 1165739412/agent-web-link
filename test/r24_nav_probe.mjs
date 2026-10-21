// 只读：把唯一页面导航到指定 URL，等待就绪后探测 DOM（不输入、不发送）
import { WSClient } from "./cdp_ws_client.mjs";

const CDP = "http://127.0.0.1:9222";
const url = process.argv[2];
const waitMs = Number(process.argv[3] || 12000);

const list = await (await fetch(CDP + "/json/list")).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(2); }
const c = await WSClient.connect(page.webSocketDebuggerUrl);
await c.send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, waitMs));

const expr = `(() => {
  const eds = [...document.querySelectorAll('div[contenteditable="true"]')];
  const pt = document.querySelector('#prompt-textarea');
  return JSON.stringify({
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    editableCount: eds.length,
    hasPromptTextarea: !!pt,
    turnCount: document.querySelectorAll('[data-testid="turn"]').length,
    msgCount: document.querySelectorAll('[data-message-author-role]').length,
    bodyLen: (document.body.innerText || "").length,
    bodyText: (document.body.innerText || "").slice(0, 300)
  });
})()`;
const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
console.log("PROBE=" + (r.result && r.result.value));
await c.close("nav-probe-done");
