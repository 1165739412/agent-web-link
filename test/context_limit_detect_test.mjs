// C9 上下文耗尽检测 集成测试（真实 CDP + 隔离标签页，不触碰现有对话/草稿）
import assert from "node:assert/strict";
import { WSClient } from "./cdp_ws_client.mjs";
import { detectContextLimit, isPageReady } from "./relay.mjs";

const CDP = "http://127.0.0.1:9222";
const results = [];
let passed = 0;
async function rec(name, fn) {
  try { await fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}
const dataUrl = (html) => "data:text/html;charset=utf-8," + encodeURIComponent(html);

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
const page = list.find((t) => t.id === targetId || t.targetId === targetId);
if (!page) { console.log("NO_TEST_PAGE"); process.exit(2); }
const c = await WSClient.connect(page.webSocketDebuggerUrl);
const nav = async (html) => { await c.send("Page.navigate", { url: dataUrl(html) }); await new Promise((r) => setTimeout(r, 700)); };

try {
  await nav("<html><body><p>聊天上下文已用完</p><p>在新聊天中继续</p></body></html>");
  const a = await detectContextLimit(c);
  const ra = await isPageReady(c);
  await rec("C1 真实中文耗尽文案 → limit=true 且 ready=false", () => {
    assert.equal(a.limit, true);
    assert.ok(a.signals.some((s) => s.includes("聊天上下文已用完")));
    assert.equal(ra.ready, false);
  });

  await nav("<html><body><p>conversation is too long</p></body></html>");
  const b = await detectContextLimit(c);
  await rec("C2 英文耗尽文案 → limit=true", () => { assert.equal(b.limit, true); });

  await nav('<html><body><p>上下文工程讨论，不是耗尽</p><div contenteditable="true" aria-label="询问 ChatGPT" style="min-height:30px"></div></body></html>');
  const d = await detectContextLimit(c);
  const rd = await isPageReady(c);
  await rec("C3 普通文本含『上下文』不误判；有编辑器 → ready=true", () => {
    assert.equal(d.limit, false, "普通上下文文本不得误判为耗尽");
    assert.equal(rd.ready, true);
  });

  await nav("<html><body><p>empty</p></body></html>");
  const e = await detectContextLimit(c);
  const re = await isPageReady(c);
  await rec("C4 无编辑器空页 → ready=false 且 limit=false", () => {
    assert.equal(e.limit, false);
    assert.equal(re.ready, false);
  });
} finally {
  try { await c.close("detect-test"); } catch {}
  try { await browser.send("Target.closeTarget", { targetId }); } catch {}
  try { await browser.close("detect-test-browser"); } catch {}
}

console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
