// Inspector 等价脚本（DS 评审第 5 点，F 项收尾验证；不依赖联网）：
// 按官方 MCP Inspector 的典型行为序列，对真实 stdio 服务器走完整流程并断言结构：
//   initialize → notifications/initialized → tools/list → 逐个 tools/call → resources/list → resources/read
// 同时断言 stdout 纯净（每行均为 JSON-RPC）。弱网下拉不到 @modelcontextprotocol/inspector 时的可复现替代；
// 联网可用时仍建议用真 Inspector 人工复核一遍。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-link-insp-"));
const results = [];
let passed = 0;
function record(name, fn) {
  try { fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

const root = path.join(BASE, "proj");
fs.mkdirSync(root, { recursive: true });
const cfgPath = path.join(root, "project.config.json");
fs.writeFileSync(cfgPath, JSON.stringify({
  schemaVersion: 1, name: "insp-proj", projectRoot: root,
  projectTests: [], agentCommand: null,
  paths: { stateDir: ".state", tasksDir: ".tasks" },
}, null, 2), "utf8");
const projectsFile = path.join(BASE, "projects.json");
fs.writeFileSync(projectsFile, JSON.stringify({ schemaVersion: 1, projects: [{ name: "insp-proj", config: cfgPath }] }, null, 2), "utf8");

const child = spawn(process.execPath, [path.join(__dirname, "mcp_server.mjs"), "--projects", projectsFile, "--token-file", path.join(BASE, "token.txt")], { stdio: ["pipe", "pipe", "pipe"] });
const rawLines = [];
let buf = "";
let seq = 0;
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    rawLines.push(line);
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch {}
  }
});
child.stderr.on("data", () => {});
const request = (method, params) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const callTool = async (name, args = {}) => {
  const r = await request("tools/call", { name, arguments: args });
  return { raw: r, isError: r.result?.isError === true, error: r.error, obj: JSON.parse(r.result?.content?.[0]?.text || "null"), structured: r.result?.structuredContent };
};

// ---- 序列：与 Inspector 走查一致 ----
const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "inspector-equiv", version: "1" } });
record("S1 initialize：serverInfo/capabilities/instructions", () => {
  assertInit(init.result);
});
function assertInit(res) {
  if (!res || res.serverInfo?.name !== "agent-web-link") throw new Error("serverInfo 异常");
  if (!res.capabilities?.tools) throw new Error("缺 tools capability");
  if (!res.capabilities?.resources) throw new Error("缺 resources capability");
  if (typeof res.instructions !== "string") throw new Error("缺 instructions");
}
notify("notifications/initialized");

const list = await request("tools/list", {});
record("S2 tools/list：6 工具、每个含 inputSchema+outputSchema+annotations", () => {
  if (list.result.tools.length !== 6) throw new Error(`工具数 ${list.result.tools.length} != 6`);
  for (const t of list.result.tools) {
    if (!t.inputSchema || !t.outputSchema || !t.annotations) throw new Error(`${t.name} 缺 schema/注解`);
  }
});

for (const t of list.result.tools) {
  const args = t.name === "agent_link_submit_result" ? { project: "insp-proj", taskId: "no-such-task", ok: true, evidence: "inspector-equiv" }
    : t.inputSchema.required?.includes("taskId") ? { project: "insp-proj", taskId: "no-such-task" }
    : t.inputSchema.required?.includes("project") ? { project: "insp-proj" } : {};
  const r = await callTool(t.name, args);
  record(`S3 tools/call ${t.name}：返回 content[0].text 为 JSON`, () => {
    if (r.error) throw new Error("协议错误: " + r.error.message);
    if (!r.raw.result?.content?.[0]?.text) throw new Error("缺 content[0].text");
    JSON.parse(r.raw.result.content[0].text);
  });
}

const rl = await request("resources/list", {});
record("S4 resources/list：结构合法（可能为空，truncated 显式）", () => {
  if (!Array.isArray(rl.result.resources)) throw new Error("缺 resources 数组");
  if (typeof rl.result.truncated !== "boolean") throw new Error("缺 truncated 标记");
});

const rr = await request("resources/read", { uri: "agent-link://report/insp-proj/none" });
record("S5 resources/read 未知资源：-32602", () => {
  if (!rr.error || rr.error.code !== -32602) throw new Error("应返回 -32602");
});

const bad = await request("tools/call", { name: "nope", arguments: {} });
record("S6 未知工具：-32602", () => {
  if (!bad.error || bad.error.code !== -32602) throw new Error("应返回 -32602");
});

child.stdin.end();
child.kill();
record("S7 stdout 纯净：每行均为 JSON-RPC", () => {
  if (rawLines.length < 6) throw new Error(`stdout 行数过少: ${rawLines.length}`);
  for (const line of rawLines) {
    const msg = JSON.parse(line); // 非 JSON 直接抛错
    if (msg.jsonrpc !== "2.0") throw new Error("缺 jsonrpc 字段");
  }
});

fs.rmSync(BASE, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`合计: ${passed}/${results.length} 通过` + (failed.length ? " (有失败)" : ""));
process.exit(failed.length ? 1 : 0);
