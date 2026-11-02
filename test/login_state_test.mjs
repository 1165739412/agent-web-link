// 登录态判定测试。
// 背景（真实误报）：DeepSeek 首页"未登录也有输入框"，所以 composer=true ≠ 已登录；
// "已登录但未开新对话"时 URL 仍是裸域名，靠 URL 判断也会错；
// 更关键的是页面刚打开时 SPA 尚未水合（实测 +0ms 时 bodyLen=0、hist=0、composer=N），
// 此时若判成"未登录"就会让用户看到"请登录"的假警告 —— 这是用户实际反馈过的 bug。
//
// 因此：判定逻辑抽成纯函数 decideLoginState 做离线断言（不依赖浏览器），
// 另加可选的实机一致性检查（无聊天页时 SKIP）。
import assert from "node:assert/strict";
import { decideLoginState, CHATGPT, DEEPSEEK } from "./agent_backends.mjs";

const results = [];
let passed = 0;
function record(name, fn) {
  try { fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

// ---------- 离线：判定规则 ----------
record("L1 后端声明了 historyPath（登录判定依据）", () => {
  assert.equal(typeof CHATGPT.historyPath, "string");
  assert.equal(typeof DEEPSEEK.historyPath, "string");
  assert.ok(CHATGPT.historyPath.length > 0 && DEEPSEEK.historyPath.length > 0);
});

record("L2 页面未水合（bodyLen=0 / 无输入框 / 未 complete）→ null，绝不判未登录", () => {
  // 实测 +0ms 的真实信号
  const r = decideLoginState({ settled: false, loginPrompt: [], historyLinks: 0, welcomeBack: false, composer: false, readyState: "interactive", bodyLen: 0 });
  assert.equal(r.loggedIn, null, "未水合时必须是 null（未确定）");
  assert.equal(r.loginReason, "NOT_SETTLED");
});

record("L3 看到登录按钮 → false（唯一能确定未登录的证据）", () => {
  const r = decideLoginState({ settled: true, loginPrompt: ["登录"], historyLinks: 0, welcomeBack: false, composer: true });
  assert.equal(r.loggedIn, false);
  assert.equal(r.loginReason, "LOGIN_PROMPT_VISIBLE");
  // 即使页面未完全稳定，只要明确看到登录按钮也可判 false
  const r2 = decideLoginState({ settled: false, loginPrompt: ["登录 / 注册"], historyLinks: 0, welcomeBack: false });
  assert.equal(r2.loggedIn, false);
});

record("L4 有历史会话链接 → true（已登录但未开对话的主信号）", () => {
  const r = decideLoginState({ settled: true, loginPrompt: [], historyLinks: 100, welcomeBack: false, composer: true });
  assert.equal(r.loggedIn, true);
  assert.equal(r.loginReason, "HISTORY_LINKS");
});

record("L5 有『欢迎回来』→ true（辅助信号，不稳定也要认）", () => {
  const r = decideLoginState({ settled: true, loginPrompt: [], historyLinks: 0, welcomeBack: true, composer: true });
  assert.equal(r.loggedIn, true);
  assert.equal(r.loginReason, "WELCOME_BACK");
});

record("L6 已渲染但无正负信号（全新账号无历史）→ null，不武断判否", () => {
  const r = decideLoginState({ settled: true, loginPrompt: [], historyLinks: 0, welcomeBack: false, composer: true });
  assert.equal(r.loggedIn, null, "无任何信号时应为未确定，而不是未登录");
  assert.equal(r.loginReason, "NO_SIGNAL_SETTLED");
});

record("L7 历史链接存在时，即使页面有杂项文本也不判未登录", () => {
  // 严格整串匹配才进 loginPrompt；这里模拟"登录"只出现在正文/别处（未进 loginPrompt）
  const r = decideLoginState({ settled: true, loginPrompt: [], historyLinks: 42, welcomeBack: false, composer: true, bodyLen: 5000 });
  assert.equal(r.loggedIn, true);
});

record("L8 异常输入安全降级为 null", () => {
  for (const bad of [null, undefined, {}, { loginPrompt: "x", historyLinks: "y" }]) {
    const r = decideLoginState(bad);
    assert.equal(r.loggedIn, null, `异常输入 ${JSON.stringify(bad)} 应为 null`);
  }
});

// ---------- 实机一致性（可选）----------
let pages = [];
try {
  const list = await (await fetch("http://127.0.0.1:9222/json/list", { signal: AbortSignal.timeout(3000) })).json();
  pages = (list || []).filter((t) => t && t.type === "page" && /chat\.(deepseek|openai)\.com|chatgpt\.com/.test(t.url || ""));
} catch {}

if (pages.length) {
  const { WSClient } = await import("./cdp_ws_client.mjs");
  const { detectLoginState } = await import("./agent_backends.mjs");
  const p = pages[0];
  const backend = /deepseek/.test(p.url || "") ? DEEPSEEK : CHATGPT;
  const c = await WSClient.connect(p.webSocketDebuggerUrl);
  let st;
  try { st = await detectLoginState(c, backend); } finally { await c.close("login-state-test"); }
  record("L9 实机：字段完整且判定与信号一致", () => {
    assert.ok(st.loggedIn === true || st.loggedIn === false || st.loggedIn === null, "loggedIn 必须是三态");
    assert.ok(Array.isArray(st.loginPrompt));
    assert.ok(Number.isInteger(st.historyLinks));
    assert.equal(typeof st.settled, "boolean");
    assert.equal(st.loggedIn, decideLoginState(st).loggedIn, "实机结果必须与纯函数判定一致");
  });
  record("L10 实机：有历史链接时必须判已登录（不得误报未登录）", () => {
    if (st.historyLinks > 0) assert.equal(st.loggedIn, true, `historyLinks=${st.historyLinks} 却判 ${st.loggedIn}`);
  });
} else {
  results.push("SKIP L9/L10 未连接聊天页（需 9222 上打开 DeepSeek/ChatGPT）");
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n合计: ${passed}/${results.length} 通过` + (failed ? " (有失败)" : ""));
process.exit(failed ? 1 : 0);
