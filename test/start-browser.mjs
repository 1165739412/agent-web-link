// 一键启动带远程调试端口的 Chromium（Chrome / Edge / Chromium），并打开目标网页。
// 复用 browser_launcher.mjs，保持命令行入口不变。
//
// 用法：
//   node test/start-browser.mjs                     # 默认 9222 + DeepSeek
//   node test/start-browser.mjs --backend chatgpt   # 打开 ChatGPT
//   node test/start-browser.mjs --port 9222 --url https://chat.deepseek.com/
//   AGENT_WEB_LINK_BROWSER="C:\\...\\msedge.exe" node test/start-browser.mjs
//
// 环境变量：AGENT_WEB_LINK_BROWSER（浏览器可执行文件）、AGENT_WEB_LINK_PROFILE（profile 目录）、CDP_PORT
import { launchBrowser } from "./browser_launcher.mjs";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`用法: node test/start-browser.mjs [--backend deepseek|chatgpt] [--port 9222] [--url <url>] [--profile <dir>] [--timeout <ms>]

  --backend     默认打开的网站（deepseek|chatgpt，默认 deepseek）
  --port        CDP 端口（默认 9222，或环境变量 CDP_PORT）
  --url         覆盖要打开的 URL
  --profile     独立浏览器 profile 目录（默认 test/browser-profile，已 gitignore）
  --timeout     等待 CDP 就绪的上限毫秒（默认 25000）
  -h, --help    显示本帮助

环境变量: AGENT_WEB_LINK_BROWSER（浏览器可执行文件）、AGENT_WEB_LINK_PROFILE、CDP_PORT`);
  process.exit(0);
}
const argOf = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

const r = await launchBrowser({
  backend: argOf("--backend", "deepseek"),
  port: argOf("--port", process.env.CDP_PORT || "9222"),
  url: argOf("--url", null),
  profile: argOf("--profile", null),
  timeoutMs: argOf("--timeout", "25000"),
});

console.log(`[BROWSER] cdp=${r.cdpHost} url=${r.url}`);
console.log(`[BROWSER] ${r.hint}`);
if (r.ok && r.alreadyUp) console.log("[BROWSER] 调试端口已就绪，请确认页面已登录，然后运行发送命令。");
if (r.ok && !r.alreadyUp) console.log("[BROWSER] 下一步：在打开的网页中登录，然后运行：\n  DS_CONV=<会话ID> node test/send_to_ds.mjs <消息文件>");
process.exit(r.ok ? 0 : 3);
