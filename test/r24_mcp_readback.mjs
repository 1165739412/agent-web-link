// C9-R24-MCP 独立读回：全新进程只读读取指定对话，提取含任务 ID 的报告用户气泡
import { WSClient } from "./cdp_ws_client.mjs";
import { readConversation } from "./read_conversation.mjs";

const CDP = "http://127.0.0.1:9222";
const CONV = process.argv[2] || "6ad8248b";
const taskId = process.argv[3];

const list = await (await fetch(CDP + "/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes(CONV));
if (!page) { console.log("NO_PAGE_FOR " + CONV); process.exit(2); }
const c = await WSClient.connect(page.webSocketDebuggerUrl);
const snap = await readConversation(c);
await c.close("readback-done");

let found = null;
for (const m of snap.msgs) {
  if (m.role !== "user") continue;
  const t = String(m.text || "");
  if (t.includes("AGENT_REPORT_BEGIN") && t.includes(taskId)) {
    const s = t.indexOf("AGENT_REPORT_BEGIN");
    const e = t.indexOf("AGENT_REPORT_END");
    found = t.slice(s, e + "AGENT_REPORT_END".length);
  }
}
let payload = null;
if (found) {
  try { payload = JSON.parse(found.slice("AGENT_REPORT_BEGIN".length, found.indexOf("AGENT_REPORT_END")).trim()); } catch {}
}
console.log("READBACK " + JSON.stringify({
  url: snap.url,
  found: !!found,
  taskId: payload && payload.taskId,
  reportToken: payload && payload.reportToken,
  status: payload && payload.status,
  results: payload && payload.results,
}, null, 2));
