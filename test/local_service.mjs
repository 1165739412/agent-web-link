// C9-R20 本地协作服务：供其他项目脚本（Python/Node.js 等）通过本机 HTTP 调用
// 目标闭环: 请求 → 登记与去重 → 顺序调用执行器（白名单动作）→ 记录证据报告 → 查询/取回
// 设计取舍（与现有代码保持同一套状态系统，不另造一套）:
//   - 项目必须先在 projects.json 注册；工作目录/验证命令/agent 入口全部来自受信任的项目配置；
//   - 动作仍走 agent_executor 白名单（node_check / run_project_tests / agent_dispatch），
//     请求方不能指定 shell、可执行文件或自定义命令；
//   - 单实例、单 Worker、严格顺序执行；任务状态写入项目自己的登记簿（tasks/registry.json）；
//   - 报告快照写入 <tasksDir>/reports/<taskId>.json，任务上用 reportFile 引用；
//   - 状态契约沿用 R13: 执行器只能产出 ACTIONS_DONE / BLOCKED / FAILED，永不自动产出 DONE；
//   - 服务重启时残留 RUNNING → REPORT_UNKNOWN，绝不自动重试（结果未知的任务禁止重复执行）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadActiveProjectConfig } from "./project_config.mjs";
import { makeExecutor, ALLOWED_OPS } from "./agent_executor.mjs";
import { PHASES, loadRegistry, saveRegistry, registerTask, updatePhase, findTask } from "./task_store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVICE_VERSION = "c9-r20-1";
export const DEFAULT_PROJECTS_FILE = path.join(__dirname, "projects.json");
export const DEFAULT_TOKEN_FILE = path.join(__dirname, "service", "token.txt");
const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const TASK_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;

// ---------- 项目注册表（唯一可信来源：外部请求不能指定任意路径） ----------
export function loadProjectsRegistry(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return { ok: false, errors: [`项目注册表不存在: ${abs}`] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(abs, "utf8")); }
  catch (e) { return { ok: false, errors: [`项目注册表非合法 JSON: ${e.message}`] }; }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.projects)) {
    return { ok: false, errors: ["项目注册表必须包含 projects 数组"] };
  }
  const baseDir = path.dirname(abs);
  const projects = new Map();
  const errors = [];
  const projectErrors = {};
  for (let i = 0; i < raw.projects.length; i++) {
    const p = raw.projects[i];
    if (!p || typeof p !== "object") { const m = `projects[${i}] 必须是对象`; errors.push(m); projectErrors[`#${i}`] = m; continue; }
    if (typeof p.name !== "string" || !p.name.trim()) { const m = `projects[${i}] 缺少 name`; errors.push(m); projectErrors[`#${i}`] = m; continue; }
    if (typeof p.config !== "string" || !p.config.trim()) { const m = `项目 ${p.name} 缺少 config`; errors.push(m); projectErrors[p.name] = m; continue; }
    if (projects.has(p.name)) { const m = `项目名重复: ${p.name}`; errors.push(m); projectErrors[p.name] = m; continue; }
    const cfgPath = path.isAbsolute(p.config) ? p.config : path.resolve(baseDir, p.config);
    const loaded = loadActiveProjectConfig({ file: cfgPath, env: {}, resolveRelativeToConfig: true });
    if (!loaded.ok) { const m = `项目 ${p.name} 配置非法: ${(loaded.errors || []).join("; ")}`; errors.push(m); projectErrors[p.name] = m; continue; }
    projects.set(p.name, {
      name: p.name,
      configPath: cfgPath,
      config: loaded.config,
      executor: makeExecutor(loaded.config),
    });
  }
  // C9-ROUTE: 单项目配置非法不拖垮整体（保住 agent-link）；非法项目在提交/领取/回报时显式失败，
  // 绝不静默回退到其他项目。仅在无任何有效项目时整体失败关闭。
  if (projects.size === 0) return { ok: false, errors: errors.length ? errors : ["注册表未包含任何有效项目"] };
  return { ok: true, projects, projectErrors };
}

// ---------- 服务令牌（本机文件，首次启动自动生成；不读取任何浏览器/认证存储） ----------
export function ensureServiceToken(tokenFile) {
  if (fs.existsSync(tokenFile)) {
    const t = fs.readFileSync(tokenFile, "utf8").trim();
    if (t.length < 32) throw new Error(`服务令牌文件内容过短（至少 32 字符）: ${tokenFile}`);
    return t;
  }
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  const t = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFile, `${t}\n`, { encoding: "utf8", mode: 0o600 });
  return t;
}

// R13 状态契约：执行器结果 → 报告状态（永远不产出 DONE）
export function buildServiceReport({ job, ex, startedAt, finishedAt, reportToken }) {
  const results = ((ex && ex.results) || []).map((r) => ({
    op: r.action?.op ?? null,
    target: r.action?.target ?? null,
    ok: r.ok === true,
    blocked: r.blocked === true,
    exitCode: r.exitCode ?? null,
    reason: r.reason ?? null,
  }));
  const anyBlocked = results.some((r) => r.blocked);
  const status = ex && ex.ok ? "ACTIONS_DONE" : (anyBlocked ? "BLOCKED" : "FAILED");
  return {
    schemaVersion: 1,
    taskId: job.taskId,
    project: job.project,
    status,
    goalAchieved: false,
    taskComplete: false,
    summary: job.summary,
    reportToken,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    results,
    failures: results.filter((r) => !r.ok).map((r) => r.reason || `${r.action?.op ?? "action"} 失败`),
    note: "ACTIONS_DONE 仅表示白名单动作执行成功，不代表任务目标已达成；TASK_COMPLETE 只能由规划方决策或 agent 实际验证后确认。",
  };
}

