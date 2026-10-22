// 项目自注册：为新项目生成最小配置（.agent-link/project.config.json）并登记到 projects.json。
// 这是**本地 CLI**（人手执行），刻意不暴露为 MCP 工具——否则等于允许 Agent 自己注册任意路径，破坏白名单边界。
//
// 在目标项目根目录执行：
//   node <agent-web-link>/test/register_project.mjs --name my-project
// 或显式指定：
//   node test/register_project.mjs --name my-project --root "D:/work/my-project" --projects test/projects.json
//
// 选项：--force（覆盖已有配置/条目）、--dry-run（只打印）、--emit-report <file>（生成脱敏复核报告）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECTS_FILE, loadProjectsRegistry } from "./local_service.mjs";
import { validateProjectConfig } from "./project_config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// L2：原子写（临时文件 + rename），防并发注册损坏
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

const USAGE = `用法: node test/register_project.mjs --name <name> [--root <dir>] [--config <file>] [--projects <file>]
       [--force] [--dry-run] [--emit-report <file>]

  --name         必填：项目名（字母/数字/._-，1-64 字符）
  --root         项目根目录（默认当前目录）
  --config       配置文件路径（默认 <root>/.agent-link/project.config.json）
  --projects     项目注册表（默认 agent-web-link/test/projects.json）
  --force        覆盖已存在的配置/同名条目（默认拒绝）
  --dry-run      只打印将要做的修改，不写盘
  --emit-report  生成脱敏复核报告（不含绝对路径），可直接用 send_to_ds 发给 DS 复核
  -h,--help      显示帮助

行为:
  - 生成最小配置（projectTests 为空、agentCommand=null、状态/任务目录在项目内 .agent-link 下）；
  - 幂等：同名且配置路径一致时不动；同名但不同则需 --force；
  - 写前用 validateProjectConfig 校验，写后用 loadProjectsRegistry 复验。`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(0); }
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const name = argOf("--name", null);
if (!name) { console.error("缺少 --name <name>（用 --help 查看用法）"); process.exit(64); }
if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
  console.error(`项目名非法: ${name}（仅允许字母/数字/._-，1-64 字符）`);
  process.exit(64);
}

const root = path.resolve(argOf("--root", process.cwd()));
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`项目根目录不存在或不是目录: ${root}`);
  process.exit(64);
}
const cfgPath = path.resolve(argOf("--config", path.join(root, ".agent-link", "project.config.json")));
const projectsFile = path.resolve(argOf("--projects", DEFAULT_PROJECTS_FILE));
const force = has("--force");
const dryRun = has("--dry-run");
const emitReport = argOf("--emit-report", null);

// 1) 生成并校验最小配置
const cfg = {
  schemaVersion: 1,
  name,
  projectRoot: root,
  projectTests: [],
  agentCommand: null,
  paths: { stateDir: ".agent-link/state", tasksDir: ".agent-link/tasks" },
};
const v = validateProjectConfig(cfg, { configPath: cfgPath });
if (!v.ok) {
  console.error("配置校验失败（这是程序错误，请反馈）:\n" + (v.errors || []).join("\n"));
  process.exit(1);
}

// 2) 检查已有配置
if (fs.existsSync(cfgPath) && !force) {
  let same = false;
  try { same = JSON.stringify(JSON.parse(fs.readFileSync(cfgPath, "utf8"))) === JSON.stringify(cfg); } catch {}
  if (!same) {
    console.error(`配置已存在且内容不同: ${cfgPath}`);
    console.error("如需覆盖，请加 --force（会覆盖该配置文件）。");
    process.exit(1);
  }
}

// 3) 读取/初始化注册表
let registry = { schemaVersion: 1, projects: [] };
if (fs.existsSync(projectsFile)) {
  try {
    registry = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
    if (!registry || !Array.isArray(registry.projects)) registry = { schemaVersion: 1, projects: [] };
  } catch (e) {
    console.error(`注册表不是合法 JSON: ${projectsFile}（${e.message}）`);
    process.exit(1);
  }
}
const baseDir = path.dirname(projectsFile);
const toStored = (p) => {
  const rel = path.relative(baseDir, p);
  return (!rel || path.isAbsolute(rel)) ? path.resolve(p).split(path.sep).join("/") : rel.split(path.sep).join("/");
};
const storedCfg = toStored(cfgPath);
const samePath = (a) => path.resolve(baseDir, String(a || "")).toLowerCase() === cfgPath.toLowerCase();

const existingIdx = registry.projects.findIndex((p) => p && p.name === name);
const already = existingIdx >= 0 && samePath(registry.projects[existingIdx].config);

