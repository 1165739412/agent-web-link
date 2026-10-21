// C9-R16 agent_executor 测试：白名单执行 + agent_dispatch 安全接通
import assert from "node:assert";
import { makeExecutor, ALLOWED_OPS } from "./agent_executor.mjs";

const results = [];
async function record(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name} :: ${e.message}`); }
}

await record("ALLOWED_OPS 含 agent_dispatch（R16 入口）", async () => {
  assert.ok(ALLOWED_OPS.includes("agent_dispatch"), "必须含 agent_dispatch");
  assert.ok(ALLOWED_OPS.includes("node_check") && ALLOWED_OPS.includes("run_project_tests"));
});

// 基础白名单行为（不重跑，仅单元校验）
const ex = makeExecutor({ projectRoot: ".", projectTests: [{ command: process.execPath, args: ["--version"] }] });

await record("node_check 合法 JS 文件 → ok", async () => {
  const v = ex.validateAction({ op: "node_check", target: "test/agent_executor.mjs" });
  assert.ok(v.ok, `应 ok，实际 ${v.reason}`);
});
await record("node_check 越界路径 → 拒绝(BLOCKED)", async () => {
  const v = ex.validateAction({ op: "node_check", target: "../outside.js" });
  assert.ok(!v.ok);
});
await record("node_check 不存在 → 拒绝", async () => {
  const v = ex.validateAction({ op: "node_check", target: "test/nope.js" });
  assert.ok(!v.ok);
});
await record("node_check 非 JS → 拒绝", async () => {
  const v = ex.validateAction({ op: "node_check", target: "test/README.md" });
  assert.ok(!v.ok);
});
await record("run_project_tests 未配置 → 拒绝", async () => {
  const e2 = makeExecutor({ projectRoot: "." });
  const v = e2.validateAction({ op: "run_project_tests" });
  assert.ok(!v.ok);
});

// R16：agent_dispatch 安全接通
await record("agent_dispatch 未配置 agentCommand → 拒绝(BLOCKED)，默认禁用", async () => {
  const v = ex.validateAction({ op: "agent_dispatch" });
  assert.ok(!v.ok, "未配置时必须拒绝");
  assert.ok(/未配置 agent 命令/.test(v.reason), `reason 应说明未配置，实际 ${v.reason}`);
});
await record("agent_dispatch 配置后 → 真实执行固定命令（成功）", async () => {
  const e3 = makeExecutor({
    projectRoot: ".",
    agentCommand: { command: process.execPath, args: ["--version"] },
  });
  const v = e3.validateAction({ op: "agent_dispatch" });
  assert.ok(v.ok, `应 ok，实际 ${v.reason}`);
  const r = e3.executeActions([{ op: "agent_dispatch" }]);
  assert.ok(r.ok, `执行应成功，实际 ${JSON.stringify(r.results)}`);
  assert.equal(r.results[0].exitCode, 0);
});
await record("agent_dispatch 配置为失败命令 → ok=false（如实反映，不谎称成功）", async () => {
  const e4 = makeExecutor({
    projectRoot: ".",
    agentCommand: { command: process.execPath, args: ["-e", "process.exit(2)"] },
  });
  const r = e4.executeActions([{ op: "agent_dispatch" }]);
  assert.ok(!r.ok, "失败命令必须 ok=false");
  assert.equal(r.results[0].exitCode, 2);
});
await record("agent_dispatch 与 node_check 混合：any 失败 → ex.ok=false", async () => {
  const e5 = makeExecutor({
    projectRoot: ".",
    agentCommand: { command: process.execPath, args: ["-e", "process.exit(3)"] },
  });
  const r = e5.executeActions([
    { op: "node_check", target: "test/agent_executor.mjs" },
    { op: "agent_dispatch" },
  ]);
  assert.ok(!r.ok, "部分失败必须 ex.ok=false");
  assert.equal(r.results.length, 2);
});

await record("agent_dispatch 任务感知：写 drop 文件并由命令读取执行（无需 claude 登录）", async () => {
  const fs = await import("node:fs");
  const tf = "test/tmp_dispatch/_t.json";
  const e6 = makeExecutor({
    projectRoot: ".",
    agentCommand: { command: process.execPath, args: ["test/agent_dispatch_mock_runner.mjs", tf], taskFile: tf },
  });
  const r = e6.executeActions([{ op: "agent_dispatch" }], { taskContext: { taskId: "tk-mock", summary: "s" } });
  assert.ok(r.ok, `应 ok，实际 ${JSON.stringify(r.results)}`);
  assert.ok(String(r.results[0].stdout || "").includes("MOCK-EXECUTED:tk-mock"), `stdout 应含回显，实际 ${r.results[0].stdout}`);
  const written = JSON.parse(fs.readFileSync("./test/tmp_dispatch/_t.json", "utf8"));
  assert.equal(written.taskId, "tk-mock", "drop 文件须写入本轮任务上下文");
  fs.rmSync("./test/tmp_dispatch", { recursive: true, force: true });
});

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(`合计: ${results.length - failed.length}/${results.length} 通过` + (failed.length ? " (有失败)" : ""));
process.exit(failed.length ? 1 : 0);
