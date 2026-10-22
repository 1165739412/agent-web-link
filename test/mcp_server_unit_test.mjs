// MCP Server 单元测试（不启子进程）：直测 handleRequest —— 版本协商 / 输入校验 / 注解 /
// 新工具 / structuredContent / 通知与错误码。桥接集成（真实 stdio 子进程）由 mcp_bridge_test 覆盖。
import assert from "node:assert/strict";
import { TOOLS, handleRequest, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION, validateSchema } from "./mcp_server.mjs";

const results = [];
let passed = 0;
function record(name, fn) {
  try { fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

// 桩服务：只暴露 MCP 用到的接口
const calls = [];
const service = {
  version: "test-1",
  projects: ["p1"],
  claimNext: ({ project, claimedBy }) => { calls.push(["claim", project, claimedBy]); return { ok: true, task: { taskId: "t1", project: project || "p1" } }; },
  status: ({ project, taskId }) => ({ ok: true, taskId, phase: "RUNNING", project }),
  submitResult: ({ ok, evidence }) => ({ ok: !!ok, phase: ok ? "REPORTED" : "FAILED" }),
  listProjects: () => ({ ok: true, version: "test-1", projects: [{ name: "p1", hasRegistry: true }], configErrors: [{ project: "bad", code: "CONFIG_INVALID" }], configErrorCount: 1, queueDepth: 0, running: true }),
  listTasks: ({ project, phase, limit }) => {
    const all = [{ taskId: "t1", phase: "NEW", hasReport: false }, { taskId: "t2", phase: "REPORTED", hasReport: true }];
    const filtered = all.filter((t) => !phase || t.phase === phase).slice(0, limit || 20);
    return { ok: true, project, total: all.length, returned: filtered.length, tasks: filtered };
  },
  listReports: ({ project, limit }) => ({ ok: true, project, total: 1, returned: 1, reports: [{ taskId: "t2", phase: "REPORTED", summary: "s", finishedAt: null, createdAt: null }].slice(0, limit || 20) }),
  report: ({ project, taskId }) => (project === "p1" && taskId === "t2"
    ? { ok: true, report: { taskId, project, status: "ACTIONS_DONE", evidence: { src: "stub" } } }
    : { ok: false, code: project === "p1" ? "REPORT_NOT_FOUND" : "UNKNOWN_PROJECT", message: "桩：仅 p1/t2 有报告" }),
};
const call = (service2, msg, state) => handleRequest(service2 || service, msg, () => {}, state || { negotiatedVersion: "2024-11-05", initialized: true });

// ---- 版本协商 ----
record("V1 initialize 支持版本原样返回", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: false };
  const r = call(service, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, st);
  assert.equal(r.result.protocolVersion, "2024-11-05");
});
record("V2 initialize 不支持版本 → 返回服务器最高支持版本（不回显）", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: false };
  const r = call(service, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1.0.0" } }, st);
  assert.equal(r.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(r.result.protocolVersion, "2025-06-18");
});
record("V3 initialize 含 instructions 与 capabilities.tools.listChanged=false", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: false };
  const r = call(service, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, st);
  assert.equal(r.result.capabilities.tools.listChanged, false);
  assert.match(r.result.instructions, /agent_link_claim_next_task/);
  assert.equal(r.result.serverInfo.name, "agent-web-link");
});
record("V4 SUPPORTED 版本表降序且包含 2024-11-05", () => {
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes("2024-11-05"));
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS].sort().reverse(), SUPPORTED_PROTOCOL_VERSIONS);
});

// ---- 工具清单与注解 ----
record("V5 tools/list 含 6 个工具且 get_task 有 readOnly 注解", () => {
  const r = call(service, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = r.result.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "agent_link_list_projects", "agent_link_list_tasks", "agent_link_list_reports",
    "agent_link_claim_next_task", "agent_link_get_task", "agent_link_submit_result",
  ]);
  const g = r.result.tools.find((t) => t.name === "agent_link_get_task");
  assert.equal(g.annotations.readOnlyHint, true);
  const s = r.result.tools.find((t) => t.name === "agent_link_submit_result");
  assert.equal(s.annotations.readOnlyHint, false);
});

