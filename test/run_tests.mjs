// 开源测试聚合器：运行不依赖真实浏览器 / 私人对话的纯逻辑与 stdio 集成测试。
// 需要真实浏览器 + 私人 DeepSeek/ChatGPT 会话的测试（deepseek_adapter_test 等）不在默认套件内，
// 由 `npm run test:manual:browser` 手动执行。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  "mcp_server_unit_test.mjs",
  "mcp_bridge_test.mjs",            // stdio 子进程，无需浏览器
  "mcp_inspector_equiv.mjs",        // stdio 子进程，无需浏览器
  "local_service_test.mjs",
  "comm_integration_test.mjs",
  "agent_integration_doc_test.mjs",
  "relay_test.mjs",                 // 纯逻辑，不触浏览器
  "context_recovery_test.mjs",
  "pending_reports_test.mjs",
  "run_state_store_test.mjs",
  "report_delivery_test.mjs",
  "auto_loop_test.mjs",
  "multi_project_routing_test.mjs",
  "relay_failure_test.mjs",         // 无 CDP 时显式 SKIP
  "context_limit_detect_test.mjs",  // 无 CDP 时显式 SKIP
  "selftest.mjs",                   // MCP 闭环干跑自检（不需要浏览器）
];

let failed = 0;
const results = [];
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(/合计:\s*(\d+)\/(\d+)\s*通过/);
  const ok = m ? m[2] === m[1] : false;
  const skipped = /SKIPPED/.test(out);
  results.push(`${ok ? "PASS" : "FAIL"} ${s}${skipped ? " (含SKIP)" : ""}`);
  if (!ok) failed++;
  console.log(`--- ${s} ---`);
  console.log(out.trim().split("\n").slice(-4).join("\n"));
}
console.log("\n" + results.join("\n"));
console.log(`\nSUMMARY: ${SUITES.length - failed}/${SUITES.length} 套件通过`);
process.exit(failed ? 1 : 0);
