// C9-R19 项目配置加载器：让协调器核心与项目业务配置解耦（跨项目复用最小实现）
// 设计约束（与 R13/R16 安全边界一致）:
//   - 配置只描述"在哪里工作、跑什么固定命令"，永远不承载任务正文；
//   - 命令白名单：解释器白名单(node/python/python3/py) 或 项目根内的绝对路径；禁止 shell、禁止带路径分隔符的相对命令；
//   - 所有路径（stateDir/tasksDir/agentCommand.taskFile）必须解析在 projectRoot 内，越界即非法；
//   - 配置非法 → 失败关闭（fail-closed）：projectTests/agentCommand 全部作废，调用方启动门禁阻断；
//   - 缺省回退：未提供配置文件时按 fallbackRoot 生成默认配置，行为与 R18 完全一致（向后兼容）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_FILE_DEFAULT = path.join(__dirname, "project.config.json");
export const CONFIG_ENV_VAR = "AGENT_LINK_PROJECT_CONFIG";
// 允许被配置引用的解释器（不含 shell：cmd/powershell/bash 等一律拒绝）
export const DEFAULT_INTERPRETERS = ["node", "python", "python3", "py"];

const isStr = (v) => typeof v === "string";
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);
const hasNul = (s) => s.includes("\u0000");

function withinRoot(root, abs) {
  const rel = path.relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function stripExe(s) {
  return String(s).toLowerCase().replace(/\.exe$/, "");
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

// 默认配置：仅用于"仓库内未提供配置文件"的向后兼容回退
export function defaultProjectConfig(projectRoot) {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    name: "default",
    projectRoot: path.resolve(projectRoot),
    projectTests: [
      { command: "node", args: ["test/comm_integration_test.mjs"] },
      { command: "node", args: ["test/run_state_store_test.mjs"] },
    ],
    agentCommand: null,
    paths: { stateDir: "test/state", tasksDir: "test/tasks" },
  };
}

// 校验并归一化配置。返回 {ok:true, config} 或 {ok:false, errors[]}
export function validateProjectConfig(raw, opts = {}) {
  const { configPath = null, requireExistingRoot = true, interpreters = DEFAULT_INTERPRETERS } = opts;
  const allow = interpreters.map(stripExe);
  const errors = [];
  const fail = (m) => errors.push(m);

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["配置内容必须是 JSON 对象"], configPath };
  }

  const sv = raw.schemaVersion === undefined ? CONFIG_SCHEMA_VERSION : raw.schemaVersion;
  if (sv !== CONFIG_SCHEMA_VERSION) {
    fail(`schemaVersion 不支持: ${JSON.stringify(sv)}（仅支持 ${CONFIG_SCHEMA_VERSION}）`);
  }

  let root = null;
  if (!isStr(raw.projectRoot) || !raw.projectRoot.trim()) {
    fail("projectRoot 必填（绝对路径字符串）");
  } else if (!path.isAbsolute(raw.projectRoot)) {
    // 可移植配置：允许相对 projectRoot，按配置文件所在目录解析（需显式开启）
    if (opts.resolveRelativeToConfig && configPath) {
      root = path.resolve(path.dirname(configPath), raw.projectRoot);
    } else {
      fail(`projectRoot 必须是绝对路径: ${raw.projectRoot}`);
    }
  } else {
    root = path.resolve(raw.projectRoot);
  }
  if (root && requireExistingRoot) {
    if (!fs.existsSync(root)) fail(`projectRoot 不存在: ${root}`);
    else if (!fs.statSync(root).isDirectory()) fail(`projectRoot 不是目录: ${root}`);
  }

  // 命令白名单校验：解释器 basename 或项目根内绝对路径；无 shell、无相对路径、无 NUL
  const checkCommand = (cmd, label) => {
    if (!isStr(cmd) || !cmd.trim()) { fail(`${label}.command 必须是非空字符串`); return; }
    if (hasNul(cmd)) { fail(`${label}.command 含非法字符`); return; }
    if (path.isAbsolute(cmd)) {
      const abs = path.resolve(cmd);
      if (!root) return;
      if (!withinRoot(root, abs)) { fail(`${label}.command 绝对路径越界（必须在项目根内）: ${cmd}`); return; }
      if (!fs.existsSync(abs)) { fail(`${label}.command 不存在: ${cmd}`); return; }
      if (!fs.statSync(abs).isFile()) { fail(`${label}.command 不是文件: ${cmd}`); return; }
      return;
    }
    if (/[\\/]/.test(cmd)) { fail(`${label}.command 不允许相对路径形式: ${cmd}`); return; }
    if (!allow.includes(stripExe(cmd))) {
      fail(`${label}.command 不在解释器白名单（${allow.join(", ")}）: ${cmd}`);
    }
  };

  const checkArgs = (args, label) => {
    if (args === undefined) return;
    if (!isStrArray(args)) { fail(`${label}.args 必须是字符串数组`); return; }
    if (args.some(hasNul)) fail(`${label}.args 含非法字符`);
  };

  // projectTests
  let projectTests = [];
  if (raw.projectTests !== undefined) {
    if (!Array.isArray(raw.projectTests)) {
      fail("projectTests 必须是数组");
    } else {
      raw.projectTests.forEach((t, i) => {
        const label = `projectTests[${i}]`;
        if (!t || typeof t !== "object" || Array.isArray(t)) { fail(`${label} 必须是对象`); return; }
        checkCommand(t.command, label);
        checkArgs(t.args, label);
        projectTests.push({ command: t.command, args: Array.isArray(t.args) ? [...t.args] : [] });
      });
    }
  }

  // agentCommand（默认 null = 禁用 agent_dispatch）
  let agentCommand = null;
  if (raw.agentCommand !== undefined && raw.agentCommand !== null) {
    const a = raw.agentCommand;
    if (typeof a !== "object" || Array.isArray(a)) {
      fail("agentCommand 必须是对象或 null");
    } else {
      checkCommand(a.command, "agentCommand");
      checkArgs(a.args, "agentCommand");
      let taskFile = null;
      if (a.taskFile !== undefined && a.taskFile !== null) {
        if (!isStr(a.taskFile) || !a.taskFile.trim()) {
          fail("agentCommand.taskFile 必须是非空字符串");
        } else if (hasNul(a.taskFile)) {
          fail("agentCommand.taskFile 含非法字符");
        } else if (root) {
          const tf = path.resolve(root, a.taskFile);
          if (!withinRoot(root, tf)) fail(`agentCommand.taskFile 越界（必须在项目根内）: ${a.taskFile}`);
          else taskFile = toPosix(path.relative(root, tf));
        }
      }
      agentCommand = { command: a.command, args: Array.isArray(a.args) ? [...a.args] : [] };
      if (taskFile) agentCommand.taskFile = taskFile;
    }
  }

  // 项目内数据目录（不同项目必须各自独立，避免状态串扰）
  const p = raw.paths === undefined ? {} : raw.paths;
  if (!p || typeof p !== "object" || Array.isArray(p)) fail("paths 必须是对象");
  const resolveDir = (v, fallback, label) => {
    if (v === undefined) v = fallback;
    if (!isStr(v) || !v.trim()) { fail(`${label} 必须是非空字符串`); return null; }
    if (hasNul(v)) { fail(`${label} 含非法字符`); return null; }
    if (!root) return null;
    const abs = path.resolve(root, v);
    if (!withinRoot(root, abs)) { fail(`${label} 越界（必须在项目根内）: ${v}`); return null; }
    return abs;
  };
  const stateDir = resolveDir(p.stateDir, "test/state", "paths.stateDir");
  const tasksDir = resolveDir(p.tasksDir, "test/tasks", "paths.tasksDir");

  if (errors.length) return { ok: false, errors, configPath };

  return {
    ok: true,
    configPath,
    config: {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      name: isStr(raw.name) && raw.name.trim() ? raw.name.trim() : path.basename(root),
      projectRoot: root,
      projectTests,
      agentCommand,
      stateDir,
      tasksDir,
      registryFile: path.join(tasksDir, "registry.json"),
      outboxDir: path.join(tasksDir, "outbox"),
      latestFile: path.join(stateDir, "latest.json"),
    },
  };
}

