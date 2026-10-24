// 登录态探测测试（需真实浏览器；无 CDP 时显式 SKIP）。
// 背景缺陷：DeepSeek 首页"未登录也有输入框"，所以 composer=true 不能代表已登录；
// 且"已登录但未开新对话"时 URL 仍是裸域名，靠 URL 里有没有 /a/chat/s/ 也会误判。
// 本测试锁定不变量：loggedIn 必须由"登录提示按钮 / 历史会话链接 / 欢迎回来"三者推导，
// 且与这些信号严格一致。
import assert from "node:assert/strict";
import { WSClient } from "./cdp_ws_client.mjs";
import { detectLoginState, CHATGPT, DEEPSEEK } from "./agent_backends.mjs";

const CDP = "http://127.0.0.1:9222";
const results = [];
let passed = 0;
function record(name, fn) {
  try { fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

let pages = [];
try {
  const list = await (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  pages = (list || []).filter((t) => t && t.type === "page" && /chat\.(deepseek|openai)\.com|chatgpt\.com/.test(t.url || ""));
} catch {}

if (!pages.length) {
  console.log("SKIPPED 未连接聊天页（需 9222 上打开 DeepSeek/ChatGPT）");
  console.log("\n合计: 0/0 通过 (SKIP)");
  process.exit(0);
}

record("L1 登录态字段完整且类型正确", () => {
  // 同步部分：后端必须声明 historyPath（登录判定的依据）
  assert.equal(typeof CHATGPT.historyPath, "string");
  assert.equal(typeof DEEPSEEK.historyPath, "string");
  assert.ok(CHATGPT.historyPath.length > 0 && DEEPSEEK.historyPath.length > 0);
});

for (const p of pages.slice(0, 3)) {
  const backend = /deepseek/.test(p.url || "") ? DEEPSEEK : CHATGPT;
  const c = await WSClient.connect(p.webSocketDebuggerUrl);
  let st;
  try { st = await detectLoginState(c, backend); }
  finally { await c.close("login-state-test"); }

  const tag = (p.url || "").slice(0, 60);
  record(`L2 [${tag}] 登录态与信号严格一致`, () => {
    assert.equal(typeof st.loggedIn, "boolean", "loggedIn 必须是布尔");
    assert.ok(Array.isArray(st.loginPrompt), "loginPrompt 必须是数组");
    assert.ok(Number.isInteger(st.historyLinks), "historyLinks 必须是整数");
    assert.equal(typeof st.welcomeBack, "boolean", "welcomeBack 必须是布尔");
    // 核心不变量：loggedIn 恰等于「无登录提示 且 (有历史链接 或 欢迎回来)」
    const expected = st.loginPrompt.length === 0 && (st.historyLinks > 0 || st.welcomeBack);
    assert.equal(st.loggedIn, expected, `loggedIn 应与信号一致（loginPrompt=${JSON.stringify(st.loginPrompt)} historyLinks=${st.historyLinks} welcomeBack=${st.welcomeBack}）`);
  });

  record(`L3 [${tag}] 有历史会话链接且无登录提示 → 判定已登录`, () => {
    if (st.historyLinks > 0 && st.loginPrompt.length === 0) {
      assert.equal(st.loggedIn, true, "有历史侧栏、无登录按钮应判为已登录");
    }
  });

  record(`L4 [${tag}] 未登录页面必须有登录提示按钮（不能凭空判已登录）`, () => {
    if (st.loggedIn === false) {
      assert.ok(st.loginPrompt.length > 0 || (st.historyLinks === 0 && !st.welcomeBack),
        "判为未登录时，必须确有登录按钮、或既无历史链接也无『欢迎回来』");
    }
  });
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n合计: ${passed}/${results.length} 通过` + (failed ? " (有失败)" : ""));
process.exit(failed ? 1 : 0);
