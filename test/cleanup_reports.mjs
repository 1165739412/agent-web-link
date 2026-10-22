// 报告清理（默认 dry-run）：按项目清理旧报告文件，并把登记簿的 reportFile/reportToken 置空（保留任务记录）。
// 安全约束：只删除「登记簿记录、且位于项目 tasksDir 之内」的报告文件；绝不删除登记簿或业务文件。
//
// 用法：
//   npm run cleanup:reports -- --project example-project                        # 预览（dry-run）
//   npm run cleanup:reports -- --project example-project --before 2026-10-01T00:00:00Z --yes
//   npm run cleanup:reports -- --project example-project --keep 20 --yes        # 保留最新 20 份
import fs from "node:fs";
import path from "node:path";
import { createTaskService, DEFAULT_PROJECTS_FILE, DEFAULT_TOKEN_FILE } from "./local_service.mjs";
import { loadRegistry, saveRegistry } from "./task_store.mjs";

const USAGE = `用法: node test/cleanup_reports.mjs --project <name> [--projects <file>] [--before <ISO>] [--keep N] [--yes]

  --project   必填：要清理的已注册项目名
  --projects  项目注册表（默认 test/projects.json）
  --before    只清理 finishedAt/createdAt 早于该 ISO 时间的报告
  --keep N    保留最新 N 份（其余进入候选）
  --yes       真正删除（默认 dry-run 仅列出）
  -h,--help   显示帮助

安全: 只删除登记簿记录且位于项目 tasksDir 内的报告文件；不删除登记簿/业务文件。`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(0); }
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const project = argOf("--project", null);
if (!project) { console.error("缺少 --project <name>（用 --help 查看用法）"); process.exit(64); }
const projectsFile = argOf("--projects", DEFAULT_PROJECTS_FILE);
const before = argOf("--before", null);
const keep = Math.max(0, parseInt(argOf("--keep", "0"), 10) || 0);
const yes = has("--yes");

let svc, cfg;
try {
  svc = createTaskService({ projectsFile, tokenFile: process.env.TOKEN_FILE || DEFAULT_TOKEN_FILE, log: () => {} });
  cfg = svc.projectConfig(project);
} catch (e) {
  console.error(`加载项目失败: ${e.message}`);
  process.exit(64);
}
if (!cfg) { console.error(`项目未注册或配置未加载: ${project}`); process.exit(64); }

const reg = loadRegistry(cfg.registryFile);
if (reg.ok === false) { console.error(`登记簿损坏: ${reg.error}`); process.exit(1); }

const tasksReal = (() => {
  try {
    const rp = fs.realpathSync.native ? fs.realpathSync.native(path.resolve(cfg.tasksDir)) : fs.realpathSync(path.resolve(cfg.tasksDir));
    return rp + path.sep;
  } catch { return path.resolve(cfg.tasksDir) + path.sep; }
})();
let targets = reg.tasks
  .filter((t) => t.reportFile)
  .sort((a, b) => String(b.finishedAt || b.createdAt || "").localeCompare(String(a.finishedAt || a.createdAt || "")));
if (keep > 0) targets = targets.slice(keep);
if (before) targets = targets.filter((t) => String(t.finishedAt || t.createdAt || "") < before);

if (targets.length === 0) { console.log(`项目 ${project}：没有需要清理的报告（候选 0）。`); process.exit(0); }

console.log(`${yes ? "将删除" : "候选（dry-run）"} ${targets.length} 份报告：`);
let removed = 0, skipped = 0;
for (const t of targets) {
  const abs = path.resolve(t.reportFile);
  let real = null, isFile = false;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
    isFile = fs.statSync(real).isFile();
  } catch { real = null; }
  // 符号链接解析后再做前缀比较，且必须带路径分隔符（DS 评审 BLOCKER B2）
  const inside = !!real && isFile && real.toLowerCase().startsWith(tasksReal.toLowerCase());
  console.log(`  - ${t.taskId}  ${t.phase || "-"}  ${t.finishedAt || t.createdAt || "-"}  ${inside ? real : "(越界/非文件，跳过)"}`);
  if (!inside) { skipped++; continue; }
  if (yes) {
    try { if (fs.existsSync(abs)) fs.rmSync(abs, { force: true }); } catch (e) { console.error(`    删除失败: ${e.message}`); skipped++; continue; }
    t.reportFile = null;
    t.reportToken = null;
    removed++;
  }
}

if (yes) {
  saveRegistry(cfg.registryFile, reg);
  console.log(`完成：删除 ${removed} 份，跳过 ${skipped} 份；登记簿已更新（任务记录保留）。`);
} else {
  console.log("（dry-run）加 --yes 才会真正删除。");
}