// 失败关闭配置：任何可执行能力都被移除（只保留项目根用于 node_check 的边界判定）
export function failClosedConfig(projectRoot) {
  const root = path.resolve(projectRoot);
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    name: "(invalid-config)",
    projectRoot: root,
    projectTests: [],
    agentCommand: null,
    stateDir: path.join(root, "test", "state"),
    tasksDir: path.join(root, "test", "tasks"),
    registryFile: path.join(root, "test", "tasks", "registry.json"),
    outboxDir: path.join(root, "test", "tasks", "outbox"),
    latestFile: path.join(root, "test", "state", "latest.json"),
    configError: "config-invalid",
  };
}

// 读取配置文件（显式 file > 环境变量 > 仓库默认位置）；缺文件时按 fallbackRoot 回退默认配置
export function loadActiveProjectConfig(opts = {}) {
  const { file = null, env = process.env, fallbackRoot = null, ...validateOpts } = opts;
  const cfgPath = file || env[CONFIG_ENV_VAR] || CONFIG_FILE_DEFAULT;
  // 可移植配置：默认允许相对 projectRoot，按配置文件所在目录解析（直接调用 validateProjectConfig 仍严格）
  const vOpts = { ...validateOpts };
  if (vOpts.resolveRelativeToConfig === undefined) vOpts.resolveRelativeToConfig = true;

  if (!fs.existsSync(cfgPath)) {
    if (!fallbackRoot) {
      return { ok: false, errors: [`配置文件不存在且未提供 fallbackRoot: ${cfgPath}`], config: null, configPath: cfgPath, source: "missing" };
    }
    const r = validateProjectConfig(defaultProjectConfig(fallbackRoot), { ...vOpts, configPath: null });
    return { ...r, configPath: cfgPath, source: "fallback" };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (e) {
    return { ok: false, errors: [`配置文件非合法 JSON: ${e.message}`], config: null, configPath: cfgPath, source: "file" };
  }
  const r = validateProjectConfig(raw, { ...vOpts, configPath: cfgPath });
  return { ...r, configPath: cfgPath, source: "file" };
}

// 协调器实际使用的入口：无论配置是否合法都返回可用的 config（非法时失败关闭）+ 明确错误
export function loadProjectConfigSafe(opts = {}) {
  const r = loadActiveProjectConfig(opts);
  if (r.ok) {
    return { ok: true, config: r.config, errors: [], source: r.source, configPath: r.configPath };
  }
  const root = path.resolve(opts.fallbackRoot || process.cwd());
  return {
    ok: false,
    config: failClosedConfig(root),
    errors: r.errors || ["未知配置错误"],
    source: r.source,
    configPath: r.configPath || null,
  };
}