// ---- 输入校验（规范 MUST）----
record("V6 缺必填参数 → -32602 且指明字段", () => {
  const r = call(service, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_link_get_task", arguments: { project: "p1" } } });
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /taskId/);
});
record("V7 类型错误（evidence 为数字）→ -32602", () => {
  // evidence 无 type 约束（对象/数组/字符串均可），改用 ok: "yes" 触发 boolean 类型校验
  const r = call(service, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_link_submit_result", arguments: { project: "p1", taskId: "t1", ok: "yes", evidence: "x" } } });
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /ok/);
});
record("V8 未知参数（additionalProperties:false）→ -32602", () => {
  const r = call(service, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_link_claim_next_task", arguments: { cmd: "rm -rf /" } } });
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /arguments\.cmd: 未知字段/);
});
record("V9 未知工具 → -32602（协议错误，不进入服务层）", () => {
  const r = call(service, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hack", arguments: {} } });
  assert.equal(r.error.code, -32602);
});
record("V10 合法参数通过校验进入服务层（claim 带 claimedBy=mcp）", () => {
  calls.length = 0;
  const r = call(service, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_link_claim_next_task", arguments: { project: "p1" } } });
  assert.equal(r.result.isError, undefined);
  assert.deepEqual(calls[0], ["claim", "p1", "mcp"]);
});
record("V11 list_tasks 透传 phase 且新工具可用", () => {
  const r = call(service, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "agent_link_list_tasks", arguments: { project: "p1", phase: "NEW", limit: 5 } } });
  assert.equal(r.result.content[0].type, "text");
  const parsed = JSON.parse(r.result.content[0].text);
  assert.equal(parsed.tasks[0].phase, "NEW");
  assert.equal(parsed.returned, 1, "phase 过滤生效");
});
record("V12 业务错误 → isError=true（双通道，非 JSON-RPC error）", () => {
  const r = call(service, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "agent_link_submit_result", arguments: { project: "p1", taskId: "t1", ok: false, evidence: "proof" } } });
  assert.equal(r.result.isError, true);
  assert.equal(r.error, undefined);
});

// ---- structuredContent（仅 2025-06-18）----
record("V13 协商 2025-06-18 → tools/call 附 structuredContent 且保留 text", () => {
  const state = { negotiatedVersion: "2025-06-18", initialized: true };
  call(service, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }, state);
  const r = call(service, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "agent_link_list_projects", arguments: {} } }, state);
  assert.ok(r.result.structuredContent);
  assert.equal(r.result.structuredContent.projects[0].name, "p1");
  assert.equal(r.result.content[0].type, "text");
});
record("V14 协商 2024-11-05 → 不附 structuredContent（向后兼容）", () => {
  const state = { negotiatedVersion: "2024-11-05", initialized: true };
  const r = call(service, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "agent_link_list_projects", arguments: {} } }, state);
  assert.equal(r.result.structuredContent, undefined);
});

