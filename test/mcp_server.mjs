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
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveLane, cdpHostOf, laneIdFromProject, markBrowserPid, releaseLane } from "./browser_lanes.mjs";
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
  "",
  "浏览器工具（browser_open / browser_status / send_message）会操作本机已登录的 DeepSeek/ChatGPT，",
  "登录只能由用户手动完成。多项目并行规则（重要）：",
  "1) 每次调用浏览器工具时，请把你负责的项目名一起传进 project 参数（与任务工具用同一个项目名）；",
  "   服务端会据此使用该项目的独立浏览器通道，多个项目即可并行收发，不会挤进同一个窗口。",
  "2) 也可以显式传 lane 指定通道；两者不要同时传。两者都不传则使用共享主通道（default，端口 9222），",
  "   该通道内并发发送会返回 RELAY_BUSY（锁保护，防重复发送），需稍后重试。",
  "3) 若返回 LANE_NOT_FOUND，说明该项目通道尚未创建：请先调用 browser_open 带上同一个 project/lane，",
  "   启动后提醒用户完成登录，再重试发送。",
  "4) 若 send_message 因宿主工具超时（常见 30s）被切断，而 DeepSeek/ChatGPT 生成长回复需要 1-3 分钟：",
  "   **绝对不要重发**（会发出重复消息）。改用 agent_link_read_reply（只读，可反复调用）把已生成的回复读回来；",
  "   它会返回 lastUserText 供你确认回复归属，并默认清除卡住后续发送的待确认记录。",
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
  {
    name: "agent_link_browser_open",
    title: "启动调试浏览器并打开网页",
    description: "启动带远程调试端口的 Chromium（自动探测 Chrome/Edge/Chromium）并打开 DeepSeek/ChatGPT 或指定 URL。登录由用户在页面内手动完成；本工具不处理账号/验证码。多项目并行：用 lane 指定独立浏览器实例（默认 default=9222），新 lane 会分配新端口与独立登录 profile，首次需你手动登录一次。返回 CDP 地址与就绪提示，供后续发送前确认。",
    inputSchema: {
      type: "object",
      properties: {
        backend: { type: "string", enum: ["deepseek", "chatgpt"], description: "默认打开的网站（默认 deepseek）" },
        url: { type: "string", description: "覆盖要打开的 URL（可选）" },
        port: { type: "integer", minimum: 1, maximum: 65535, description: "显式覆盖 CDP 端口（默认取 lane 的端口；一般不需要传）" },
        lane: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$", description: "浏览器通道（默认 default）。不同通道=独立浏览器实例（端口+登录 profile）+独立发送锁，可真正并行；同通道内仍串行。新通道首次需你手动登录一次。" },
        project: { type: "string", maxLength: 120, description: "你的项目名。传了它就会自动使用该项目的独立通道（等价于按项目名派生 lane），多个项目即可并行而不挤同一窗口；不要与 lane 同时用。" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["ok", "cdpHost", "url"],
      properties: {
        ok: { type: "boolean" }, alreadyUp: { type: "boolean" }, cdpHost: { type: "string" },
        url: { type: "string" }, openedTab: { type: "boolean" }, attached: { type: "boolean" },
        reason: { type: "string" }, hint: { type: "string" }, lane: { type: "string" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "agent_link_browser_status",
    title: "诊断浏览器调试通道",
    description: "只读诊断浏览器调试通道：CDP 是否可达、有无聊天页、指定会话是否打开、登录/输入框是否就绪。不发送、不操作，供发送前确认与失败排查。用 lane 选择要诊断的浏览器实例（默认 default）。",
    inputSchema: {
      type: "object",
      properties: {
        backend: { type: "string", enum: ["deepseek", "chatgpt"], description: "仅检查该后端的聊天页（可选）" },
        conv: { type: "string", description: "检查是否打开了包含该会话 ID 的标签页（可选）" },
        lane: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$", description: "浏览器通道（默认 default）。诊断该通道对应的浏览器实例。" },
        project: { type: "string", maxLength: 120, description: "你的项目名。传了它就诊断该项目的独立通道（等价于按项目名派生 lane）。" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["cdp", "chatPages", "convFound", "hints"],
      properties: {
        cdp: { type: "object" }, chatPages: { type: "array", items: { type: "string" } },
        convFound: { type: "boolean" }, hints: { type: "array", items: { type: "string" } }, ready: { type: "boolean" },
        reason: { type: "string" }, lane: { type: "string" },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "agent_link_send_message",
    title: "向 DeepSeek/ChatGPT 发送消息并读回",
    description: "通过本机已登录的聊天网页（DeepSeek/ChatGPT）发送一条消息并读回最新回复。要求对应 lane 的浏览器已运行且目标网页已登录。多项目并行：各项目用各自 lane（独立浏览器+独立发送锁），互不阻塞；同一 lane 内并发会返回 RELAY_BUSY（需稍后重试）。失败返回可读原因（hint，含启动/登录/网络建议）。绝不自动重发。",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 20000, description: "要发送的消息内容" },
        backend: { type: "string", enum: ["deepseek", "chatgpt", "auto"], description: "目标后端（默认 auto：按配置/打开的页面自动选择）" },
        conv: { type: "string", description: "定向到包含该会话 ID 的标签页（可选）" },
        lane: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$", description: "浏览器通道（默认 default）。多项目并行时各用各的 lane：独立浏览器实例+独立发送锁，互不阻塞；同 lane 内并发会返回 RELAY_BUSY。" },
        project: { type: "string", maxLength: 120, description: "你的项目名。传了它就自动使用该项目的独立通道（等价于按项目名派生 lane）；多个项目各自传入自己的 project，即可并行而不挤同一窗口。不要与 lane 同时用。" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["ok", "replyText", "targetUrl", "backend"],
      properties: {
        ok: { type: "boolean" }, replyText: { type: "string" }, targetUrl: { type: "string" },
        backend: { type: "string" }, reason: { type: "string" }, hint: { type: "string" }, lane: { type: "string" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "agent_link_read_reply",
    title: "只读读回最近一条回复",
    description: "只读读取目标会话（DeepSeek/ChatGPT）最后一条助手回复，不发送、不输入、不导航。用于「消息已发出、但读回被宿主超时切断」的恢复——此时绝不能重发（重发会发出重复消息）。可反复调用，直到回复生成完毕。默认顺带清除匹配的待确认记录，使后续发送不再被护栏阻断（keepPending=true 可保留）。返回 lastUserText 供你自行确认回复归属。",
    inputSchema: {
      type: "object",
      properties: {
        backend: { type: "string", enum: ["deepseek", "chatgpt"], description: "仅在多个后端都有聊天页时指定读哪一个（可选）" },
        conv: { type: "string", description: "定向读取包含该会话 ID 的标签页（可选）" },
        project: { type: "string", maxLength: 120, description: "你的项目名（与发送时一致），用于定位该项目的独立通道" },
        lane: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}$", description: "浏览器通道（默认 default）" },
        keepPending: { type: "boolean", description: "true=不清除待确认记录（默认 false：清除，避免卡住后续发送）" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["ok", "replyText", "targetUrl"],
      properties: {
        ok: { type: "boolean" }, replyText: { type: "string" }, targetUrl: { type: "string" },
        convId: { type: "string" }, backend: { type: "string" }, replyId: { type: "string" },
        lastUserText: { type: "string" }, assistantCount: { type: "integer" },
        clearedPending: { type: "object" }, reason: { type: "string" }, hint: { type: "string" }, lane: { type: "string" },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

// ---- JSON Schema 校验（覆盖本服务器所需子集）----
// 支持：type（字符串或数组）/ enum / minimum / maximum / minLength / maxLength / pattern /
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
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: 不匹配格式 ${schema.pattern}`);
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
      else if (name === "agent_link_browser_open") {
        // 通道选择：显式 lane 优先；否则按 project 派生（多项目场景下"不说也会"拿到独立通道）
        const laneRef = args.lane || (args.project ? laneIdFromProject(args.project) : null);
        const lane = resolveLane(laneRef);
        if (!lane.ok) {
          res = { ok: false, lane: String(laneRef || "default"), cdpHost: "http://127.0.0.1:9222", url: args.url || "https://chat.deepseek.com/", alreadyUp: false, openedTab: false, reason: lane.reason, hint: lane.hint };
        } else {
          const port = args.port ?? lane.port;
          const cliArgs = [path.join(__dirname, "browser_launcher.mjs"), "--backend", args.backend || "deepseek", "--port", String(port), "--profile", lane.profile];
          if (args.url) cliArgs.push("--url", args.url);
          // 私有通道（非 default）：只允许附着于本通道此前拉起的实例，避免连上别人的浏览器
          if (!lane.builtin) cliArgs.push("--strict", "--expect-pid", String(lane.browserPid ?? 0));
          let r;
          try {
            r = JSON.parse(execFileSync(process.execPath, cliArgs, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }));
          } catch (e) {
            r = { ok: false, cdpHost: cdpHostOf(port), url: args.url || "https://chat.deepseek.com/", hint: `启动浏览器失败: ${e.message}` };
          }
          if (r.ok && !lane.builtin && Number.isInteger(r.pid)) markBrowserPid(lane.lane, r.pid);
          if (!r.ok && r.reason === "PORT_OCCUPIED") {
            // 端口被外部占用：释放该通道注册，避免端口号被永久占死（有发送记录时不释放）
            const rel = releaseLane(lane.lane);
            res = {
              ok: false, lane: lane.lane, cdpHost: r.cdpHost || cdpHostOf(port), url: r.url || args.url || "https://chat.deepseek.com/",
              alreadyUp: false, openedTab: false, reason: "PORT_OCCUPIED",
              hint: `${r.hint}${rel.ok && rel.removed ? "（已释放该通道注册，下次将分配其他端口）" : ""}`,
            };
          } else {
            res = { ok: !!r.ok, lane: lane.lane, cdpHost: r.cdpHost, url: r.url, alreadyUp: !!r.alreadyUp, openedTab: !!r.openedTab, attached: !!r.attached, hint: r.hint };
          }
        }
      } else if (name === "agent_link_browser_status") {
        const laneRef = args.lane || (args.project ? laneIdFromProject(args.project) : null);
        const lane = resolveLane(laneRef, { create: false });
        if (!lane.ok) {
          res = { ok: false, lane: String(laneRef || "default"), cdp: { up: false }, chatPages: [], convFound: false, hints: [lane.hint], hint: lane.hint, ready: false, reason: lane.reason };
        } else {
          const tmp = path.join(os.tmpdir(), `agent-link-diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
          const cliArgs = [path.join(__dirname, "relay.mjs"), "--diag", "--cdp", cdpHostOf(lane.port), "--json-out", tmp];
          if (args.backend) cliArgs.push("--backend", args.backend);
          if (args.conv) cliArgs.push("--conv", args.conv);
          let d = null;
          let childErr = null;
          try {
            execFileSync(process.execPath, cliArgs, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
          } catch (e) { childErr = e; }
          // 优先读文件：子进程可能 fast-fail 崩溃（Windows/Node24 下 process.exit 与未关闭 socket 冲突），
          // 但 --json-out 是 tmp+rename 原子落盘，要么完整、要么不存在（DS 评审 P1-3）。
          try { if (fs.existsSync(tmp)) d = JSON.parse(fs.readFileSync(tmp, "utf8")); } catch (e) { childErr = childErr || { message: `诊断结果解析失败: ${e.message}` }; }
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
          if (!d || typeof d !== "object") {
            // 文件缺失/损坏 → 回退到子进程退出码与 stderr 尾部，给出可读原因而不是空结果
            const tail = childErr ? String(childErr.stderr || childErr.message || "").split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 200) : "";
            d = { cdp: { up: false }, chatPages: [], convFound: false, hints: [`诊断未取得结果${childErr && childErr.status ? `（子进程退出码 ${childErr.status}）` : ""}${tail ? `：${tail}` : ""}`] };
          }
          // 多通道场景：非 default 通道的浏览器没起来时，明确提示"启动这个 lane"，而不是笼统的 9222
          if (d.cdp && d.cdp.up === false && lane.lane !== "default") {
            d.hints = [`通道 ${lane.lane} 的浏览器未启动（${cdpHostOf(lane.port)}）；请调用 agent_link_browser_open { "lane": "${lane.lane}" } 启动并登录`, ...(d.hints || [])];
          }
          const ready = d.cdp && d.cdp.up && d.chatPages.length > 0 && (args.conv ? d.convFound : true)
            && (d.hints || []).some((h) => h.includes("可以发送"));
          res = { ok: true, lane: lane.lane, cdp: d.cdp, chatPages: d.chatPages || [], convFound: !!d.convFound, hints: d.hints || [], ready };
        }
      } else if (name === "agent_link_send_message") {
        const laneRef = args.lane || (args.project ? laneIdFromProject(args.project) : null);
        const lane = resolveLane(laneRef, { create: false });
        if (!lane.ok) {
          res = { ok: false, lane: String(laneRef || "default"), replyText: "", targetUrl: "", backend: "", reason: lane.reason, hint: lane.hint };
        } else {
          const tmp = path.join(os.tmpdir(), `agent-link-relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
          const cliArgs = [path.join(__dirname, "relay.mjs"), "--text", String(args.message), "--cdp", cdpHostOf(lane.port), "--state-dir", lane.stateDir];
          if (args.backend && args.backend !== "auto") cliArgs.push("--backend", args.backend);
          if (args.conv) cliArgs.push("--conv", args.conv);
          cliArgs.push("--json-out", tmp);
          // 超时必须大于 relay 的 replyTimeoutMs（默认 180s），否则慢回复会被误杀、且已发出的消息被护栏阻断重发
          let childErr = null;
          try { execFileSync(process.execPath, cliArgs, { encoding: "utf8", timeout: 210000, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { childErr = e; }
          let r = null;
          // 优先读原子落盘的 --json-out；文件缺失/损坏时回退到子进程退出码与 stderr（DS 评审 P1-3）
          try { if (fs.existsSync(tmp)) r = JSON.parse(fs.readFileSync(tmp, "utf8")); } catch (e) { childErr = childErr || { message: `发送结果解析失败: ${e.message}` }; }
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
          if (!r || typeof r !== "object") {
            const tail = childErr ? String(childErr.stderr || childErr.message || "").split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 200) : "";
            r = {
              ok: false, replyText: "", targetUrl: "", backend: "", reason: "RELAY_NO_RESULT",
              hint: `通道 ${lane.lane} 未取得发送结果${childErr && childErr.status ? `（子进程退出码 ${childErr.status}）` : ""}${tail ? `：${tail}` : ""}。请确认该通道浏览器已启动并登录（agent_link_browser_open 带同一 lane/project）`,
            };
          }
          res = { ok: !!r.ok, lane: lane.lane, replyText: r.replyText || "", targetUrl: r.targetUrl || "", backend: r.backend || "", reason: r.reason || undefined, hint: r.hint || undefined };
        }
      } else if (name === "agent_link_read_reply") {
        const laneRef = args.lane || (args.project ? laneIdFromProject(args.project) : null);
        const lane = resolveLane(laneRef, { create: false });
        if (!lane.ok) {
          res = { ok: false, lane: String(laneRef || "default"), replyText: "", targetUrl: "", reason: lane.reason, hint: lane.hint };
        } else {
          const tmp = path.join(os.tmpdir(), `agent-link-read-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
          const cliArgs = [path.join(__dirname, "relay.mjs"), "--read-latest", "--cdp", cdpHostOf(lane.port), "--state-dir", lane.stateDir, "--json-out", tmp];
          if (args.backend) cliArgs.push("--backend", args.backend);
          if (args.conv) cliArgs.push("--conv", args.conv);
          if (args.keepPending) cliArgs.push("--no-clear");
          let childErr = null;
          try { execFileSync(process.execPath, cliArgs, { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { childErr = e; }
          let r = null;
          try { if (fs.existsSync(tmp)) r = JSON.parse(fs.readFileSync(tmp, "utf8")); } catch (e) { childErr = childErr || { message: `读回结果解析失败: ${e.message}` }; }
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
          if (!r || typeof r !== "object") {
            const tail = childErr ? String(childErr.stderr || childErr.message || "").split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 200) : "";
            r = { ok: false, replyText: "", targetUrl: "", reason: "READ_NO_RESULT", hint: `只读读回未取得结果${childErr && childErr.status ? `（子进程退出码 ${childErr.status}）` : ""}${tail ? `：${tail}` : ""}` };
          }
          res = {
            ok: !!r.ok, lane: lane.lane, replyText: r.replyText || "", targetUrl: r.targetUrl || "",
            convId: r.convId || undefined, backend: r.backend || undefined, replyId: r.replyId || undefined,
            lastUserText: r.lastUserText || undefined, assistantCount: r.assistantCount,
            clearedPending: r.clearedPending || undefined, reason: r.reason || undefined, hint: r.hint || undefined,
          };
        }
      } else res = service.submitResult({
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
