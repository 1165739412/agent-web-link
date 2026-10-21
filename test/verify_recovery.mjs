// C9 只读验证：新对话是否收到原报告（hash）与是否产生决策
import { WSClient } from "./cdp_ws_client.mjs";
import { readConversation } from "./read_conversation.mjs";
import { parseDecision } from "./auto_loop.mjs";

const CDP = "http://127.0.0.1:9222";
const convId = process.argv[2];
const hash = process.argv[3];
if (!convId || !hash) { console.log("USAGE: node verify_recovery.mjs <convId> <hash>"); process.exit(64); }
const list = await (await fetch(CDP + "/json/list")).json();
const page = list.find((t) => t.type === "page" && String(t.url || "").includes(convId));
if (!page) { console.log("VERIFY " + JSON.stringify({ foundPage: false, convId })); process.exit(2); }
const c = await WSClient.connect(page.webSocketDebuggerUrl);
let snap;
try { snap = await readConversation(c); } finally { await c.close("verify"); }
const userHasHash = (snap.msgs || []).some((m) => m.role === "user" && String(m.text || "").includes(hash));
const lastA = (snap.msgs || []).filter((m) => m.role === "assistant").slice(-1)[0];
const decision = parseDecision(lastA ? lastA.text : "");
console.log("VERIFY " + JSON.stringify({
  convId,
  url: snap.url,
  msgCount: (snap.msgs || []).length,
  userHasHash,
  assistantFound: !!lastA,
  decision: decision.decision,
  nextAction: decision.nextAction,
  assistantHead: lastA ? String(lastA.text).slice(0, 200) : null,
}, null, 2));