// ---- 通知与错误码 ----
record("V15 initialized/cancelled 通知返回 null（不回包）", () => {
  assert.equal(call(service, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(call(service, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), null);
});
record("V16 不支持的方法 → -32601；ping → 空结果", () => {
  const a = call(service, { jsonrpc: "2.0", id: 8, method: "prompts/list" });
  assert.equal(a.error.code, -32601);
  const b = call(service, { jsonrpc: "2.0", id: 9, method: "ping" });
  assert.deepEqual(b.result, {});
});
record("V17 服务层抛异常 → isError=true 且含原因", () => {
  const bad = { ...service, claimNext: () => { throw new Error("boom"); } };
  const r = call(bad, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "agent_link_claim_next_task", arguments: {} } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /boom/);
});

// ---- 生命周期状态机与信息面白名单（DS 评审第 2/5/7 点） ----
record("V18 initialize 前：initialize/ping 之外的请求一律 -32002", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: false };
  const a = call(service, { jsonrpc: "2.0", id: 20, method: "tools/list" }, st);
  assert.equal(a.error.code, -32002);
  const b = call(service, { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "agent_link_list_projects", arguments: {} } }, st);
  assert.equal(b.error.code, -32002);
  const c = call(service, { jsonrpc: "2.0", id: 22, method: "ping" }, st); // ping 豁免
  assert.deepEqual(c.result, {});
});
record("V19 通知在初始化前也被忽略（不报错不回包）", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: false };
  assert.equal(call(service, { jsonrpc: "2.0", method: "notifications/initialized" }, st), null);
  assert.equal(call(service, { jsonrpc: "2.0", method: "notifications/cancelled" }, st), null);
});
record("V20 重复 initialize → -32600", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: false };
  const a = call(service, { jsonrpc: "2.0", id: 23, method: "initialize", params: { protocolVersion: "2024-11-05" } }, st);
  assert.equal(a.result.protocolVersion, "2024-11-05");
  const b = call(service, { jsonrpc: "2.0", id: 24, method: "initialize", params: { protocolVersion: "2024-11-05" } }, st);
  assert.equal(b.error.code, -32600);
});
record("V21 list_projects 信息面白名单：结构白名单断言（DS 评审：键集合精确匹配）", () => {
  const r = call(service, { jsonrpc: "2.0", id: 25, method: "tools/call", params: { name: "agent_link_list_projects", arguments: {} } });
  const parsed = JSON.parse(r.result.content[0].text);
  assert.deepEqual(Object.keys(parsed).sort(), ["configErrorCount", "configErrors", "ok", "projects", "queueDepth", "running", "version"]);
  assert.deepEqual(Object.keys(parsed.projects[0]).sort(), ["hasRegistry", "name"]);
  // 配置错误可诊断（反馈：只有 configErrorCount 无法定位）
  assert.equal(parsed.configErrors.length, 1);
  assert.equal(parsed.configErrors[0].project, "bad");
  assert.equal(parsed.configErrors[0].code, "CONFIG_INVALID");
  assert.equal(parsed.configErrors[0].message, undefined, "不得回传原始 message");
  // 辅助黑名单（不作为主要手段）：不出现登记簿/错误原文键名
  const text = r.result.content[0].text;
  assert.equal(text.includes("registryFile") || text.includes("projectErrors"), false);
});
record("V22 evidence 数组/对象/字符串均通过校验（无类型约束，非空由服务层把关）", () => {
  for (const evidence of ["txt", [{ a: 1 }], { k: "v" }]) {
    const r = call(service, { jsonrpc: "2.0", id: 26, method: "tools/call", params: { name: "agent_link_submit_result", arguments: { project: "p1", taskId: "t1", ok: true, evidence } } });
    assert.equal(r.error, undefined, `evidence=${JSON.stringify(evidence)} 不应被校验拒绝`);
  }
});
record("V23 tools/call 作为通知不执行不回包", () => {
  calls.length = 0;
  const r = call(service, { jsonrpc: "2.0", method: "tools/call", params: { name: "agent_link_claim_next_task", arguments: { project: "p1" } } });
  assert.equal(r, null);
  assert.equal(calls.length, 0, "通知不得进入服务层");
});

