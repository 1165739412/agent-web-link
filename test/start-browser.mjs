// 一键启动带远程调试端口的 Chromium 浏览器（Chrome / Edge / Chromium），并打开目标网页。
// 解决"启动依赖隐式"：浏览器/端口/profile/URL 全部显式化，可被环境变量覆盖。
//
// 用法：
//   node test/start-browser.mjs                     # 默认 9222 + DeepSeek
//   node test/start-browser.mjs --backend chatgpt   # 打开 ChatGPT
//   node test/start-browser.mjs --port 9222 --url https://chat.deepseek.com/
//   AGENT_WEB_LINK_BROWSER="C:\\...\\msedge.exe" node test/start-browser.mjs
//
// 环境变量：AGENT_WEB_LINK_BROWSER（浏览器可执行文件）、AGENT_WEB_LINK_PROFILE（profile 目录）、CDP_PORT
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

const port = parseInt(argOf("--port", process.env.CDP_PORT || "9222"), 10) || 9222;
const cdpHost = `http://127.0.0.1:${port}`;
const backend = argOf("--backend", "deepseek");
const url = argOf("--url", backend === "chatgpt" ? "https://chatgpt.com/" : "https://chat.deepseek.com/");
const profile = argOf("--profile", process.env.AGENT_WEB_LINK_PROFILE || path.join(__dirname, "browser-profile"));
const timeoutMs = parseInt(argOf("--timeout", "25000"), 10) || 25000;

function candidates() {
  const out = [];
  if (process.env.AGENT_WEB_LINK_BROWSER) out.push(process.env.AGENT_WEB_LINK_BROWSER);
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const lad = process.env.LOCALAPPDATA || "";
    out.push(path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
    out.push(path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"));
    out.push(path.join(pf, "Google", "Chrome", "Application", "chrome.exe"));
    out.push(path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"));
    if (lad) out.push(path.join(lad, "Google", "Chrome", "Application", "chrome.exe"));
    out.push(path.join(pf, "Chromium", "Application", "chrome.exe"));
  } else if (process.platform === "darwin") {
    out.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    out.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    out.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    out.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge");
  }
  return out;
}

async function cdpUp() {
  try { const r = await fetch(cdpHost + "/json/version", { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

// 已有实例时通过 CDP 新开标签页（新版 Chrome 要求 PUT）
async function openTab(u) {
  try { await fetch(cdpHost + "/json/new?" + encodeURIComponent(u), { method: "PUT" }); return true; } catch {}
  try { await fetch(cdpHost + "/json/new?" + encodeURIComponent(u)); return true; } catch {}
  return false;
}

if (await cdpUp()) {
  console.log(`[BROWSER] 调试端口已就绪（${cdpHost}），无需重新启动`);
  const ok = await openTab(url);
  console.log(ok ? `[BROWSER] 已打开新标签页 ${url}` : `[BROWSER] 无法自动开标签页，请手动打开 ${url}`);
  console.log("[BROWSER] 请在页面完成登录后运行发送命令。");
  process.exit(0);
}

const exe = candidates().find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!exe) {
  console.error("[BROWSER] 未找到 Chrome / Edge / Chromium。");
  console.error("[BROWSER] 请安装其一，或指定：AGENT_WEB_LINK_BROWSER=<浏览器可执行文件路径> node test/start-browser.mjs");
  process.exit(64);
}

fs.mkdirSync(profile, { recursive: true });
console.log(`[BROWSER] 启动：${exe}`);
console.log(`[BROWSER] CDP=${cdpHost}  profile=${profile}`);
console.log("[BROWSER] 注意：使用独立 profile，首次需在该窗口内登录目标网页。");

const child = spawn(exe, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  url,
], { detached: true, stdio: "ignore" });
child.unref();

const deadline = Date.now() + timeoutMs;
let up = false;
process.stdout.write("[BROWSER] 等待调试端口就绪");
while (Date.now() < deadline) {
  if (await cdpUp()) { up = true; break; }
  process.stdout.write(".");
  await new Promise((r) => setTimeout(r, 500));
}
process.stdout.write("\n");

if (!up) {
  console.error(`[BROWSER] ${timeoutMs}ms 内调试端口未就绪。`);
  console.error("[BROWSER] 常见原因：浏览器启动失败 / 端口被占用 / 需要管理员权限 / 安全软件拦截。");
  process.exit(3);
}
console.log(`[BROWSER] 就绪：${url}`);
console.log("[BROWSER] 下一步：在打开的网页中登录，然后运行：");
console.log("[BROWSER]   DS_CONV=<会话ID> node test/send_to_ds.mjs <消息文件>");
