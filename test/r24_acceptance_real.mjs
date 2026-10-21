// C9-R24 有界实机验收（一）：真实浏览器读回 + 修复后真实 processConversation 分类
// 用途：把昨天 R24 事故会话（6ad790e5）里 ChatGPT 的真实回复，喂给修复后的真实协调器逻辑，
// 验证纯文本 NEEDS_USER_INPUT、退化块等是否被正确分类（暂停而非失控）。
// 非变异：executor 与 sendReport 均为桩（只记录不执行/不发送），registry 用临时文件，不改原始证据。
import os from "node:os";
import path from "node:path";
import { WSClient } from "./cdp_ws_client.mjs";
import { readConversation } from "./read_conversation.mjs";
import { processConversation } from "./collab_once.mjs";

const CDP = "http://127.0.0.1:9222";
const regFile = path.join(os.tmpdir(), `r24acc-reg-${Date.now()}.json`);

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && /chatgpt\.com/.test(t.url) && t.url.includes("6ad790e5"));
if (!page) { console.log("NO_TARGET"); process.exit(2); }

const c = await WSClient.connect(page.webSocketDebuggerUrl);
const snap = await readConversation(c);
await c.close("normal");

// 非变异桩：绝不真实执行动作、绝不真实回传 ChatGPT
const executor = { executeActions: (actions) => ({ ok: true, results: (actions || []).map((a) => ({ action: a, ok: true, exitCode: 0, reason: null })) }) };
const sent = [];
const sendReport = async (rep) => { sent.push(rep); return { ok: true, token: `MOCK-${rep.taskId}`, reply: null, detail: "mock(no real send)" }; };

const out = await processConversation({ messages: snap.msgs, latestRegionText: snap.latestRegion, registryFile: regFile, executor, sendReport, log: () => {} });

console.log("REAL_CLASSIFY_RESULT " + JSON.stringify({
  target: page.url,
  msgs: snap.msgs.length,
  executed: out.executed.map((e) => e.taskId),
  registeredOnly: (out.registeredOnly || []).map((e) => e.taskId),
  needsInput: out.needsInput,
  stopped: out.stopped,
  completed: out.completed,
  protocolErrors: out.protocolErrors.length,
  skipped: out.skipped,
  sentReports: sent.map((s) => s.taskId),
}, null, 2));
