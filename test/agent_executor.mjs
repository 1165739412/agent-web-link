// C9 任务执行器：白名单动作执行 + 项目边界强制
// 安全规则:
//   - 仅允许 op: node_check（语法检查）、run_project_tests（固定测试命令，无参数）、agent_dispatch（C9-R16 新增，见下）
//   - target 必须解析到项目根目录内且真实存在；越界/不存在/类型不符 → 拒绝（BLOCKED）
//   - PROJECT_ROOT 由调用方注入（迁移到其他项目时只改配置，不改本模块逻辑）
// C9-R16 真实 agent 执行入口（最小安全接通）:
//   - agent_dispatch 仅在调用方显式注入 agentCommand(固定 command+args，白名单单一命令、禁止任务内容插值) 时可用；
//   - 默认 agentCommand=null → 该 op 被拒绝(BLOCKED)，与 R13"不开放任意 Shell"边界一致；
//   - 与 run_project_tests 同安全模型：命令来自配置而非任务内容，无任意 Shell、无路径校验绕过。
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const ALLOWED_OPS = ["node_check", "run_project_tests", "agent_dispatch"];

// C9-R20: 非阻塞执行（本地服务使用）。spawnSync 会把 HTTP 事件循环锁死最长 120s，
// 导致"执行中查询状态/健康检查"全部挂起；这里用 spawn + Promise 提供等价语义（白名单不变）。
function runAsync(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < 200000) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 200000) stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ status: null, signal: null, timedOut, stdout, stderr, error: e }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ status: code, signal, timedOut, stdout, stderr }); });
  });
}

