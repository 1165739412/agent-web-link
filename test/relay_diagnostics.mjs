// 人可读诊断：把 CDP / 标签页 / 就绪信号翻译成"可直接执行的建议"。
// 设计原则：
//   - 只输出标签页 URL 与后端名，不输出本机绝对路径（避免信息面扩大）；
//   - 不臆测原因：每条 hint 对应一个可用命令或一次可人工验证的动作；
//   - 供 relay --probe 与 send_to_ds 在失败时调用（诊断与发送解耦，绝不因诊断阻塞发送）。
import { WSClient } from "./cdp_ws_client.mjs";
import { isPageReady, detectLoginState } from "./agent_backends.mjs";

export const CDP_DEFAULT = "http://127.0.0.1:9222";

// 失败原因码 → 人话 + 建议。ctx: { cdpHost, replyText }
export function explainReason(reason, ctx = {}) {
  const cdp = ctx.cdpHost || CDP_DEFAULT;
  switch (reason) {
    case "NO_CHATGPT_PAGE":
      return `未发现任何聊天页标签页（ChatGPT/DeepSeek）。先用带远程调试端口的浏览器打开目标网页：node test/start-browser.mjs（CDP=${cdp}）`;
    case "NO_MATCHING_CONVERSATION":
      return `配置里的会话没有对应标签页。请打开该会话，或在 relay.config.json 设置 allowAnyReadyPage=true。`;
    case "CONV_PAGE_NOT_FOUND":
      return `没有包含该会话 ID 的标签页。请在浏览器中打开目标会话（或新建对话后把新会话 ID 传给 DS_CONV），并确认已登录。CDP=${cdp}`;
    case "NO_READY_CONVERSATION":
      return `找到了聊天页但未就绪（未登录 / 仍在加载 / 输入框缺失 / 上下文耗尽）。请人工确认页面可正常输入后重试。`;
    case "NETWORK_UNAVAILABLE":
    case "NETWORK_TYPE_FAILED":
    case "NETWORK_CLICK_FAILED":
    case "NETWORK_REPLY_TIMEOUT":
    case "NETWORK_AND_CONTEXT_LIMIT":
      return `页面处于网络错误 / 离线状态（常见 ERR_INTERNET_DISCONNECTED、错误页）。请恢复网络或刷新页面后重试。`;
    case "CONTEXT_LIMIT":
      return `目标会话上下文已耗尽。请在网页中新建对话（或换一个会话）后重试。`;
    case "TYPE_FAILED":
      return `无法把文本写入输入框（选择器未命中或页面结构变化）。请确认页面类型，或对照 agent_backends.mjs 的选择器。`;
    case "CLICK_NO_EFFECT":
      return `点击发送后输入框未清空，判定未真正提交（防假发送）。请检查发送按钮选择器与页面状态。`;
    case "REPLY_TIMEOUT":
      return `消息已发出，但等待回复超时（可能限流、断网或回复过慢）。${ctx.replyText ? "已捕获部分可见回复（见 replyText）。" : ""}注意：不会自动重发，避免重复消息。`;
    default:
      return ctx.hint || String(reason || "未知错误");
  }
}