if (already && !force) {
  console.log(`项目 ${name} 已注册且配置一致，无需重复注册。`);
  console.log(`  配置: ${cfgPath}`);
  console.log(`  注册表: ${projectsFile}`);
} else {
  if (existingIdx >= 0 && force) {
    // L2：覆盖前打印关键字段 diff
    try {
      const oldPath = path.resolve(baseDir, registry.projects[existingIdx].config);
      const oldCfg = JSON.parse(fs.readFileSync(oldPath, "utf8"));
      console.log("覆盖前 diff：");
      for (const k of ["name", "projectRoot", "paths"]) {
        const o = JSON.stringify(oldCfg[k]);
        const n = JSON.stringify(cfg[k]);
        if (o !== n) console.log(`  ${k}: ${o} → ${n}`);
      }
    } catch {}
  }
  if (existingIdx >= 0) {
    if (!force) {
      console.error(`注册表中已有同名项目 ${name}，但配置路径不同: ${registry.projects[existingIdx].config}`);
      console.error("如需替换，请加 --force。");
      process.exit(1);
    }
    registry.projects[existingIdx] = { name, config: storedCfg };
  } else {
    registry.projects.push({ name, config: storedCfg });
  }

  if (dryRun) {
    console.log(`[dry-run] 将写入配置: ${cfgPath}`);
    console.log(`[dry-run] 将登记项目: ${name} → ${storedCfg}`);
  } else {
    writeAtomic(cfgPath, JSON.stringify(cfg, null, 2));
    writeAtomic(projectsFile, JSON.stringify(registry, null, 2));
    // M6：注册审计（append-only）
    try {
      const adir = path.join(path.dirname(projectsFile), "state");
      fs.mkdirSync(adir, { recursive: true });
      fs.appendFileSync(path.join(adir, "audit.log"), JSON.stringify({ at: new Date().toISOString(), action: "register", project: name, config: storedCfg }) + "\n", "utf8");
    } catch {}
    console.log(`已写入配置: ${cfgPath}`);
    console.log(`已登记项目: ${name} → ${storedCfg}`);
  }
}

// 4) 写后复验（dry-run 时只校验将要写入的配置，不动注册表）
if (!dryRun) {
  const r = loadProjectsRegistry(projectsFile);
  const err = r.projectErrors && r.projectErrors[name];
  if (!r.ok || err || !r.projects.has(name)) {
    console.error("注册后复验失败：");
    console.error(`  registry.ok=${r.ok}  loaded=${r.ok ? r.projects.has(name) : false}  error=${err || "-"}`);
    if (!r.ok) console.error("  " + (r.errors || []).join("\n  "));
    process.exit(1);
  }
  console.log(`复验通过：项目 ${name} 可被服务/ MCP 加载。`);
}

// 5) 下一步 + 可选脱敏复核报告
console.log("\n下一步：");
console.log(`  # 启动服务（只登记不执行可加 --queue-only）`);
console.log(`  node test/local_service.mjs --projects "${projectsFile}" --port 8787`);
console.log(`  # 或注册到 MCP 宿主`);
console.log(`  node test/mcp_server.mjs --projects "${projectsFile}"`);
console.log(`  # 发送复核：DS_CONV=<会话ID> node test/send_to_ds.mjs <复核报告>`);

if (emitReport) {
  const lines = [
    `# 项目自注册复核：${name}`,
    "",
    `- 项目名：${name}`,
    `- projectRoot：<projectRoot>（已脱敏，请本地核对）`,
    `- 配置：<config>`,
    `- 注册表：<projects.json>`,
    `- 状态目录：.agent-link/state（项目内）`,
    `- 任务目录：.agent-link/tasks（项目内）`,
    `- 校验：${dryRun ? "dry-run（未落盘）" : "通过（validateProjectConfig + loadProjectsRegistry）"}`,
    "",
    "请复核：",
    "1. projectRoot 是否指向正确目录；",
    "2. 状态/任务目录是否与其他项目隔离；",
    "3. 是否需要 agentCommand（默认 null=禁用）；",
    "4. 是否存在越界路径（配置已强制在 projectRoot 内）；",
    "5. 项目名是否易与其他项目混淆。",
  ];
  fs.mkdirSync(path.dirname(path.resolve(emitReport)), { recursive: true });
  fs.writeFileSync(path.resolve(emitReport), lines.join("\n") + "\n", "utf8");
  console.log(`\n已生成脱敏复核报告: ${path.resolve(emitReport)}`);
  console.log(`发送命令：DS_CONV=<会话ID> node test/send_to_ds.mjs "${path.resolve(emitReport)}"`);
}