// ---------- 服务实例 ----------
export function createTaskService({
  projectsFile = DEFAULT_PROJECTS_FILE,
  tokenFile = DEFAULT_TOKEN_FILE,
  log = () => {},
  worker = null,          // 测试注入用；默认使用项目执行器真实执行
  // C9-R24: autoExecute=false（CLI --queue-only）时本服务只做"登记 + 队列 + 查询 + 报告"，
  // 不自行执行任务——执行交给 collab_loop 或真实 Agent，避免两个执行器抢同一任务。
  autoExecute = true,
  now = () => new Date().toISOString(),
  idGen = () => crypto.randomBytes(4).toString("hex"),
} = {}) {
  const registry = loadProjectsRegistry(projectsFile);
  if (!registry.ok) {
    const err = new Error(`项目注册表不可用: ${(registry.errors || []).join("; ")}`);
    err.code = "PROJECTS_REGISTRY_INVALID";
    throw err;
  }
  const projects = registry.projects;
  const projectErrors = registry.projectErrors || {};
  const token = ensureServiceToken(tokenFile);

  const queue = [];            // 待执行（提交顺序）
  const idleWaiters = [];
  let running = null;
  let draining = false;        // 明确的"正在排空队列"标志（不依赖 promise 同步赋值顺序）
  let started = false;
  let stopping = false;
  const stats = { submitted: 0, completed: 0, failed: 0, blocked: 0, unknown: 0, rejected: 0 };
  const recovered = [];

  const proj = (name) => projects.get(name) || null;

  // HIGH-2：被拒提交写入 orphan 区（不静默丢弃），供人工回收/比对
  function writeOrphan(p, project, { taskId, reason, evidence, summary, note, claimToken }) {
    try {
      const dir = path.join(p.config.tasksDir, "orphan");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${taskId}-${Date.now().toString(36)}.json`);
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, taskId, project, reason, evidence, summary, note, claimToken, at: now() }, null, 2), "utf8");
      audit(project, "submit-orphan", { taskId, reason, file: path.basename(file) });
      return file;
    } catch { return null; }
  }

  // M6：append-only 审计（项目 stateDir/audit.log）；只追加，cleanup 不删除最近记录
  function audit(name, action, data = {}) {
    try {
      const px = projects.get(name);
      const dir = px && px.config ? px.config.stateDir : null;
      if (!dir) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "audit.log"), JSON.stringify({ at: now(), action, project: name, ...data }) + "\n", "utf8");
    } catch {}
  }

  // C9-ROUTE: 项目上下文一致性校验（注册存在 / 根目录存在且为目录 / 执行器根目录与配置一致）
  // 失败时返回明确错误码，调用方据此显式失败，绝不静默回退到其他项目。
  function resolveProject(name) {
    const p = projects.get(name);
    if (!p) {
      if (projectErrors[name]) return { ok: false, code: "PROJECT_CONFIG_INVALID", httpStatus: 400, message: `项目 ${name} 配置未加载: ${projectErrors[name]}` };
      return { ok: false, code: "UNKNOWN_PROJECT", httpStatus: 404, message: `项目未注册: ${name}` };
    }
    const rootResolved = path.resolve(p.config.projectRoot);
    let stat;
    try { stat = fs.statSync(rootResolved); }
    catch { return { ok: false, code: "PROJECT_ROOT_MISSING", httpStatus: 400, message: `项目 ${name} 根目录不存在: ${rootResolved}` }; }
    if (!stat.isDirectory()) return { ok: false, code: "PROJECT_ROOT_INVALID", httpStatus: 400, message: `项目 ${name} 根目录不是目录: ${rootResolved}` };
    if (path.resolve(p.executor.root) !== rootResolved) {
      return { ok: false, code: "PROJECT_ROUTE_MISMATCH", httpStatus: 500, message: `项目 ${name} 执行器根目录与配置不一致: ${p.executor.root} != ${rootResolved}` };
    }
    return { ok: true, p, root: rootResolved };
  }

  const reportFileOf = (p, taskId) => path.join(p.config.tasksDir, "reports", `${taskId}.json`);

  function writeReportFile(file, report) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  // 必须用异步执行器：spawnSync 会锁死事件循环，导致执行期间状态查询/健康检查挂起
  const defaultWorker = async (job) => {
    const p = proj(job.project);
    const ex = await p.executor.executeActionsAsync(job.actions, { taskContext: { taskId: job.taskId, summary: job.summary } });
    return { ok: ex.ok === true, results: ex.results };
  };
  const runWorker = worker || defaultWorker;

  const errOut = (httpStatus, code, message) => ({ ok: false, httpStatus, code, message });

  // 提交：校验 → 去重 → 登记 → 入队（不等待执行）
  // mode: "worker"（默认，白名单动作由本地 Worker 执行） | "agent"（留给真实 Agent 通过桥接领取执行，
  //        不接受任何 actions，避免绕过白名单；本地 Worker 永不执行此类任务）
  function submit({ project, taskId, summary, actions, mode = "worker" } = {}) {
    const rp = resolveProject(project);
    if (!rp.ok) return errOut(rp.httpStatus, rp.code, rp.message);
    const p = rp.p;

    const isAgentMode = mode === "agent";
    if (isAgentMode) {
      if (Array.isArray(actions) && actions.length > 0) {
        return errOut(400, "AGENT_MODE_NO_ACTIONS", "agent 模式任务由真实 Agent 执行，不接受白名单 actions");
      }
      if (typeof summary !== "string" || !summary.trim()) {
        return errOut(400, "SUMMARY_REQUIRED", "agent 模式任务必须提供 summary（工作内容描述）");
      }
    } else if (!Array.isArray(actions) || actions.length === 0) {
      return errOut(400, "INVALID_ACTIONS", "actions 必须是非空数组");
    }
    const accepted = [];
    for (const a of Array.isArray(actions) ? actions : []) {
      if (!a || typeof a !== "object" || Array.isArray(a)) {
        return errOut(400, "INVALID_ACTIONS", "每个 action 必须是对象");
      }
      if (!ALLOWED_OPS.includes(a.op)) {
        return errOut(400, "OP_NOT_ALLOWED", `不允许的操作: ${JSON.stringify(a.op)}（允许: ${ALLOWED_OPS.join(", ")}）`);
      }
      const v = p.executor.validateAction(a);
      if (!v.ok) {
        const code = a.op === "agent_dispatch" ? "AGENT_NOT_CONFIGURED" : "ACTION_REJECTED";
        return errOut(400, code, v.reason);
      }
      accepted.push({ op: a.op, ...(typeof a.target === "string" ? { target: a.target } : {}) });
    }

    const id = taskId === undefined || taskId === null || taskId === ""
      ? `api-${Date.now().toString(36)}-${idGen()}`
      : String(taskId);
    if (!TASK_ID_RE.test(id)) return errOut(400, "INVALID_TASK_ID", `taskId 格式非法: ${id}（仅允许字母数字 . _ : -，≤120）`);

    const reg = loadRegistry(p.config.registryFile);
    if (reg.ok === false) return errOut(500, "REGISTRY_CORRUPT", `项目登记簿损坏，需人工复核: ${reg.error}`);
    if (findTask(reg, { taskId: id })) return errOut(409, "DUPLICATE_TASK", `任务已存在（去重拒绝）: ${id}`);

    const regRes = registerTask(reg, {
      project,
      taskId: id,
      assistantMsgId: `api:${id}`,
      userSource: { text: String(summary || ""), hash: null },
      type: "ASSISTANT_TASK",
      actions: accepted,
      summary: String(summary || ""),
    });
    if (!regRes.ok) return errOut(409, regRes.code || "DUPLICATE_TASK", `任务已存在: ${id}`);
    regRes.task.source = "api";
    regRes.task.execution = isAgentMode ? "agent" : "worker";
    regRes.task.submittedAt = now();
    if (!saveRegistry(p.config.registryFile, reg)) return errOut(500, "REGISTRY_WRITE_FAILED", "登记簿写入失败");

    stats.submitted++;
    if (isAgentMode || !autoExecute) {
      // agent 模式 → 交给真实 Agent 领取；queue-only → 交给外部执行器（collab_loop）接管
      log(`[SUBMIT] ${project}/${id} execution=${isAgentMode ? "agent" : "worker"} autoExecute=${autoExecute}（仅登记，本地 Worker 不执行）`);
      return { ok: true, httpStatus: 202, taskId: id, project, phase: PHASES.NEW, execution: isAgentMode ? "agent" : "worker", queuePosition: null };
    }
    const job = { taskId: id, project, actions: accepted, summary: String(summary || ""), submittedAt: regRes.task.submittedAt };
    queue.push(job);
    log(`[SUBMIT] ${project}/${id} actions=${accepted.map((a) => a.op).join(",")} queue=${queue.length}`);
    // 先返回 202 再开始执行：避免把同步执行耗时算进接口响应时间
    setImmediate(kick);
    return { ok: true, httpStatus: 202, taskId: id, project, phase: PHASES.NEW, execution: "worker", queuePosition: queue.length };
  }

  function status({ project, taskId } = {}) {
    const p = proj(project);
    if (!p) return errOut(404, "UNKNOWN_PROJECT", `项目未注册: ${project}`);
    const reg = loadRegistry(p.config.registryFile);
    if (reg.ok === false) return errOut(500, "REGISTRY_CORRUPT", `项目登记簿损坏: ${reg.error}`);
    const t = findTask(reg, { taskId });
    if (!t) return errOut(404, "TASK_NOT_FOUND", `任务不存在: ${taskId}`);
    const queuedIdx = t.phase === PHASES.NEW ? queue.findIndex((j) => j.taskId === taskId) : -1;
    return {
      ok: true,
      httpStatus: 200,
      task: {
        taskId: t.taskId,
        project: t.project || project,
        phase: t.phase,
        execution: t.execution ?? null,
        claimedBy: t.claimedBy ?? null,
        summary: t.summary,
        actions: t.actions,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        submittedAt: t.submittedAt ?? null,
        startedAt: t.startedAt ?? null,
        finishedAt: t.finishedAt ?? null,
        reportAvailable: Boolean(t.reportFile),
        queuePosition: queuedIdx >= 0 ? queuedIdx + 1 : null,
        running: running ? running.taskId === taskId : false,
      },
    };
  }

  function report({ project, taskId } = {}) {
    const p = proj(project);
    if (!p) return errOut(404, "UNKNOWN_PROJECT", `项目未注册: ${project}`);
    const reg = loadRegistry(p.config.registryFile);
    if (reg.ok === false) return errOut(500, "REGISTRY_CORRUPT", `项目登记簿损坏: ${reg.error}`);
    const t = findTask(reg, { taskId });
    if (!t) return errOut(404, "TASK_NOT_FOUND", `任务不存在: ${taskId}`);
    const file = t.reportFile || reportFileOf(p, taskId);
    if (!fs.existsSync(file)) {
      if (t.phase === PHASES.NEW || t.phase === PHASES.RUNNING) {
        return errOut(409, "REPORT_NOT_READY", `任务尚未完成（phase=${t.phase}）`);
      }
      return errOut(404, "REPORT_NOT_FOUND", `报告不存在（phase=${t.phase}）`);
    }
    let parsed;
    try {
      // 大小上限（DS 评审：resources/read 天然保护 + 单进程 stdio 不被超大读阻塞）
      const st2 = fs.statSync(file);
      if (st2.size > 1_000_000) return errOut(413, "REPORT_TOO_LARGE", `报告超过大小上限（1MB）：${st2.size} 字节`);
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (e) {
      if (e.code === "REPORT_TOO_LARGE" || e.httpStatus === 413) return errOut(413, "REPORT_TOO_LARGE", e.message || "报告超过大小上限");
      return errOut(500, "REPORT_UNREADABLE", `报告文件不可读: ${e.message}`);
    }
    return { ok: true, httpStatus: 200, report: parsed };
  }

  // C9-R21 桥接：领取下一项待处理任务（NEW → RUNNING 立即落盘，保证不会被重复领取）
  // 只返回已注册项目、且经登记簿去重过的任务；不暴露任何命令/路径参数。
  function claimNext({ project = null, claimedBy = "agent" } = {}) {
    const names = project ? [project] : [...projects.keys()];
    for (const name of names) {
      const rp = resolveProject(name);
      if (!rp.ok) {
        if (project) return errOut(rp.httpStatus, rp.code, rp.message);
        log(`[CLAIM] 跳过不可用项目 ${name}: ${rp.message}`);
        continue;
      }
      const p = rp.p;
      const reg = loadRegistry(p.config.registryFile);
      if (reg.ok === false) return errOut(500, "REGISTRY_CORRUPT", `项目登记簿损坏: ${reg.error}`);
      // H1：租约回收——RUNNING 且租约过期 → NEW，避免任务永久锁死（TTL 可配）
      const ttl = Math.max(60000, Number(process.env.AGENT_LINK_LEASE_TTL_MS || 1800000));
      let reclaimed = 0;
      for (const t0 of reg.tasks) {
        if (t0.phase !== PHASES.RUNNING) continue;
        const exp = t0.leaseExpiresAt ? Date.parse(t0.leaseExpiresAt) : (t0.claimedAt ? Date.parse(t0.claimedAt) + ttl : NaN);
        if (!Number.isFinite(exp) || exp >= Date.now()) continue;
        const prevBy = t0.claimedBy || null;
        t0.phase = PHASES.NEW;
        t0.updatedAt = now();
        t0.reclaimedAt = t0.updatedAt;
        t0.reclaimCount = (t0.reclaimCount || 0) + 1;
        delete t0.claimedBy; delete t0.claimedAt; delete t0.claimToken; delete t0.leaseExpiresAt;
        t0.history = Array.isArray(t0.history) ? t0.history : [];
        t0.history.push({ at: t0.updatedAt, phase: PHASES.NEW, note: `lease expired (was ${prevBy || "unknown"})` });
        reclaimed++;
        log(`[RECLAIM] ${name}/${t0.taskId} 租约过期 → NEW（原 ${prevBy || "unknown"}）`);
      }
      if (reclaimed) { saveRegistry(p.config.registryFile, reg); audit(name, "reclaim", { count: reclaimed }); }
      // 路由一致性：登记簿内待领取任务的 project 必须与本项目一致，防止错项目任务被领取
      const misrouted = reg.tasks.find((t) => t.phase === PHASES.NEW && t.project && t.project !== name);
      if (misrouted) return errOut(500, "PROJECT_ROUTE_MISMATCH", `项目 ${name} 登记簿存在归属其他项目的任务 ${misrouted.taskId} (project=${misrouted.project})`);
      const pending = reg.tasks
        .filter((t) => t.phase === PHASES.NEW)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      if (pending.length === 0) continue;
      const t = pending[0];
      if (!t.project) t.project = name; // 兼容旧任务：补写归属
      t.claimedAt = now();
      t.claimedBy = claimedBy;
      t.claimToken = idGen();
      t.leaseExpiresAt = new Date(Date.now() + ttl).toISOString();
      updatePhase(reg, t.taskId, PHASES.RUNNING);
      if (!saveRegistry(p.config.registryFile, reg)) return errOut(500, "REGISTRY_WRITE_FAILED", "登记簿写入失败");
      log(`[CLAIM] ${name}/${t.taskId} → ${claimedBy}（RUNNING, lease=${t.leaseExpiresAt}）`);
      audit(name, "claim", { taskId: t.taskId, claimedBy, leaseExpiresAt: t.leaseExpiresAt });
      return {
        ok: true, httpStatus: 200,
        task: {
          taskId: t.taskId, project: name, summary: t.summary, actions: t.actions,
          createdAt: t.createdAt, submittedAt: t.submittedAt ?? null, source: t.source ?? null,
          claimToken: t.claimToken, leaseExpiresAt: t.leaseExpiresAt, leaseTtlMs: ttl,
        },
        instructions: "在任务所属项目内完成实际工作，然后用 agent_link_submit_result 提交可核验证据（证据不得为空；建议回传 claimToken）。",
      };
    }
    return { ok: true, httpStatus: 200, task: null, message: "没有待处理任务（安全空闲，不重复执行）" };
  }

  // C9-R21 桥接：提交任务结果。必须校验 project/taskId 归属与 phase，且要求非空证据；
  // 无真实证据不得把工作标记为完成；ok=true 也只是 ACTIONS_DONE（goalAchieved 恒为 false）。
  function submitResult({ project, taskId, ok, evidence, summary = null, note = null, claimToken = null } = {}) {
    const rp = resolveProject(project);
    if (!rp.ok) return errOut(rp.httpStatus, rp.code, rp.message);
    const p = rp.p;
    if (typeof ok !== "boolean") return errOut(400, "INVALID_OK", "ok 必须是布尔值");
    const hasEvidence = Array.isArray(evidence)
      ? evidence.length > 0
      : (evidence && typeof evidence === "object" && Object.keys(evidence).length > 0)
        || (typeof evidence === "string" && evidence.trim().length > 0);
    if (!hasEvidence) return errOut(400, "EVIDENCE_REQUIRED", "必须提交非空的可核验证据（evidence）");

    const reg = loadRegistry(p.config.registryFile);
    if (reg.ok === false) return errOut(500, "REGISTRY_CORRUPT", `项目登记簿损坏: ${reg.error}`);
    const t = findTask(reg, { taskId });
    if (!t) return errOut(404, "TASK_NOT_FOUND", `任务不存在: ${taskId}`);
    if (t.project && t.project !== project) {
      return errOut(409, "PROJECT_ROUTE_MISMATCH", `任务 ${taskId} 归属 ${t.project}，不能由项目 ${project} 提交结果`);
    }
    if (!t.project) t.project = project;

    // H4：幂等重放——已终态且携带首次 claimToken 时返回首次结果，不覆盖
    if ([PHASES.REPORTED, PHASES.FAILED].includes(t.phase)) {
      if (claimToken && t.claimToken && claimToken === t.claimToken) {
        let report = null;
        if (t.reportFile && fs.existsSync(t.reportFile)) { try { report = JSON.parse(fs.readFileSync(t.reportFile, "utf8")); } catch {} }
        log(`[SUBMIT-RESULT] ${project}/${taskId} 幂等重放（phase=${t.phase}）`);
        audit(project, "submit-idempotent", { taskId, phase: t.phase });
        return { ok: true, httpStatus: 200, phase: t.phase, report, idempotent: true };
      }
      return errOut(409, "ALREADY_SUBMITTED", `任务已提交（phase=${t.phase}）；如需重放请携带首次 claimToken`);
    }
    if (![PHASES.RUNNING, PHASES.NEW].includes(t.phase)) {
      return errOut(409, "INVALID_STATE", `任务当前 phase=${t.phase}，不可提交结果`);
    }
    // H1：租约校验（仅对有 claimToken 的任务；旧任务保持兼容）
    if (t.claimToken) {
      if (claimToken && claimToken !== t.claimToken) {
        const orphanFile = writeOrphan(p, project, { taskId, reason: "CLAIM_TOKEN_MISMATCH", evidence, summary, note, claimToken });
        if (!orphanFile) return errOut(500, "ORPHAN_WRITE_FAILED", "提交被拒（CLAIM_TOKEN_MISMATCH）且 orphan 写入失败，请人工核对");
        const e = errOut(409, "CLAIM_TOKEN_MISMATCH", "claimToken 与当前租约不匹配（任务可能已被回收/重新领取）");
        e.orphanFile = orphanFile;
        return e;
      }
      if (!claimToken) {
        const exp = t.leaseExpiresAt ? Date.parse(t.leaseExpiresAt) : NaN;
        if (Number.isFinite(exp) && exp < Date.now()) {
          const orphanFile = writeOrphan(p, project, { taskId, reason: "LEASE_EXPIRED", evidence, summary, note, claimToken });
          if (!orphanFile) return errOut(500, "ORPHAN_WRITE_FAILED", "提交被拒（LEASE_EXPIRED）且 orphan 写入失败，请人工核对");
          const e = errOut(409, "LEASE_EXPIRED", "领取租约已过期，请重新 claim 后再提交（避免旧 Agent 覆盖）");
          e.orphanFile = orphanFile;
          return e;
        }
      }
    }

    const finishedAt = now();
    const reportToken = `C3R-${Date.now().toString(36)}-${idGen()}`;
    const report = {
      schemaVersion: 1,
      taskId, project, status: ok ? "ACTIONS_DONE" : "FAILED",
      goalAchieved: false, taskComplete: false,
      summary: summary || t.summary,
      reportToken,
      startedAt: t.startedAt ?? t.claimedAt ?? null,
      finishedAt,
      durationMs: t.startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(t.startedAt)) : null,
      results: [], failures: ok ? [] : ["Agent 报告任务未成功完成"],
      evidence, note,
      source: "agent-bridge",
      note2: "ACTIONS_DONE 仅表示 Agent 报告动作已执行并有证据，不代表任务目标已达成；TASK_COMPLETE 仍由规划方决策。",
    };
    const file = reportFileOf(p, taskId);
    writeReportFile(file, report);
    t.finishedAt = finishedAt;
    t.agentResult = { ok, evidence, summary, note, submittedAt: finishedAt, claimToken: claimToken || t.claimToken || null };
    updatePhase(reg, taskId, ok ? PHASES.REPORTED : PHASES.FAILED, {
      results: [], reportFile: file, reportToken,
      stopReason: ok ? undefined : "Agent 提交结果为失败",
    });
    saveRegistry(p.config.registryFile, reg);
    log(`[SUBMIT-RESULT] ${project}/${taskId} ok=${ok} → ${ok ? PHASES.REPORTED : PHASES.FAILED}`);
    audit(project, "submit", { taskId, ok, phase: ok ? PHASES.REPORTED : PHASES.FAILED });
    return { ok: true, httpStatus: 200, phase: ok ? PHASES.REPORTED : PHASES.FAILED, report };
  }

  // C9-MCP2: 项目列表（只读，MCP/HTTP 共用）——供外部 Agent 发现可接入的项目与健康状态。
  // 信息面白名单（DS 评审第 5 点）：不回显绝对路径、登记簿路径与配置错误原文（防攻击面扩大）；
  // 配置错误只给计数，详情看服务端日志。
  function listProjects() {
    const items = [...projects.values()].map((p) => ({
      name: p.name,
      hasRegistry: fs.existsSync(p.config.registryFile),
    }));
    // 配置错误可诊断（反馈：只有 configErrorCount 无法定位）——只回传结构化错误码，
    // 不回传原始 message（避免路径/用户名/主机名泄露；DS 评审 M2）。
    const classifyConfigError = (m) => {
      const s = String(m || "");
      if (/非合法 JSON/.test(s)) return "CONFIG_INVALID_JSON";
      if (/schemaVersion/.test(s)) return "CONFIG_SCHEMA_UNSUPPORTED";
      if (/配置不存在|文件不存在/.test(s)) return "CONFIG_MISSING";
      if (/projectRoot/.test(s)) return "PROJECT_ROOT_INVALID";
      if (/越界/.test(s)) return "PATH_OUT_OF_ROOT";
      if (/重复/.test(s)) return "DUPLICATE_NAME";
      if (/缺少/.test(s)) return "MISSING_FIELD";
      return "CONFIG_INVALID";
    };
    const configErrors = Object.entries(projectErrors || {})
      .map(([project, message]) => ({ project, code: classifyConfigError(message) }));
    const errCount = configErrors.length;
    return {
      ok: true, httpStatus: 200,
      version: SERVICE_VERSION,
      projects: items,
      configErrors,
      configErrorCount: errCount,
      queueDepth: queue.length,
      running: Boolean(running),
    };
  }

  // C9-MCP2: 任务列表（只读登记簿查询；phase 过滤 + 有界 limit，按创建时间倒序）
  function listTasks({ project, phase = null, limit = 20 } = {}) {
    const p = proj(project);
    if (!p) return errOut(404, "UNKNOWN_PROJECT", `项目未注册: ${project}`);
    let n = Number(limit);
    if (!Number.isFinite(n) || n < 1) n = 20;
    n = Math.min(Math.floor(n), 100);
    const reg = loadRegistry(p.config.registryFile);
    if (reg.ok === false) return errOut(500, "REGISTRY_CORRUPT", `项目登记簿损坏: ${reg.error}`);
    let tasks = reg.tasks.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (phase) tasks = tasks.filter((t) => t.phase === phase);
    const items = tasks.slice(0, n).map((t) => ({
      taskId: t.taskId,
      phase: t.phase,
      createdAt: t.createdAt || null,
      submittedAt: t.submittedAt || null,
      claimedBy: t.claimedBy || null,
      claimedAt: t.claimedAt || null,
      execution: t.execution || null,
      hasReport: !!t.reportFile,
      summary: t.summary ? String(t.summary).slice(0, 200) : null,
    }));
    return { ok: true, httpStatus: 200, project, total: reg.tasks.length, returned: items.length, tasks: items };
  }

  // 报告列表（只读，不含文件路径）：供外部识别"这些资源是什么"，并作为清理前的清单。
  function listReports({ project, limit = 20 } = {}) {
    const p = proj(project);
    if (!p) {
      if (projectErrors[project]) return errOut(400, "PROJECT_CONFIG_INVALID", `项目 ${project} 配置未加载`);
      return errOut(404, "UNKNOWN_PROJECT", `项目未注册: ${project}`);
    }
    let n = Number(limit);
    if (!Number.isFinite(n) || n < 1) n = 20;
    n = Math.min(Math.floor(n), 100);
    const reg = loadRegistry(p.config.registryFile);
    if (reg.ok === false) return errOut(500, "REGISTRY_CORRUPT", `项目登记簿损坏: ${reg.error}`);
    const withRep = reg.tasks
      .filter((t) => t.reportFile)
      .sort((a, b) => String(b.finishedAt || b.createdAt || "").localeCompare(String(a.finishedAt || a.createdAt || "")));
    const items = withRep.slice(0, n).map((t) => ({
      taskId: t.taskId,
      phase: t.phase,
      summary: t.summary ? String(t.summary).slice(0, 200) : null,
      finishedAt: t.finishedAt || null,
      createdAt: t.createdAt || null,
    }));
    return { ok: true, httpStatus: 200, project, total: withRep.length, returned: items.length, reports: items };
  }

  async function executeJob(job) {
    const rp = resolveProject(job.project);
    if (!rp.ok) {
      log(`[WORKER] ${job.taskId} 项目上下文不可用（${rp.code}: ${rp.message}），拒绝执行`);
      const px = projects.get(job.project);
      if (px && px.config) {
        const reg0 = loadRegistry(px.config.registryFile);
        if (reg0.ok !== false) {
          const t0 = findTask(reg0, { taskId: job.taskId });
          if (t0) { updatePhase(reg0, job.taskId, PHASES.FAILED, { stopReason: `${rp.code}: ${rp.message}` }); saveRegistry(px.config.registryFile, reg0); }
        }
      }
      return;
    }
    const p = rp.p;
    const startedAt = now();
    const reportToken = `C3R-${Date.now().toString(36)}-${idGen()}`;

    // 标记 RUNNING（崩溃后据此判为结果未知）
    let reg = loadRegistry(p.config.registryFile);
    if (reg.ok !== false) {
      const t = findTask(reg, { taskId: job.taskId });
      // 路由一致性：任务归属必须与执行项目一致，禁止错项目执行
      if (t && t.project && t.project !== job.project) {
        log(`[WORKER] ${job.taskId} 归属 ${t.project} 与执行项目 ${job.project} 不一致，拒绝执行`);
        updatePhase(reg, job.taskId, PHASES.FAILED, { stopReason: `PROJECT_ROUTE_MISMATCH: 任务归属 ${t.project}，执行项目 ${job.project}` });
        saveRegistry(p.config.registryFile, reg);
        return;
      }
      if (t && !t.project) t.project = job.project;
      // C9-R21: 已被 Agent 领取的任务、或标明由 Agent 执行的任务，本地 Worker 不再执行
      if (t && (t.claimedBy || t.execution === "agent")) {
        log(`[WORKER] ${job.taskId} 归属 Agent（claimedBy=${t.claimedBy || "-"}, execution=${t.execution || "-"}），本地 Worker 跳过执行`);
        return;
      }
      if (t) { t.startedAt = startedAt; updatePhase(reg, job.taskId, PHASES.RUNNING); saveRegistry(p.config.registryFile, reg); }
    }

    let ex;
    try {
      ex = await runWorker(job, { project: p, log });
      if (!ex || typeof ex !== "object") ex = { ok: false, results: [], reason: "worker 未返回结果" };
    } catch (e) {
      ex = { ok: false, results: [], reason: `执行异常: ${e.message}`, thrown: true };
      log(`[WORKER] ${job.taskId} 执行异常: ${e.message}`);
    }

    const finishedAt = now();
    const report = buildServiceReport({ job, ex, startedAt, finishedAt, reportToken });
    if (ex.thrown) {
      report.status = "UNKNOWN";
      report.failures = [ex.reason];
      report.note = "执行过程异常，结果未知；未自动重试，需人工复核。";
    }
    const file = reportFileOf(p, job.taskId);
    writeReportFile(file, report);

    const phase = ex.thrown
      ? PHASES.REPORT_UNKNOWN
      : (ex.ok ? PHASES.REPORTED : (report.status === "BLOCKED" ? PHASES.BLOCKED : PHASES.FAILED));
    reg = loadRegistry(p.config.registryFile);
    if (reg.ok !== false) {
      const t = findTask(reg, { taskId: job.taskId });
      if (t) { t.finishedAt = finishedAt; t.reportFile = file; }
      updatePhase(reg, job.taskId, phase, {
        results: ex.results || [],
        reportFile: file,
        reportToken,
        stopReason: ex.thrown ? ex.reason : (ex.ok ? undefined : (report.failures[0] || "执行失败")),
      });
      saveRegistry(p.config.registryFile, reg);
    }
    if (phase === PHASES.REPORTED) stats.completed++;
    else if (phase === PHASES.REPORT_UNKNOWN) stats.unknown++;
    else if (phase === PHASES.BLOCKED) stats.blocked++;
    else stats.failed++;
    log(`[WORKER] ${job.project}/${job.taskId} → phase=${phase} status=${report.status}`);
  }

  function wakeIdle() {
    if (draining || queue.length > 0) return;
    const waiters = idleWaiters.splice(0);
    for (const w of waiters) w({ ...stats });
  }

  // 单 Worker 排空队列：任一时刻只有一次 executeJob 在跑（严格顺序，不并行）
  function kick() {
    if (draining || stopping || queue.length === 0) return;
    draining = true;
    (async () => {
      try {
        while (queue.length > 0 && !stopping) {
          const job = queue.shift();
          running = job;
          try { await executeJob(job); }
          catch (e) { log(`[WORKER] 未捕获异常: ${e.message}`); stats.unknown++; }
          finally { running = null; }
        }
      } finally {
        draining = false;
        wakeIdle();
      }
    })();
  }

  function start() {
    if (started) return { recovered };
    started = true;
    for (const [, p] of projects) {
      const reg = loadRegistry(p.config.registryFile);
      if (reg.ok === false) { log(`[RECOVER] ${p.name} 登记簿损坏，跳过（不静默重建）: ${reg.error}`); continue; }
      let dirty = false;
      for (const t of reg.tasks) {
        if (t.phase === PHASES.RUNNING && t.claimedBy) {
          // C9-R21: 任务正被 Agent 持有（通过桥接领取）。结果尚未回来，属"等待中"而非"崩溃"，
          // 保守处理：保持 RUNNING、不重跑、不擅自判成功或失败；如确认 Agent 失联，由人工决定。
          t.recoveryNote = `startup: RUNNING 且已被 ${t.claimedBy} 领取 → 保持 RUNNING，等待结果提交（不自动重跑、不擅自判定）`;
          dirty = true;
          recovered.push({ project: p.name, taskId: t.taskId, from: PHASES.RUNNING, to: PHASES.RUNNING, heldBy: t.claimedBy });
          log(`[RECOVER] ${p.name}/${t.taskId} 仍由 ${t.claimedBy} 持有，保持 RUNNING（结果未回，不重试）`);
        } else if (t.phase === PHASES.RUNNING) {
          updatePhase(reg, t.taskId, PHASES.REPORT_UNKNOWN, { stopReason: "服务重启时该任务处于 RUNNING：结果未知，未自动重试" });
          t.recoveryNote = "startup: RUNNING → REPORT_UNKNOWN（不重试）";
          dirty = true;
          recovered.push({ project: p.name, taskId: t.taskId, from: PHASES.RUNNING, to: PHASES.REPORT_UNKNOWN });
          log(`[RECOVER] ${p.name}/${t.taskId} RUNNING → REPORT_UNKNOWN（结果未知，不重试）`);
        } else if (t.phase === PHASES.NEW && t.source === "api" && t.execution !== "agent" && autoExecute) {
          queue.push({ taskId: t.taskId, project: p.name, actions: t.actions || [], summary: t.summary || "", submittedAt: t.submittedAt ?? null });
          recovered.push({ project: p.name, taskId: t.taskId, from: PHASES.NEW, to: "QUEUED" });
          log(`[RECOVER] ${p.name}/${t.taskId} NEW(api) → 重新入队（从未执行，非结果未知）`);
        }
      }
      if (dirty) saveRegistry(p.config.registryFile, reg);
    }
    setImmediate(kick);
    return { recovered };
  }

  function awaitIdle(timeoutMs = 30000) {
    if (!draining && queue.length === 0) return Promise.resolve({ ...stats });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("awaitIdle 超时")), timeoutMs);
      idleWaiters.push((s) => { clearTimeout(timer); resolve(s); });
    });
  }

  return {
    version: SERVICE_VERSION,
    projects: [...projects.keys()],
    projectErrors,
    projectConfig: (name) => (proj(name) ? proj(name).config : null),
    token,
    tokenFile,
    stats,
    recovered,
    queueDepth: () => queue.length,
    isRunning: () => Boolean(running),
    submit, status, report, claimNext, submitResult, listProjects, listTasks, listReports, start, awaitIdle,
    stop: () => { stopping = true; },
  };
}

// ---------- HTTP 层（仅回环地址 + 令牌校验） ----------
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("请求体过大"), { code: "BODY_TOO_LARGE" })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) => reject(e));
  });
}

function sameToken(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

export function createHttpServer(service, { host = "127.0.0.1", port = 0, log = () => {} } = {}) {
  if (!LOOPBACK.has(host)) throw new Error(`只允许绑定回环地址，拒绝: ${host}`);

  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!LOOPBACK.has(req.socket.remoteAddress)) return send(res, 403, { ok: false, code: "FORBIDDEN", message: "仅允许本机访问" });

      let u;
      try { u = new URL(req.url, "http://127.0.0.1"); }
      catch { return send(res, 400, { ok: false, code: "BAD_REQUEST", message: "URL 非法" }); }
      const p = u.pathname;

      if (req.method === "GET" && p === "/v1/health") {
        return send(res, 200, { ok: true, service: service.version, projects: service.projects, queueDepth: service.queueDepth(), running: service.isRunning() });
      }

      // 其余端点一律要求令牌
      if (!sameToken(req.headers["x-auth-token"], service.token)) {
        return send(res, 401, { ok: false, code: "UNAUTHORIZED", message: "缺少或错误的 X-Auth-Token" });
      }

      if (req.method === "GET" && p === "/v1/projects") {
        const r = service.listProjects();
        const { httpStatus, ...rest } = r;
        return send(res, httpStatus, rest);
      }
      if (req.method === "GET" && p === "/v1/tasks") {
        const r = service.listTasks({
          project: u.searchParams.get("project"),
          phase: u.searchParams.get("phase") || null,
          limit: u.searchParams.get("limit") || 20,
        });
        const { httpStatus, ...rest } = r;
        return send(res, httpStatus, rest);
      }

      if (req.method === "POST" && p === "/v1/tasks") {
        let raw;
        try { raw = await readBody(req); }
        catch (e) { return send(res, e.code === "BODY_TOO_LARGE" ? 413 : 400, { ok: false, code: e.code || "BAD_BODY", message: e.message }); }
        let body;
        try { body = JSON.parse(raw || "{}"); }
        catch { return send(res, 400, { ok: false, code: "BAD_JSON", message: "请求体不是合法 JSON" }); }
        const r = service.submit(body);
        const { httpStatus, ...rest } = r;
        return send(res, httpStatus, rest);
      }

      const mTask = p.match(/^\/v1\/tasks\/([^/]+)$/);
      if (req.method === "GET" && mTask) {
        const r = service.status({ project: u.searchParams.get("project"), taskId: decodeURIComponent(mTask[1]) });
        const { httpStatus, ...rest } = r;
        return send(res, httpStatus, rest);
      }
      const mRep = p.match(/^\/v1\/tasks\/([^/]+)\/report$/);
      if (req.method === "GET" && mRep) {
        const r = service.report({ project: u.searchParams.get("project"), taskId: decodeURIComponent(mRep[1]) });
        const { httpStatus, ...rest } = r;
        return send(res, httpStatus, rest);
      }

      if (["POST", "GET"].includes(req.method) && p.startsWith("/v1/")) {
        return send(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", message: `不支持的方法或路径: ${req.method} ${p}` });
      }
      return send(res, 404, { ok: false, code: "NOT_FOUND", message: `未知路径: ${p}` });
    } catch (e) {
      log(`[HTTP] 未捕获异常: ${e.message}`);
      return send(res, 500, { ok: false, code: "INTERNAL", message: "服务内部错误" });
    }
  });

  return {
    server,
    host,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve({ host, port: server.address().port }));
    }),
    close: () => new Promise((resolve) => server.close(() => resolve(true))),
  };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = { port: 8787, projects: DEFAULT_PROJECTS_FILE, tokenFile: DEFAULT_TOKEN_FILE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = parseInt(argv[++i], 10) || 8787;
    if (argv[i] === "--projects") out.projects = argv[++i];
    if (argv[i] === "--token-file") out.tokenFile = argv[++i];
    // C9-R24: 只登记不执行，执行交给 collab_loop(--resume-new) 或 Agent(MCP 领取)
    if (argv[i] === "--queue-only") out.queueOnly = true;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
  let service;
  try {
    service = createTaskService({ projectsFile: opts.projects, tokenFile: opts.tokenFile, log, autoExecute: !opts.queueOnly });
  } catch (e) {
    console.error(`[FATAL] ${e.message}`);
    process.exitCode = 64;
    return;
  }
  service.start();
  const httpd = createHttpServer(service, { host: "127.0.0.1", port: opts.port, log });
  const { port } = await httpd.listen();
  log(`[LISTEN] http://127.0.0.1:${port} projects=${service.projects.join(",")} tokenFile=${opts.tokenFile}${opts.queueOnly ? " mode=queue-only（只登记，不自行执行）" : ""}`);
  if (service.recovered.length) log(`[RECOVER] ${JSON.stringify(service.recovered)}`);

  const shutdown = async (sig) => {
    log(`[STOP] 收到 ${sig}，停止接收新轮次并关闭服务（RUNNING 任务结果视为未知）`);
    service.stop();
    await httpd.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const __isMain = process.argv[1]
  && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (__isMain) {
  main().catch((e) => { console.error(`[FATAL] ${e.message}`); process.exitCode = 1; });
}
