// 干跑自检（dry-run）：不需要浏览器，验证 MCP 工具闭环健康（list → claim → get → submit → resources）。
// 用途：反馈中"claim_next_task/get_task/submit_result 未被使用、无法验证闭环"——本脚本用临时项目自证。
// 用法：npm run selftest  （或 node test/selftest.mjs）
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskService } from "./local_service.mjs";
import { handleRequest, TOOLS } from "./mcp_server.mjs";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "awl-selftest-"));
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

// ---- 临时项目 ----
const root = path.join(BASE, "proj");
fs.mkdirSync(path.join(root, "work"), { recursive: true });
fs.writeFileSync(path.join(root, "work", "ok.mjs"), "export const ok = 1;\n", "utf8");
const cfg = {
  schemaVersion: 1, name: "selftest", projectRoot: root,
  projectTests: [{ command: "node", args: ["work/ok.mjs"] }],
  agentCommand: null, paths: { stateDir: ".state", tasksDir: ".tasks" },
};
const cfgPath = path.join(root, "project.config.json");
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
const projectsFile = path.join(BASE, "projects.json");
fs.writeFileSync(projectsFile, JSON.stringify({ schemaVersion: 1, projects: [{ name: "selftest", config: cfgPath }] }, null, 2), "utf8");

const svc = createTaskService({
  projectsFile, tokenFile: path.join(BASE, "token.txt"),
  worker: async () => ({ ok: true, results: [] }), log: () => {},
});
svc.start();

const st = { negotiatedVersion: "2024-11-05", initialized: false };
const call = (msg) => handleRequest(svc, msg, () => {}, st);
const callTool = (name, args) => JSON.parse(call({
  jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call",
  params: { name, arguments: args || {} },
}).result.content[0].text);

let taskId = null;
let claimToken = null;

await step("S1 initialize 协商 2025-06-18", () => {
  const r = call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.equal(r.result.serverInfo.name, "agent-web-link");
});
await step("S2 tools/list 含 10 个工具（6 任务 + 3 浏览器 + 1 只读读回）", () => {
  const r = call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(r.result.tools.length, 10);
  assert.equal(r.result.tools.length, TOOLS.length);
});
await step("S3 list_projects 发现 selftest", () => {
  const o = callTool("agent_link_list_projects");
  assert.equal(o.ok, true);
  assert.ok(o.projects.some((p) => p.name === "selftest"));
});
await step("S4 创建 agent 模式任务（保持 NEW，等待外部领取）", () => {
  const sub = svc.submit({ project: "selftest", summary: "selftest dry-run", mode: "agent" });
  assert.equal(sub.ok, true, JSON.stringify(sub));
  taskId = sub.taskId;
});
await step("S5 list_tasks 能查到 NEW 任务", () => {
  const o = callTool("agent_link_list_tasks", { project: "selftest" });
  assert.equal(o.ok, true);
  const t = o.tasks.find((x) => x.taskId === taskId);
  assert.ok(t, "任务应出现在列表中");
  assert.equal(t.phase, "NEW");
});
await step("S6 claim_next_task：NEW → RUNNING", () => {
  const o = callTool("agent_link_claim_next_task", { project: "selftest" });
  assert.equal(o.ok, true);
  assert.ok(o.task, "应领到任务");
  assert.equal(o.task.taskId, taskId);
  assert.ok(o.task.claimToken, "应返回 claimToken（租约）");
  assert.ok(o.task.leaseExpiresAt, "应返回 leaseExpiresAt");
  claimToken = o.task.claimToken;
  // 领取返回体不含 phase（设计如此）；RUNNING 由 S8 的 get_task 验证
});
await step("S7 重复 claim 不再领到同一任务", () => {
  const o = callTool("agent_link_claim_next_task", { project: "selftest" });
  assert.equal(o.ok, true);
  assert.equal(o.task, null, "不应重复领取");
});
await step("S8 get_task 状态为 RUNNING", () => {
  const o = callTool("agent_link_get_task", { project: "selftest", taskId });
  assert.equal(o.ok, true);
  assert.equal(o.task.phase, "RUNNING");
});
await step("S9 submit_result → REPORTED 且证据落盘", () => {
  const o = callTool("agent_link_submit_result", {
    project: "selftest", taskId, ok: true, evidence: { selftest: true, at: new Date().toISOString() }, claimToken,
  });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.phase, "REPORTED");
});
await step("S9b list_reports 能看到该报告（含摘要）", () => {
  const o = callTool("agent_link_list_reports", { project: "selftest" });
  assert.equal(o.ok, true);
  const r = o.reports.find((x) => x.taskId === taskId);
  assert.ok(r, "报告应出现在 list_reports");
  assert.equal(r.phase, "REPORTED");
});
await step("S9c 同 claimToken 重复提交 → 幂等重放（不覆盖首次报告）", () => {
  const o = callTool("agent_link_submit_result", { project: "selftest", taskId, ok: true, evidence: { second: true }, claimToken });
  assert.equal(o.ok, true);
  assert.equal(o.idempotent, true);
  assert.equal(o.phase, "REPORTED");
});
await step("S9d 错误 claimToken → isError（不覆盖）", () => {
  const r = call({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "agent_link_submit_result", arguments: { project: "selftest", taskId, ok: true, evidence: { x: 1 }, claimToken: "deadbeef" } } });
  assert.equal(r.result.isError, true);
});
await step("S10 resources/list 含该报告", () => {
  const r = call({ jsonrpc: "2.0", id: 10, method: "resources/list" });
  const hit = (r.result.resources || []).find((x) => x.uri.endsWith(`/${taskId}`));
  assert.ok(hit, "报告应作为资源出现");
  assert.match(hit.description, /任务报告/);
});
await step("S11 resources/read 读回报告", () => {
  const r = call({ jsonrpc: "2.0", id: 11, method: "resources/read", params: { uri: `agent-link://report/selftest/${taskId}` } });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const rep = JSON.parse(r.result.contents[0].text);
  assert.equal(rep.taskId, taskId);
  assert.equal(rep.status, "ACTIONS_DONE");
  const auditFile = path.join(root, ".state", "audit.log");
  assert.ok(fs.existsSync(auditFile), "读报告应写审计");
  assert.match(fs.readFileSync(auditFile, "utf8"), /read-report/);
});
await step("S12 get_task 终态为 REPORTED", () => {
  const o = callTool("agent_link_get_task", { project: "selftest", taskId });
  assert.equal(o.task.phase, "REPORTED");
});

await step("S13 空证据提交 → isError（EVIDENCE_REQUIRED）", () => {
  const r = call({ jsonrpc: "2.0", id: 97, method: "tools/call", params: { name: "agent_link_submit_result", arguments: { project: "selftest", taskId, ok: true, evidence: "" } } });
  assert.equal(r.result.isError, true);
});
await step("S14 resources/read 穿越 → -32602", () => {
  const r = call({ jsonrpc: "2.0", id: 98, method: "resources/read", params: { uri: "agent-link://report/selftest/..%2F..%2Fetc%2Fpasswd" } });
  assert.equal(r.error && r.error.code, -32602);
});

svc.stop();
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}

const passed = results.filter((r) => r.startsWith("PASS")).length;
for (const r of results) console.log(r);
console.log(`合计: ${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
