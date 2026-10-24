// 一键启动带远程调试端口的 Chromium（Chrome / Edge / Chromium），并打开目标网页。
// 供 MCP 工具 agent_link_browser_open 与脚本 start-browser.mjs 复用。
// 设计：只负责"把浏览器以 9222 调试端口拉起并打开 URL"；登录由用户在页面内完成。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CDP_DEFAULT = "http://127.0.0.1:9222";

export function listBrowserCandidates(platform = process.platform, env = process.env) {
  const out = [];
  if (env.AGENT_WEB_LINK_BROWSER) out.push(env.AGENT_WEB_LINK_BROWSER);
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const lad = env.LOCALAPPDATA || "";
    out.push(path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
    out.push(path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"));
    out.push(path.join(pf, "Google", "Chrome", "Application", "chrome.exe"));
    out.push(path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"));
    if (lad) out.push(path.join(lad, "Google", "Chrome", "Application", "chrome.exe"));
    out.push(path.join(pf, "Chromium", "Application", "chrome.exe"));
  } else if (platform === "darwin") {
    out.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    out.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    out.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    out.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge");
  }
  return out;
}

export async function cdpUp(cdpHost = CDP_DEFAULT, timeoutMs = 1500) {
  try {
    const r = await fetch(String(cdpHost).replace(/\/$/, "") + "/json/version", { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

// 已有实例时通过 CDP 新开标签页（新版 Chrome 要求 PUT）
export async function openTab(cdpHost, u) {
  try { await fetch(cdpHost + "/json/new?" + encodeURIComponent(u), { method: "PUT" }); return true; } catch {}
  try { await fetch(cdpHost + "/json/new?" + encodeURIComponent(u)); return true; } catch {}
  return false;
}

// 返回结构化结果（供 MCP 工具直接使用），不直接打印。
// opts.strict + opts.expectPid：私有通道（非 default）只允许附着于"本通道此前拉起的实例"，
// 避免端口被别的浏览器/服务占用时悄悄连上别人的窗口（DS 评审 P0-2）。
export async function launchBrowser(opts = {}) {
  const port = parseInt(opts.port ?? process.env.CDP_PORT ?? "9222", 10) || 9222;
  const cdpHost = `http://127.0.0.1:${port}`;
  const backend = opts.backend || "deepseek";
  const url = opts.url || (backend === "chatgpt" ? "https://chatgpt.com/" : "https://chat.deepseek.com/");
  const profile = opts.profile || process.env.AGENT_WEB_LINK_PROFILE || path.join(__dirname, "browser-profile");
  const timeoutMs = parseInt(opts.timeoutMs ?? "25000", 10) || 25000;
  const strict = opts.strict === true;
  const expectPid = Number.isInteger(opts.expectPid) ? opts.expectPid : null;

  if (await cdpUp(cdpHost)) {
    if (strict && !(expectPid && isPidAlive(expectPid))) {
      return {
        ok: false, alreadyUp: true, reason: "PORT_OCCUPIED", cdpHost, url, port,
        hint: `端口 ${port} 已被其他程序/浏览器占用，且不是本通道此前拉起的实例；私有通道不会附着到别人的浏览器。请换一个 lane 名，或先结束占用 ${port} 的程序。`,
      };
    }
    const opened = await openTab(cdpHost, url);
    return {
      ok: true, alreadyUp: true, cdpHost, url, openedTab: opened, attached: true,
      hint: opened ? `已打开新标签页 ${url}` : `无法自动开标签页，请手动打开 ${url}；请在页面完成登录后发送。`,
    };
  }
  const exe = listBrowserCandidates().find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!exe) {
    return {
      ok: false, alreadyUp: false, cdpHost, url,
      hint: "未找到 Chrome/Edge/Chromium。请安装其一，或指定 AGENT_WEB_LINK_BROWSER=<浏览器可执行文件> 后重试。",
    };
  }
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    url,
  ], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = Number.isInteger(child.pid) ? child.pid : null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpUp(cdpHost)) {
      return {
        ok: true, alreadyUp: false, cdpHost, url, profile, pid,
        hint: `已启动 ${exe} 并打开 ${url}；请在网页中登录后再发送。`,
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    ok: false, alreadyUp: false, cdpHost, url,
    hint: `${timeoutMs}ms 内调试端口未就绪。常见原因：浏览器启动失败 / 端口被占用 / 需要管理员权限 / 安全软件拦截。`,
  };
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// CLI 模式：被 MCP 工具 agent_link_browser_open 以子进程调用，仅输出 JSON（供解析）。
const __isMainBL = process.argv[1]
  && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (__isMainBL) {
  const a = process.argv.slice(2);
  const get = (n, d) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const r = await launchBrowser({
    backend: get("--backend", "deepseek"),
    url: get("--url", null),
    port: get("--port", null),
    profile: get("--profile", null),
    timeoutMs: get("--timeout", "25000"),
    strict: a.includes("--strict"),
    expectPid: (() => { const i = a.indexOf("--expect-pid"); return i >= 0 && a[i + 1] ? Number(a[i + 1]) : null; })(),
  });
  process.stdout.write(JSON.stringify(r));
}