// ---- inputSchema 严谨度 + outputSchema 契约 + 审计（DS 评审 C 项） ----
record("V24 inputSchema 严谨度：phase 枚举 / limit 范围", () => {
  const a = call(service, { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "agent_link_list_tasks", arguments: { project: "p1", phase: "HACKED" } } });
  assert.equal(a.error.code, -32602);
  const b = call(service, { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "agent_link_list_tasks", arguments: { project: "p1", limit: 200 } } });
  assert.equal(b.error.code, -32602);
  const c = call(service, { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "agent_link_list_tasks", arguments: { project: "p1", limit: 0 } } });
  assert.equal(c.error.code, -32602);
});
record("V25 全部工具声明 outputSchema；structuredContent 符合其 schema", () => {
  const st = { negotiatedVersion: "2025-06-18", initialized: true };
  call(service, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }, st);
  for (const t of TOOLS) assert.ok(t.outputSchema, `${t.name} 缺 outputSchema`);
  for (const t of TOOLS.filter((x) => x.name !== "agent_link_claim_next_task" && x.name !== "agent_link_get_task" && x.name !== "agent_link_submit_result")) {
    const r = call(service, { jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: t.name, arguments: t.inputSchema.required ? { project: "p1" } : {} } }, st);
    const sc = r.result.structuredContent;
    assert.ok(sc, `${t.name} 应有 structuredContent`);
    assert.deepEqual(validateSchema(sc, t.outputSchema), [], `${t.name} structuredContent 不符合 outputSchema`);
  }
});
record("V26 text 与 structuredContent 内容等价", () => {
  const st = { negotiatedVersion: "2025-06-18", initialized: true };
  call(service, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }, st);
  const r = call(service, { jsonrpc: "2.0", id: 34, method: "tools/call", params: { name: "agent_link_list_projects", arguments: {} } }, st);
  assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent);
});
record("V27 审计日志：含 request id/工具名/结果/耗时，不含参数内容", () => {
  const logs = [];
  handleRequest(service, { jsonrpc: "2.0", id: 35, method: "tools/call", params: { name: "agent_link_claim_next_task", arguments: { project: "SECRET_PROJECT_X" } } }, (m) => logs.push(m), { negotiatedVersion: "2024-11-05", initialized: true });
  const audit = logs.find((m) => m.includes("[MCP][AUDIT]"));
  assert.ok(audit, "应有审计日志");
  assert.match(audit, /id=35/);
  assert.match(audit, /tool=agent_link_claim_next_task/);
  assert.match(audit, /ok=true/);
  assert.equal(audit.includes("SECRET_PROJECT_X"), false, "审计日志不得包含参数内容");
});
record("V28 structuredContent 违约 → 降级省略，text 仍完整可解析", () => {
  const bad = { ...service, listProjects: () => ({ ok: true, projects: [{ name: "p1" }] }) }; // 缺 required 字段
  const st = { negotiatedVersion: "2025-06-18", initialized: true };
  call(bad, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }, st);
  const logs = [];
  const r = handleRequest(bad, { jsonrpc: "2.0", id: 36, method: "tools/call", params: { name: "agent_link_list_projects", arguments: {} } }, (m) => logs.push(m), st);
  assert.equal(r.result.structuredContent, undefined, "违约 structuredContent 应被省略");
  assert.equal(r.result.isError, undefined, "业务本身成功，不应标 isError");
  const parsed = JSON.parse(r.result.content[0].text); // text 仍完整可解析
  assert.equal(parsed.projects[0].name, "p1");
  assert.ok(logs.some((m) => m.includes("不符合")), "应输出契约违约告警");
});
record("V29 resources 只读：list 含有报告的任务，read 返回 JSON 内容，未知 URI 报错", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: true };
  const lr = call(service, { jsonrpc: "2.0", id: 40, method: "resources/list" }, st);
  assert.equal(lr.error, undefined);
  assert.equal(lr.result.resources.length, 1, "只有 hasReport 的任务成为资源");
  const uri = lr.result.resources[0].uri;
  assert.match(uri, /^agent-link:\/\/report\/p1\/t2$/);
  const rr = call(service, { jsonrpc: "2.0", id: 41, method: "resources/read", params: { uri } }, st);
  assert.equal(rr.result.contents[0].mimeType, "application/json");
  const parsed = JSON.parse(rr.result.contents[0].text);
  assert.equal(parsed.taskId, "t2");
  const bad = call(service, { jsonrpc: "2.0", id: 42, method: "resources/read", params: { uri: "agent-link://report/p1/t1" } }, st); // t1 无报告
  assert.equal(bad.error.code, -32602);
  const ugly = call(service, { jsonrpc: "2.0", id: 43, method: "resources/read", params: { uri: "file:///etc/passwd" } }, st);
  assert.equal(ugly.error.code, -32602);
});
record("V30 resources 能力声明：subscribe=false（不做订阅）", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: false };
  const r = call(service, { jsonrpc: "2.0", id: 44, method: "initialize", params: { protocolVersion: "2024-11-05" } }, st);
  assert.equal(r.result.capabilities.resources.subscribe, false);
});
record("V34 凭据面：get_task/list_tasks/list_reports 不回传 claimToken/lease/reportToken", () => {
  const g = call(service, { jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "agent_link_get_task", arguments: { project: "p1", taskId: "t1" } } });
  assert.equal(g.result.content[0].text.includes("claimToken"), false);
  assert.equal(g.result.content[0].text.includes("leaseExpiresAt"), false);
  const lt = call(service, { jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "agent_link_list_tasks", arguments: { project: "p1" } } });
  assert.equal(lt.result.content[0].text.includes("claimToken"), false);
  const lr = call(service, { jsonrpc: "2.0", id: 52, method: "tools/call", params: { name: "agent_link_list_reports", arguments: { project: "p1" } } });
  assert.equal(lr.result.content[0].text.includes("reportToken"), false);
});

