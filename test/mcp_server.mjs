// C9-R21 MCP Server（stdio）：让真实编程 Agent 通过宿主正式支持的 MCP 通道领取任务、查询状态、提交结果。
// 设计要点:
//   - 单一事实来源：所有工具都调用 local_service 的同一套 claimNext / status / submitResult / listTasks / listProjects，
//     与 HTTP 接口复用同一队列、登记簿、项目配置与状态机（不另建队列）。
//   - 工具不暴露任何命令、可执行文件、shell 或任意路径参数；只能操作已注册项目内已登记的任务。
//   - 领取即落盘 NEW → RUNNING，保证同一任务不会被重复领取；本地 Worker 见到 claimedBy 会跳过执行。
//   - 结果提交必须带非空证据，且校验 project/taskId 归属与 phase；无证据不得标记为完成。
// 规范对齐（2025-06-18 / 2024-11-05）:
//   - initialize 版本协商：支持则原样返回，不支持则返回本服务器支持的最高版本（生命周期规范 MUST）；
//   - 工具入参按 inputSchema 校验（安全要求 MUST），违规返回 -32602 与精确原因；
//   - 工具执行错误以 result.isError=true 返回（双通道错误机制），协议错误用 JSON-RPC error；
//   - 协商到 2025-06-18 及以上时，tools/call 额外返回 structuredContent（同时保留 text 兼容）；
//   - 传输: 换行分隔的 JSON-RPC 2.0（stdout 只输出协议消息，日志一律走 stderr）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskService, DEFAULT_PROJECTS_FILE, DEFAULT_TOKEN_FILE } from "./local_service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MCP_PROTOCOL_VERSION = "2024-11-05"; // 默认/最低协商版本（兼容既有宿主）
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]; // 降序
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function parseArgs(argv) {
  const out = { projects: DEFAULT_PROJECTS_FILE, tokenFile: DEFAULT_TOKEN_FILE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--projects") out.projects = argv[++i];
    if (argv[i] === "--token-file") out.tokenFile = argv[++i];
  }
  return out;
}

const INSTRUCTIONS = [
  "agent-link：跨项目任务队列。用法：先用 agent_link_list_projects 发现项目，",
  "再用 agent_link_list_tasks 查看某项目的任务（可按 phase 过滤），",
  "agent_link_list_reports 列出已产出报告（只读，含任务摘要，便于识别/清理旧报告），",
  "agent_link_claim_next_task 领取（NEW→RUNNING，不会重复领取），",
  "agent_link_get_task 查询状态，agent_link_submit_result 提交结果（必须附非空证据）。",
  "注意：ok=true 仅代表动作已执行并有证据（ACTIONS_DONE），不代表任务目标完成。",
  "限制：所有工具均为快速只读/登记操作，notifications/cancelled 对其不产生中断效果。",
].join("\n");

