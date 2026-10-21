// C9 接入文档一致性测试：文档 vs 真实代码/真实演练证据
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { TOOLS } from "./mcp_server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DOC = path.join(ROOT, "docs", "AGENT_INTEGRATION_GUIDE.md");
const LSV = path.join(ROOT, "test", "local_service.mjs");
const EV = path.join(ROOT, "test", "state", "onboard_rehearsal_evidence.json");

const results = [];
let passed = 0;
function record(name, fn) {
  try { fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

const doc = fs.readFileSync(DOC, "utf8");
const lsv = fs.readFileSync(LSV, "utf8");

record("D1 文档存在且为中文正式入口", () => {
  assert.ok(doc.length > 2000);
  assert.ok(doc.includes("Agent 接入指南"));
  assert.ok(/[\u4e00-\u9fa5]/.test(doc));
});

record("D2 文档列出全部真实 MCP 工具名", () => {
  for (const t of TOOLS) assert.ok(doc.includes(t.name), `缺少工具 ${t.name}`);
  assert.equal(TOOLS.length, 5, "MCP 工具应为 5 个（含 list_projects/list_tasks）");
});

record("D3 文档明确无创建任务 MCP 工具，并给出真实入口", () => {
  assert.ok(/没有.{0,12}创建任务的 MCP 工具/.test(doc), "必须明确无创建任务工具");
  assert.ok(doc.includes("POST /v1/tasks"), "必须给出 HTTP 创建入口");
  assert.ok(doc.includes("x-auth-token") || doc.includes("X-Auth-Token"));
});

record("D4 文档错误码均在真实代码中存在", () => {
  const codes = ["UNKNOWN_PROJECT", "PROJECT_CONFIG_INVALID", "PROJECT_ROOT_MISSING", "PROJECT_ROOT_INVALID", "PROJECT_ROUTE_MISMATCH", "TASK_NOT_FOUND", "INVALID_STATE", "EVIDENCE_REQUIRED", "INVALID_OK", "DUPLICATE_TASK", "INVALID_TASK_ID", "UNAUTHORIZED"];
  for (const c of codes) {
    assert.ok(doc.includes(c), `文档缺少错误码 ${c}`);
    assert.ok(lsv.includes(c), `代码中不存在错误码 ${c}（文档与实现不一致）`);
  }
});

record("D5 文档路径与示例配置一致（可移植，不依赖私人配置）", () => {
  for (const p of ["test/mcp_server.mjs", "test/mcp.register.json", "test/projects.json", "test/project.config.json", "test/local_service.mjs"]) {
    assert.ok(doc.includes(p), `缺少路径 ${p}`);
  }
  assert.ok(doc.includes("<another-project>") && doc.includes("<repo>"), "文档应含示例项目与仓库占位");
});

record("D6 文档含标准模板 [AGENT_REPORT] / [GPT_DECISION] 及决策兼容说明", () => {
  assert.ok(doc.includes("[AGENT_REPORT]"));
  assert.ok(doc.includes("[GPT_DECISION]"));
  assert.ok(doc.includes("CONTINUE") && doc.includes("COMPLETE") && doc.includes("BLOCKED"));
  assert.ok(doc.includes("ASK_USER"), "必须说明 BLOCKED 未被解析、可用 ASK_USER");
  assert.ok(doc.includes("NEXT_ACTION"), "必须说明解析器识别的动作格式");
});

record("D7 文档含可复制启动提示词与重启说明", () => {
  assert.ok(doc.includes("你是「<项目名>」项目的执行 Agent"));
  assert.ok(doc.includes("重启 MCP"));
  assert.ok(doc.includes("UNKNOWN_PROJECT") && doc.includes("TASK_NOT_FOUND"));
});

record("D8 文档真实演练值与证据文件一致", () => {
  const ev = JSON.parse(fs.readFileSync(EV, "utf8"));
  assert.equal(ev.pass, true, "演练未通过，文档真实值不可信");
  const taskId = ev.steps.create.taskId;
  const token = ev.steps.submit.report.reportToken;
  assert.ok(doc.includes(taskId), `文档未包含真实 taskId ${taskId}`);
  assert.ok(doc.includes(token), `文档未包含真实 reportToken ${token}`);
});

record("D9 文档标注已实现/未验证/限制", () => {
  assert.ok(doc.includes("已实现"));
  assert.ok(doc.includes("未验证") || doc.includes("限制"));
  assert.ok(doc.includes("不代表整个互联项目"));
});

record("D10 网络异常备案文档存在且可执行", () => {
  const nf = path.join(ROOT, "docs", "NETWORK_FALLBACK.md");
  assert.ok(fs.existsSync(nf), "缺少 NETWORK_FALLBACK.md");
  const t = fs.readFileSync(nf, "utf8");
  for (const k of ["reconcile", "SEND_UNCONFIRMED", "found: true", "chrome-error", "--resume", "--deliver-file", "clear_composer_if_sent", "PENDING"]) {
    assert.ok(t.includes(k), "备案缺少: " + k);
  }
  assert.ok(doc.includes("NETWORK_FALLBACK.md"), "接入指南未引用网络备案");
});

console.log(results.join("\n"));
console.log(`\n合计: ${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