export function makeExecutor({ projectRoot, projectTests = [], agentCommand = null, log = () => {} }) {
  const root = path.resolve(projectRoot);
  const agentCmd = agentCommand;
  const withinRoot = (p) => {
    const rel = path.relative(root, p);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  return {
    root,
    // 校验单个动作（纯函数，供测试直接调用）
    validateAction(a) {
      if (!a || typeof a !== "object") return { ok: false, reason: "动作必须是对象" };
      if (!ALLOWED_OPS.includes(a.op)) return { ok: false, reason: `不允许的操作: ${JSON.stringify(a.op)}` };
      if (a.op === "node_check") {
        if (typeof a.target !== "string" || !a.target.trim()) return { ok: false, reason: "node_check 缺少 target" };
        const abs = path.resolve(root, a.target);
        if (!withinRoot(abs)) return { ok: false, reason: `目标越界: ${a.target} 不在项目根目录内` };
        if (!fs.existsSync(abs)) return { ok: false, reason: `目标不存在: ${a.target}` };
        if (!/\.(mjs|js|cjs)$/i.test(abs)) return { ok: false, reason: `目标不是 JS 文件: ${a.target}` };
        return { ok: true, abs };
      }
      if (a.op === "run_project_tests") {
        if (!projectTests.length) return { ok: false, reason: "项目未配置测试命令" };
        return { ok: true };
      }
      if (a.op === "agent_dispatch") {
        if (!agentCmd || typeof agentCmd.command !== "string" || !agentCmd.command.trim()) {
          return { ok: false, reason: "未配置 agent 命令（agentCommand 为空），agent_dispatch 不可用" };
        }
        if (!Array.isArray(agentCmd.args)) return { ok: false, reason: "agentCommand.args 必须是数组" };
        return { ok: true };
      }
      return { ok: false, reason: "未知操作" };
    },
    // 执行动作列表（真实执行，仅白名单）
    // opts.taskContext: 任务上下文（C9-R16 agent_dispatch 任务感知用，写入固定 drop 文件，避免命令行插值）
    executeActions(actions, opts = {}) {
      const results = [];
      for (const a of Array.isArray(actions) ? actions : []) {
        const v = this.validateAction(a);
        if (!v.ok) {
          log(`[EXEC] 拒绝: ${v.reason}`);
          results.push({ action: a, ok: false, blocked: true, reason: v.reason });
          continue;
        }
        if (a.op === "node_check") {
          const t0 = Date.now();
          const out = spawnSync(process.execPath, ["--check", v.abs], { encoding: "utf8", timeout: 30000 });
          const ok = out.status === 0;
          log(`[EXEC] node_check ${a.target} → ${ok ? "通过" : "失败"} (${Date.now() - t0}ms)`);
          results.push({
            action: a, ok, blocked: false,
            exitCode: out.status,
            stderr: (out.stderr || "").slice(0, 500),
            elapsedMs: Date.now() - t0,
          });
        } else if (a.op === "run_project_tests") {
          const sub = [];
          let allOk = true;
          for (const cmd of projectTests) {
            const t0 = Date.now();
            const out = spawnSync(cmd.command, cmd.args, { cwd: root, encoding: "utf8", timeout: 120000 });
            const ok = out.status === 0;
            if (!ok) allOk = false;
            log(`[EXEC] ${cmd.command} ${cmd.args.join(" ")} → ${ok ? "通过" : "失败"} (${Date.now() - t0}ms)`);
            sub.push({ command: cmd.command, args: cmd.args, ok, exitCode: out.status });
          }
          results.push({ action: a, ok: allOk, blocked: false, results: sub });
        } else if (a.op === "agent_dispatch") {
          // C9-R16：触发真实 agent 执行（安全边界内）。agentCmd 来自配置(固定 command+args)，
          // 命令内容不与任务内容插值，避免任意 Shell；仅当 agentCommand 已配置时才会执行到此。
          // 任务感知：若配置了 taskFile，先把本轮任务上下文写入该固定文件，命令从文件读取任务（不做命令行插值）。
          if (agentCmd.taskFile) {
            const tf = path.resolve(root, agentCmd.taskFile);
            try {
              fs.mkdirSync(path.dirname(tf), { recursive: true });
              fs.writeFileSync(tf, JSON.stringify(opts.taskContext || {}, null, 2), "utf8");
            } catch (e) {
              log(`[EXEC] agent_dispatch 写入 drop 文件失败: ${e.message}`);
              results.push({ action: a, ok: false, blocked: false, reason: `写入任务 drop 文件失败: ${e.message}` });
              continue;
            }
          }
          const t0 = Date.now();
          const out = spawnSync(agentCmd.command, agentCmd.args || [], { cwd: root, encoding: "utf8", timeout: 120000 });
          const ok = out.status === 0;
          log(`[EXEC] agent_dispatch ${agentCmd.command} → ${ok ? "通过" : "失败"} (${Date.now() - t0}ms)`);
          results.push({
            action: a, ok, blocked: false,
            exitCode: out.status,
            stdout: (out.stdout || "").slice(0, 1000),
            stderr: (out.stderr || "").slice(0, 1000),
            elapsedMs: Date.now() - t0,
          });
        }
      }
      return { ok: results.length > 0 && results.every((r) => r.ok), results };
    },
    // C9-R20: 异步版本（语义与 executeActions 完全一致：同一套白名单与校验，仅不阻塞事件循环）
    async executeActionsAsync(actions, opts = {}) {
      const results = [];
      for (const a of Array.isArray(actions) ? actions : []) {
        const v = this.validateAction(a);
        if (!v.ok) {
          log(`[EXEC] 拒绝: ${v.reason}`);
          results.push({ action: a, ok: false, blocked: true, reason: v.reason });
          continue;
        }
        if (a.op === "node_check") {
          const t0 = Date.now();
          const out = await runAsync(process.execPath, ["--check", v.abs], { cwd: root, timeoutMs: 30000 });
          const ok = out.status === 0;
          log(`[EXEC] node_check ${a.target} → ${ok ? "通过" : "失败"} (${Date.now() - t0}ms)`);
          results.push({ action: a, ok, blocked: false, exitCode: out.status, stderr: (out.stderr || "").slice(0, 500), elapsedMs: Date.now() - t0 });
        } else if (a.op === "run_project_tests") {
          const sub = [];
          let allOk = true;
          for (const cmd of projectTests) {
            const t0 = Date.now();
            const out = await runAsync(cmd.command, cmd.args, { cwd: root, timeoutMs: 120000 });
            const ok = out.status === 0;
            if (!ok) allOk = false;
            log(`[EXEC] ${cmd.command} ${cmd.args.join(" ")} → ${ok ? "通过" : "失败"} (${Date.now() - t0}ms)`);
            sub.push({ command: cmd.command, args: cmd.args, ok, exitCode: out.status });
          }
          results.push({ action: a, ok: allOk, blocked: false, results: sub });
        } else if (a.op === "agent_dispatch") {
          if (agentCmd.taskFile) {
            const tf = path.resolve(root, agentCmd.taskFile);
            try {
              fs.mkdirSync(path.dirname(tf), { recursive: true });
              fs.writeFileSync(tf, JSON.stringify(opts.taskContext || {}, null, 2), "utf8");
            } catch (e) {
              log(`[EXEC] agent_dispatch 写入 drop 文件失败: ${e.message}`);
              results.push({ action: a, ok: false, blocked: false, reason: `写入任务 drop 文件失败: ${e.message}` });
              continue;
            }
          }
          const t0 = Date.now();
          const out = await runAsync(agentCmd.command, agentCmd.args || [], { cwd: root, timeoutMs: 120000 });
          const ok = out.status === 0;
          log(`[EXEC] agent_dispatch ${agentCmd.command} → ${ok ? "通过" : "失败"} (${Date.now() - t0}ms)`);
          results.push({
            action: a, ok, blocked: false, exitCode: out.status,
            stdout: (out.stdout || "").slice(0, 1000), stderr: (out.stderr || "").slice(0, 1000),
            elapsedMs: Date.now() - t0,
          });
        }
      }
      return { ok: results.length > 0 && results.every((r) => r.ok), results };
    },
  };
}