export const TOOLS = [
  {
    name: "agent_link_list_projects",
    title: "列出已注册项目",
    description: "列出 agent-link 已注册的项目与健康状态（版本/队列深度/配置错误计数）。用于发现可接入的项目。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      required: ["ok", "projects", "configErrorCount", "queueDepth", "running"],
      properties: {
        ok: { type: "boolean" },
        version: { type: "string" },
        projects: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" }, hasRegistry: { type: "boolean" } },
            additionalProperties: false,
          },
        },
        configErrors: {
          type: "array",
          items: {
            type: "object",
            required: ["project", "code"],
            properties: { project: { type: "string" }, code: { type: "string" } },
            additionalProperties: false,
          },
        },
        configErrorCount: { type: "number" },
        queueDepth: { type: "number" },
        running: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "agent_link_list_tasks",
    title: "列出项目任务",
    description: "列出指定项目的任务（只读，按创建时间倒序，可按 phase 过滤，最多 100 条）。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "已注册项目名", maxLength: 120 },
        phase: { type: "string", description: "可选：按阶段过滤", enum: ["NEW", "QUEUED", "RUNNING", "REPORTED", "FAILED", "BLOCKED", "REPORT_UNKNOWN"] },
        limit: { type: "number", description: "可选：返回条数上限（默认 20，最大 100）", minimum: 1, maximum: 100 },
      },
      required: ["project"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["ok", "project", "total", "returned", "tasks"],
      properties: {
        ok: { type: "boolean" },
        project: { type: "string" },
        total: { type: "number" },
        returned: { type: "number" },
        tasks: {
          type: "array",
          items: {
            type: "object",
            required: ["taskId", "phase"],
            properties: {
              taskId: { type: "string" },
              phase: { type: "string" },
              createdAt: { type: ["string", "null"] },
              submittedAt: { type: ["string", "null"] },
              claimedBy: { type: ["string", "null"] },
              claimedAt: { type: ["string", "null"] },
              execution: { type: ["string", "null"] },
              hasReport: { type: "boolean" },
              summary: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "agent_link_list_reports",
    title: "列出项目报告",
    description: "列出指定项目已产出报告的元数据（只读，不含文件路径；含任务摘要/报告令牌/完成时间）。用于识别 MCP 资源里的报告是什么、以及清理旧报告前的清单。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "已注册项目名", maxLength: 120 },
        limit: { type: "number", description: "可选：返回条数上限（默认 20，最大 100）", minimum: 1, maximum: 100 },
      },
      required: ["project"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["ok", "project", "total", "returned", "reports"],
      properties: {
        ok: { type: "boolean" },
        project: { type: "string" },
        total: { type: "number" },
        returned: { type: "number" },
        reports: {
          type: "array",
          items: {
            type: "object",
            required: ["taskId", "phase"],
            properties: {
              taskId: { type: "string" },
              phase: { type: "string" },
              summary: { type: ["string", "null"] },
              finishedAt: { type: ["string", "null"] },
              createdAt: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "agent_link_claim_next_task",
    description: "领取 agent-link 中下一项待处理任务（NEW→RUNNING，不会重复领取）。可选 project 限定项目。",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "已注册项目名；省略则扫描全部注册项目", maxLength: 120 } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        task: { type: ["object", "null"] },
        message: { type: ["string", "null"] },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "agent_link_get_task",
    description: "查询指定任务的当前状态（phase / 时间 / 报告是否可用）。",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", maxLength: 120 }, taskId: { type: "string", maxLength: 120 } },
      required: ["project", "taskId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["ok", "task"],
      properties: { ok: { type: "boolean" }, task: { type: "object" } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "agent_link_submit_result",
    description: "提交已领取任务的执行结果。必须提供非空的可核验证据；ok=true 只代表动作已执行并有证据（ACTIONS_DONE），不代表任务目标完成。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", maxLength: 120 },
        taskId: { type: "string", maxLength: 120 },
        ok: { type: "boolean" },
        evidence: { description: "可核验证据：字符串 / 对象 / 数组（不得为空）" },
        summary: { type: "string", maxLength: 2000 },
        note: { type: "string", maxLength: 2000 },
        claimToken: { type: "string", description: "可选：领取时返回的 claimToken（用于租约校验与幂等重放）", maxLength: 80 },
      },
      required: ["project", "taskId", "ok", "evidence"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["ok", "phase"],
      properties: { ok: { type: "boolean" }, phase: { type: "string" }, report: { type: "object" } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

// ---- JSON Schema 校验（覆盖本服务器所需子集）----
// 支持：type（字符串或数组）/ enum / minimum / maximum / minLength / maxLength /
//       required / properties / items / additionalProperties。
// 规范安全要求：服务器必须校验所有工具输入。违规 → JSON-RPC -32602（协议错误），不进入服务层。
// 通用化版本同时用于 structuredContent 对 outputSchema 的校验（DS 评审第 3 点）。
export function validateSchema(value, schema, path = "value") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : null);
  const actual = Array.isArray(value) ? "array" : (value === null ? "null" : typeof value);
  if (types) {
    const ok = types.some((t) => {
      if (t === "number") return actual === "number" && Number.isFinite(value);
      return actual === t;
    });
    if (!ok) { errors.push(`${path}: 类型应为 ${types.join("|")}，实际 ${actual}`); return errors; }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: 取值必须是 ${schema.enum.join("/")}，实际 ${JSON.stringify(value).slice(0, 40)}`);
  if (actual === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: 不得小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: 不得大于 ${schema.maximum}`);
  }
  if (actual === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: 长度不得小于 ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: 长度不得大于 ${schema.maxLength}`);
  }
  if (actual === "object" && !Array.isArray(value) && value !== null) {
    for (const r of schema.required || []) {
      if (value[r] === undefined || value[r] === null) errors.push(`${path}.${r}: 缺少必填字段`);
    }
    for (const [k, v] of Object.entries(value)) {
      const ps = (schema.properties || {})[k];
      if (!ps) { if (schema.additionalProperties === false) errors.push(`${path}.${k}: 未知字段`); continue; }
      errors.push(...validateSchema(v, ps, `${path}.${k}`));
    }
  }
  if (actual === "array" && schema.items) {
    value.forEach((v, i) => errors.push(...validateSchema(v, schema.items, `${path}[${i}]`)));
  }
  return errors;
}

export function validateToolArgs(tool, args) {
  const schema = tool && tool.inputSchema;
  if (!schema || schema.type !== "object" || typeof args !== "object" || args === null || Array.isArray(args)) {
    return ["arguments 必须是对象"];
  }
  return validateSchema(args, schema, "arguments");
}

function negotiateVersion(requested) {
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return LATEST_PROTOCOL_VERSION; // 生命周期规范：不支持请求版本时返回服务器支持的（最高）版本
}

// state: { negotiatedVersion, initialized } 由调用方持有并跨消息传递（stdio main 循环持有）。
// 生命周期状态机（DS 第 2/7 点）：initialize 必须是首次交互；initialize/ping 之外的请求在
// 初始化完成前一律拒绝（-32002 Server not initialized）；重复 initialize 拒绝（-32600）。
export function handleRequest(service, msg, log = () => {}, state = { negotiatedVersion: MCP_PROTOCOL_VERSION, initialized: false }) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    if (state.initialized) {
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "重复 initialize：本会话已完成初始化" } };
    }
    const negotiated = negotiateVersion(params?.protocolVersion);
    state.negotiatedVersion = negotiated;
    state.initialized = true;
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: negotiated,
        capabilities: {
          tools: { listChanged: false },
          // resources：仅 list/read 只读；不做 subscribe（DS 评审：stdio 下订阅需要先定状态来源与
          // 推送机制，避免半成品），故 subscribe:false 且不发送 notifications/resources/updated。
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: "agent-web-link", version: service.version },
        instructions: INSTRUCTIONS,
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  // 初始化前只允许 initialize/ping（生命周期规范；DS 评审第 2 点）
  if (!state.initialized && !isNotification) {
    return { jsonrpc: "2.0", id, error: { code: -32002, message: "Server not initialized", data: { required: "initialize" } } };
  }
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

  // ---- resources（只读：list/read；不做 subscribe）----
  // 截断语义（DS 评审第 3 点）：上限 100，超出时结果带 truncated=true（无分页 cursor，与"不做分页"决定一致）。
  if (method === "resources/list") {
    const out = [];
    let total = 0;
    const lp = service.listProjects();
    for (const p of lp.projects || []) {
      const lt = service.listTasks({ project: p.name, limit: 100 });
      for (const t of lt.tasks || []) {
        if (!t.hasReport) continue;
        total++;
        if (out.length < 100) {
          const sum = t.summary ? `：${String(t.summary).replace(/\s+/g, " ").slice(0, 80)}` : "";
          out.push({
            uri: `agent-link://report/${encodeURIComponent(p.name)}/${encodeURIComponent(t.taskId)}`,
            name: `${p.name}/${t.taskId}`,
            description: `任务报告（phase=${t.phase}）${sum}`,
            mimeType: "application/json",
          });
        }
      }
    }
    return { jsonrpc: "2.0", id, result: { resources: out, _meta: { truncated: total > out.length } } };
  }
  if (method === "resources/read") {
    const uri = String(params?.uri || "");
    const m = uri.match(/^agent-link:\/\/report\/([^/]+)\/([^/]+)$/);
    if (!m) return { jsonrpc: "2.0", id, error: { code: -32602, message: `未知资源 URI: ${uri.slice(0, 100)}` } };
    let project, taskId;
    try { project = decodeURIComponent(m[1]); taskId = decodeURIComponent(m[2]); }
    catch { return { jsonrpc: "2.0", id, error: { code: -32602, message: "资源 URI 解码失败" } }; }
    // 路径安全（DS 评审第 1 点，最高优先）：两段 URI 段绝不拼接文件路径——
    // 先按注册项目名精确匹配（proj 白名单）→ 再按 taskId 在登记簿精确查找 → 只读登记簿记录的路径。
    // 此处再加 taskId 格式纵深防御（与登记簿 taskId 规则一致），穿越/分隔符直接拒绝。
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(taskId)) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `非法 taskId: ${taskId.slice(0, 60)}` } };
    }
    const r = service.report({ project, taskId });
    if (!r.ok) {
      const { httpStatus, ...rest } = r;
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `资源读取失败: ${rest.code || "UNKNOWN"} ${rest.message || ""}`.trim() } };
    }
    // 读报告审计（DS：把"谁能读"变成可验证）；归属由 registry 精确查找保证
    try {
      const cfg = service.projectConfig(project);
      if (cfg && cfg.stateDir) {
        fs.mkdirSync(cfg.stateDir, { recursive: true });
        fs.appendFileSync(path.join(cfg.stateDir, "audit.log"), JSON.stringify({ at: new Date().toISOString(), action: "read-report", project, taskId }) + "\n", "utf8");
      }
    } catch {}
    return {
      jsonrpc: "2.0", id,
      result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(r.report, null, 2) }] },
    };
  }

  // 通知类：initialized（握手完成）/ cancelled（本服务器操作均为快速只读或登记操作，无需取消）→ 忽略
  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;

  if (method === "tools/call") {
    if (isNotification) return null; // 通知不执行不回包
    const name = params?.name;
    const args = params?.arguments || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `未知工具: ${name}` } };
    const vErrs = validateToolArgs(tool, args);
    if (vErrs.length) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `参数校验失败: ${vErrs.join("; ")}` } };
    }
    const t0 = Date.now();
    let res;
    try {
      if (name === "agent_link_claim_next_task") res = service.claimNext({ project: args.project || null, claimedBy: "mcp" });
      else if (name === "agent_link_get_task") res = service.status({ project: args.project, taskId: args.taskId });
      else if (name === "agent_link_list_projects") res = service.listProjects();
      else if (name === "agent_link_list_tasks") res = service.listTasks({ project: args.project, phase: args.phase || null, limit: args.limit ?? 20 });
      else if (name === "agent_link_list_reports") res = service.listReports({ project: args.project, limit: args.limit ?? 20 });
      else res = service.submitResult({
        project: args.project, taskId: args.taskId, ok: args.ok,
        evidence: args.evidence, summary: args.summary ?? null, note: args.note ?? null,
        claimToken: args.claimToken ?? null,
      });
    } catch (e) {
      log(`[MCP][AUDIT] id=${String(id).slice(0, 40)} tool=${name} ok=false ms=${Date.now() - t0} error=${e.message}`);
      log(`[MCP] 工具异常 ${name}: ${e.message}`);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `工具执行异常: ${e.message}` }], isError: true } };
    }
    // 最小审计日志（DS 评审：request id/工具名/结果/耗时，不记录参数内容）
    log(`[MCP][AUDIT] id=${String(id).slice(0, 40)} tool=${name} ok=${!!res.ok} ms=${Date.now() - t0}`);
    const { httpStatus, ...rest } = res;
    const text = JSON.stringify(rest, null, 2);
    // 2025-06-18+：对象结果附加 structuredContent，同时保留 text（规范 SHOULD 向后兼容）；
    // structuredContent 必须符合该工具 outputSchema（DS 评审：契约闭合），不符则告警并省略。
    const result = { content: [{ type: "text", text }] };
    if (state.negotiatedVersion === "2025-06-18" && rest && typeof rest === "object" && !Array.isArray(rest)) {
      const oErrs = tool.outputSchema ? validateSchema(rest, tool.outputSchema, "structuredContent") : [];
      if (oErrs.length) {
        log(`[MCP] structuredContent 不符合 ${name}.outputSchema: ${oErrs.join("; ")}`);
      } else {
        result.structuredContent = rest;
      }
    }
    if (res.ok) return { jsonrpc: "2.0", id, result };
    result.isError = true;
    return { jsonrpc: "2.0", id, result };
  }

  if (isNotification) return null;                       // 通知类消息不回包
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `不支持的方法: ${method}` } };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (m) => process.stderr.write(`[${new Date().toISOString()}] ${m}\n`);
  let service;
  try {
    service = createTaskService({ projectsFile: opts.projects, tokenFile: opts.tokenFile, log });
  } catch (e) {
    log(`[FATAL] ${e.message}`);
    process.exit(64);
  }
  service.start();
  log(`[MCP] agent-link MCP Server 已启动 projects=${service.projects.join(",")}`);

  const state = { negotiatedVersion: MCP_PROTOCOL_VERSION };
  let closed = false;
  const shutdown = (why) => { if (!closed) { closed = true; log(`[MCP] ${why}，退出`); process.exit(0); } };

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } }) + "\n"); continue; }
      const out = handleRequest(service, msg, log, state);
      if (out) process.stdout.write(JSON.stringify(out) + "\n");
    }
  });
  process.stdin.on("end", () => shutdown("stdin 关闭"));
  process.stdin.on("error", (e) => { log(`[MCP] stdin 错误: ${e.message}`); shutdown("stdin 错误"); });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const __isMain = process.argv[1]
  && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (__isMain) main();