record("V33 服务层错误码在 MCP 层的映射稳定（REPORT_TOO_LARGE → -32602 消息携带）", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: true };
  const big = { ...service, report: () => ({ ok: false, code: "REPORT_TOO_LARGE", message: "报告超过大小上限（1MB）" }) };
  const r = call(big, { jsonrpc: "2.0", id: 48, method: "resources/read", params: { uri: "agent-link://report/p1/t2" } }, st);
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /REPORT_TOO_LARGE/);
});
record("V31 resources/read 路径安全：穿越/绝对路径/UNC 一律 -32602", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: true };
  const cases = [
    "agent-link://report/..%2Fproj-a/t2",              // project 穿越（未注册 → UNKNOWN_PROJECT）
    "agent-link://report/p1/..%2F..%2Fetc%2Fpasswd",   // taskId 穿越（非法字符 → 拒绝）
    "agent-link://report/p1/..",                        // taskId=".."
    "agent-link://report/p1/%5C%5Cserver%2Fshare",     // UNC
    "agent-link://report/p1/a%2Fb",                    // taskId 含分隔符
  ];
  for (const uri of cases) {
    const r = call(service, { jsonrpc: "2.0", id: 45, method: "resources/read", params: { uri } }, st);
    assert.equal(r.error && r.error.code, -32602, `URI ${uri} 应被拒绝`);
  }
  // 合法 URI 仍可读（白名单命中 + 登记簿精确查找）
  const ok = call(service, { jsonrpc: "2.0", id: 46, method: "resources/read", params: { uri: "agent-link://report/p1/t2" } }, st);
  assert.equal(ok.error, undefined);
  assert.equal(JSON.parse(ok.result.contents[0].text).taskId, "t2");
});
record("V32 resources/list 截断语义：truncated 显式（未截断为 false）", () => {
  const st = { negotiatedVersion: "2024-11-05", initialized: true };
  const r = call(service, { jsonrpc: "2.0", id: 47, method: "resources/list" }, st);
  assert.equal(r.result._meta.truncated, false);
  assert.equal(r.result.truncated, undefined, "truncated 应迁到 _meta");
  assert.ok(Array.isArray(r.result.resources));
});

console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);
if (passed !== results.length) process.exitCode = 1;
