// C9-R16 真实 agent 执行 runner：读取任务 drop 文件 → 调用 claude CLI(-p 非交互) → 输出结果
// 用法: node test/agent_dispatch_runner.mjs <taskFile>
// 前置: claude CLI 已登录（交互执行 `claude` 后 /login）；本 runner 不登录、不读取任何令牌/Cookie。
// 安全: 任务内容来自项目内 drop 文件，经 stdin 传入，不做命令行插值；不使用 --dangerously-skip-permissions。
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const taskFile = process.argv[2];
if (!taskFile) { console.error("缺少 taskFile 参数"); process.exit(2); }
let task;
try { task = JSON.parse(fs.readFileSync(taskFile, "utf8")); }
catch (e) { console.error(`读取任务失败: ${e.message}`); process.exit(2); }

const prompt = [
  "你是 . 项目内的编程代理，请只在该项目内操作，简洁报告结果。",
  `taskId: ${task.taskId || ""}`,
  task.summary ? `summary: ${task.summary}` : "",
  task.raw ? `任务原文:\n${task.raw}` : "",
].filter(Boolean).join("\n");

const isWin = process.platform === "win32";
const cmd = isWin ? (process.env.ComSpec || "cmd.exe") : "claude";
const args = isWin
  ? ["/c", "claude", "-p", "--output-format", "text", "--max-turns", "20"]
  : ["-p", "--output-format", "text", "--max-turns", "20"];

const out = spawnSync(cmd, args, { input: prompt, encoding: "utf8", timeout: 600000 });
if (out.stdout) process.stdout.write(out.stdout);
if (out.stderr) process.stderr.write(out.stderr);
if (out.error) { console.error(`启动 claude 失败: ${out.error.message}`); process.exit(3); }
process.exit(out.status ?? 1);
