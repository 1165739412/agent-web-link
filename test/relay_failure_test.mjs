// C9 中转失败行为集成测试（真实 CDP + 合成页面，结束后恢复主对话）
// 覆盖：加载失败检测 / 编辑器未就绪 / 无发送按钮发送失败 / 无新回复读回超时
import assert from "node:assert/strict";
import { WSClient } from "./cdp_ws_client.mjs";
import { readConversation } from "./read_conversation.mjs";
import { isPageReady, typeIntoComposer, clickSendOnce, readNewReply, detectNetworkIssue } from "./relay.mjs";

const CDP = "http://127.0.0.1:9222";
const RESTORE = "https://chatgpt.com/c/6ad8248b-6e50-83ec-b696-8e61f649c84e";
const results = [];
let passed = 0;
async function rec(name, fn) {
  try { await fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}
const dataUrl = (html) => "data:text/html;charset=utf-8," + encodeURIComponent(html);
async function nav(c, url, wait = 1200) { await c.send("Page.navigate", { url }); await new Promise((r) => setTimeout(r, wait)); }

// 真实浏览器测试：CDP(9222) 不可用时明确跳过，不伪造通过、不崩溃
let ver = null;
try { ver = await (await fetch(CDP + "/json/version")).json(); }
catch {
  console.log("SKIPPED: CDP_UNAVAILABLE (" + CDP + ") — 需 Chrome 远程调试端口 9222 就绪且已登录 ChatGPT 后重跑");
  console.log("\n合计: 0/0 通过（SKIPPED: CDP_UNAVAILABLE）");
  process.exit(0);
}
const browser = await WSClient.connect(ver.webSocketDebuggerUrl);
const created = await browser.send("Target.createTarget", { url: "about:blank" });
const targetId = created.targetId;
const list = await (await fetch(CDP + "/json/list")).json();
const page = list.find((t) => t.type === "page" && (t.id === targetId || t.targetId === targetId));
if (!page) { console.log("NO_TEST_PAGE"); process.exit(2); }
const c = await WSClient.connect(page.webSocketDebuggerUrl);
try {
  // C1 加载失败
  await nav(c, dataUrl("<html><body>无法加载此 ChatGPT 对话</body></html>"));
  const a = await isPageReady(c);
  await rec("C1 加载失败检测: loadErr=true 且 ready=false", () => { assert.equal(a.loadErr, true); assert.equal(a.ready, false); });

  // C2 编辑器缺失
  await nav(c, dataUrl("<html><body><p>no composer here</p></body></html>"));
  const b = await isPageReady(c);
  await rec("C2 编辑器缺失: composer=false 且 ready=false", () => { assert.equal(b.composer, false); assert.equal(b.ready, false); });

  // C3 有编辑器无发送按钮 → 输入成功但发送失败
  await nav(c, dataUrl('<html><body><div contenteditable="true" aria-label="询问 ChatGPT" style="min-height:40px;border:1px solid #ccc"></div></body></html>'));
  const typed = await typeIntoComposer(c, "hello relay 中文测试");
  await rec("C3 编辑器输入回显成功", () => { assert.equal(typed.ok, true); assert.equal(typed.echoed, true); });
  const clicked = await clickSendOnce(c);
  await rec("C4 无发送按钮 → clickSendOnce ok=false 且不误点", () => { assert.equal(clicked.ok, false); });

  // C5 读回超时
  const before = await readConversation(c).catch(() => ({ msgs: [] }));
  const reply = await readNewReply(c, before, { pollMs: 200, timeoutMs: 1500, stableNeed: 2 });
  await rec("C5 无新回复 → REPLY_TIMEOUT 安全返回", () => { assert.equal(reply.ok, false); assert.equal(reply.reason, "REPLY_TIMEOUT"); });

  // C6 网络错误页
  await nav(c, dataUrl("<html><body><p>网络错误</p><p>连接中断</p></body></html>"));
  const net = await detectNetworkIssue(c);
  await rec("C6 网络错误页 → unavailable=true", () => { assert.equal(net.unavailable, true); });

  // C7 正常页不误判
  await nav(c, dataUrl("<html><body><p>正常页面</p></body></html>"));
  const net2 = await detectNetworkIssue(c);
  await rec("C7 正常页 → unavailable=false（不误判）", () => { assert.equal(net2.unavailable, false); });
} finally {
  try { await c.close("relay-failure-test"); } catch {}
  try { await browser.send("Target.closeTarget", { targetId }); } catch {}
  try { await browser.close("relay-failure-browser"); } catch {}
}

console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);
if (passed !== results.length) process.exitCode = 1;