export async function cdpInfo(cdpHost = CDP_DEFAULT) {
  try {
    const r = await fetch(String(cdpHost).replace(/\/$/, "") + "/json/version", { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { up: false, error: `HTTP ${r.status}` };
    const v = await r.json();
    return { up: true, browser: v.Browser || "", ws: v.webSocketDebuggerUrl || "" };
  } catch (e) {
    return { up: false, error: e && e.message ? e.message : String(e) };
  }
}

export async function listTabs(cdpHost = CDP_DEFAULT) {
  try {
    const r = await fetch(String(cdpHost).replace(/\/$/, "") + "/json/list", { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, pages: [] };
    const list = await r.json();
    return { ok: true, pages: (list || []).filter((t) => t && t.type === "page") };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), pages: [] };
  }
}

// 探测单个标签页的就绪度 + 登录态；异常安全返回，不抛。
// 登录态必须单独探测：composer 存在 ≠ 已登录（DeepSeek 首页未登录也有输入框）。
export async function probeTab(page, backend) {
  let c = null;
  try {
    c = await WSClient.connect(page.webSocketDebuggerUrl);
    const r = await isPageReady(c, backend);
    let login = null;
    try { login = await detectLoginState(c, backend); } catch (e) { login = { error: e && e.message ? e.message : String(e) }; }
    return { ok: true, ...r, login };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    if (c) { try { await c.close("diag-probe"); } catch {} }
  }
}

// 综合诊断：CDP 可达性 → 聊天页 → 会话命中 → 就绪信号 → hints。
// backends 传 resolveBackends(config) 的结果；convId 传 DS_CONV。
export async function diagnose({ cdpHost = CDP_DEFAULT, backends = [], convId = null, backend = null } = {}) {
  const hints = [];
  const info = await cdpInfo(cdpHost);
  if (!info.up) {
    hints.push(`CDP 不可达（${cdpHost}）：${info.error}`);
    hints.push("→ 启动浏览器：node test/start-browser.mjs（自动探测 Chrome/Edge 并开 9222）");
    return { cdp: info, chatPages: [], convFound: false, hints };
  }
  const tabs = await listTabs(cdpHost);
  if (!tabs.ok) {
    hints.push(`无法列出标签页：${tabs.error}`);
    return { cdp: info, chatPages: [], convFound: false, hints };
  }
  const patterns = (backends || [])
    .map((b) => { try { return { b, rx: new RegExp(b.urlPattern) }; } catch { return null; } })
    .filter(Boolean);
  const chatPages = tabs.pages.filter((p) => patterns.some((x) => x.rx.test(p.url || "")));
  const convFound = convId ? tabs.pages.some((p) => String(p.url || "").includes(convId)) : false;

  if (chatPages.length === 0) {
    hints.push("当前没有打开任何 ChatGPT / DeepSeek 聊天页");
    hints.push("→ 运行 node test/start-browser.mjs 打开目标网页，并完成登录");
    return { cdp: info, chatPages: [], convFound, hints };
  }
  if (convId && !convFound) {
    hints.push(`已打开聊天页，但没有包含会话 ${convId} 的标签页`);
    hints.push("→ 在浏览器里打开该会话（或新建对话后，把新会话 ID 传给 DS_CONV）");
    return { cdp: info, chatPages: chatPages.map((p) => p.url), convFound, hints };
  }

  const target = convId ? tabs.pages.find((p) => String(p.url || "").includes(convId)) : chatPages[0];
  const b = backend || (patterns.find((x) => x.rx.test(target.url || "")) || {}).b || (backends || [])[0];
  let loggedIn = null;
  if (target && b) {
    const pr = await probeTab(target, b);
    if (!pr.ok) hints.push(`探测目标页异常：${pr.error}`);
    else {
      loggedIn = pr.login && pr.login.loggedIn === true;
      const lh = pr.login && pr.login.historyLinks;
      hints.push(`目标页 ${target.url} → composer=${!!pr.composer} limit=${!!pr.limit} loadErr=${!!pr.loadErr} loggedIn=${String(loggedIn)}${Number.isInteger(lh) ? ` historyLinks=${lh}` : ""}`);
      if (loggedIn === false) {
        hints.push("→ **未登录**：该页面有输入框但账号未登录（未登录的 DeepSeek 首页同样有输入框）。请在该浏览器窗口完成登录后重试");
      }
      if (pr.limit) hints.push("→ 上下文已耗尽：请在网页新建对话后重试");
      else if (!pr.composer) hints.push("→ 未找到输入框：可能未登录或仍在加载，请人工确认后重试");
      else if (loggedIn !== false) hints.push("→ 页面就绪，可以发送");
      else hints.push("→ 登录后即可发送（已登录但未开对话也属就绪，发送时会自动进入会话）");
    }
  }
  return { cdp: info, chatPages: chatPages.map((p) => p.url), convFound, loggedIn, hints };
}
