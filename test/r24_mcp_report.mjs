// C9-R24-MCP 步骤7：将真实执行报告经既有报告通道（makeReportSender/buildReportText）发送至指定 ChatGPT 对话，
// 随后用独立 CDP 连接读回，核对任务 ID、reportToken、正文与 node_check 执行结果。
import fs from "node:fs";
import path from "node:path";
import { WSClient } from "./cdp_ws_client.mjs";
import { makeReportSender, STATE_DIR } from "./collab_once.mjs";
import { readConversation } from "./read_conversation.mjs";

const CDP = "http://127.0.0.1:9222";
const CONV = process.argv[3] || "6ad8248b"; // 指定对话（复用已渲染就绪的会话）
const NAV_URL = process.argv[4] || "https://chatgpt.com/c/6ad8248b-6e50-83ec-b696-8e61f649c84e";
const taskId = process.argv[2];
const result = JSON.parse(fs.readFileSync(path.join("test", "state", "r24mcp_nodecheck.json"), "utf8"));
const { exitCode, stdout, stderr, summary } = result;

const ex = {
  ok: exitCode === 0,
  results: [{ action: { op: "node_check", target: "test/protocol.mjs" }, ok: exitCode === 0, exitCode, reason: exitCode === 0 ? null : `node --check 失败，退出码 ${exitCode}` }],
};

// 确保指定对话已加载为页面；否则把现有页面导航过去，并轮询等待输入框/消息就绪
async function waitForReady(maxMs = 45000) {
  const ts = await (await fetch(CDP + "/json/list")).json();
  const page = ts.find((t) => t.type === "page" && t.url.includes(CONV));
  if (!page) return false;
  const c = await WSClient.connect(page.webSocketDebuggerUrl);
  const deadline = Date.now() + maxMs;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await c.send("Runtime.evaluate", {
        expression: "(()=>{const el=document.querySelector('div[contenteditable=true][aria-label=\"询问 ChatGPT\"]');const msgs=document.querySelectorAll('[data-testid=\"turn\"]').length;return JSON.stringify({el:!!el,msgs});})()",
        returnByValue: true,
      });
      const v = JSON.parse(r.result.value);
      if (v.el) { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  await c.close("x");
  return ready;
}

async function ensureConv() {
  let ts = await (await fetch(CDP + "/json/list")).json();
  let page = ts.find((t) => t.type === "page" && t.url.includes(CONV));
  if (!page) {
    const any = ts.find((t) => t.type === "page");
    const cc = await WSClient.connect(any.webSocketDebuggerUrl);
    await cc.send("Page.navigate", { url: NAV_URL });
    await cc.close("x");
  }
  const ready = await waitForReady();
  console.log("CONV_READY " + ready);
}

const connect = async () => {
  const ts = await (await fetch(CDP + "/json/list")).json();
  const page = ts.find((t) => t.type === "page" && t.url.includes(CONV));
  if (!page) throw new Error("未找到指定对话 " + CONV);
  return WSClient.connect(page.webSocketDebuggerUrl);
};

await ensureConv();
const sendReport = makeReportSender({
  connect,
  stateDir: STATE_DIR,
  outboxDir: path.join(STATE_DIR, "outbox"),
  latestFile: path.join(STATE_DIR, "latest.json"),
  log: (m) => console.log("[REP] " + m),
});
const res = await sendReport({ taskId, ex, summary });
console.log("SEND_RESULT " + JSON.stringify({ ok: res.ok, token: res.token, detail: res.detail }));

// 独立读回
const ts2 = await (await fetch(CDP + "/json/list")).json();
const page2 = ts2.find((t) => t.type === "page" && t.url.includes(CONV));
const c = await WSClient.connect(page2.webSocketDebuggerUrl);
const snap = await readConversation(c);
await c.close("x");
let payload = null;
for (const m of snap.msgs) {
  const t = String(m.text || "");
  const s = t.indexOf("AGENT_REPORT_BEGIN");
  const e = t.indexOf("AGENT_REPORT_END");
  if (s >= 0 && e > s) {
    try {
      const j = JSON.parse(t.slice(s + "AGENT_REPORT_BEGIN".length, e).trim());
      if (j.taskId === taskId) payload = j;
    } catch {}
  }
}
const tokenMatch = payload && payload.reportToken === res.token;
const exitMatch = payload && payload.results && payload.results[0] && payload.results[0].exitCode === exitCode;
console.log("READBACK " + JSON.stringify({ found: !!payload, tokenMatch, exitMatch, reportToken: payload && payload.reportToken, status: payload && payload.status, results: payload && payload.results }));
process.exit(0);
