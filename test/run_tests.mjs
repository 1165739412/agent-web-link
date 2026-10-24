// 开源测试聚合器：并行运行不依赖真实浏览器 / 私人对话的套件。
// 之前是串行 spawn 17 个 Node 进程，每套还有固定等待，所以整体很慢；
// 现在用并发池（默认 min(4, CPU)），`--jobs N` 可调，`--jobs 1` 退回串行。
import { spawn } from "node:child_process";
import os from "node:os";
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
  "browser_lanes_test.mjs",         // lane 通道注册表（多项目并行隔离），纯逻辑
  "context_recovery_test.mjs",
  "pending_reports_test.mjs",
  "run_state_store_test.mjs",
  "report_delivery_test.mjs",
  "auto_loop_test.mjs",
  "multi_project_routing_test.mjs",
  "relay_failure_test.mjs",         // 无 CDP 时显式 SKIP
  "context_limit_detect_test.mjs",  // 无 CDP 时显式 SKIP
  "selftest.mjs",                   // MCP 闭环干跑自检（不需要浏览器）
  "register_project_test.mjs",      // 项目自注册 CLI
];

const argv = process.argv.slice(2);
const jobsIdx = argv.indexOf("--jobs");
const jobsRaw = jobsIdx >= 0 ? argv[jobsIdx + 1] : (process.env.TEST_JOBS || Math.min(4, os.cpus().length));
const jobs = Math.max(1, Math.min(SUITES.length, Number(jobsRaw) || 4));

function runOne(s) {
  return new Promise((resolve) => {
    // 测试默认关闭发送限流等待（各套件用独立临时 stateDir，避免 1500ms 串行化）
    const child = spawn(process.execPath, [path.join(__dirname, s)], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENT_LINK_MIN_SEND_INTERVAL_MS: "0" } });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", () => resolve({ s, out }));
    child.on("error", (e) => resolve({ s, out: out + `\nspawn error: ${e.message}` }));
  });
}

const queue = SUITES.slice();
const resultBySuite = new Map();
let failed = 0;
const t0 = Date.now();

async function worker() {
  while (queue.length) {
    const s = queue.shift();
    const tSuite = Date.now();
    const { out } = await runOne(s);
    const m = out.match(/合计:\s*(\d+)\/(\d+)\s*通过/);
    const ok = m ? m[2] === m[1] : false;
    const skipped = /SKIPPED/.test(out);
    resultBySuite.set(s, `${ok ? "PASS" : "FAIL"} ${s}${skipped ? " (含SKIP)" : ""} (${((Date.now() - tSuite) / 1000).toFixed(1)}s)`);
    if (!ok) failed++;
    console.log(`--- ${s} ---`);
    console.log(out.trim().split("\n").slice(-4).join("\n"));
  }
}

await Promise.all(Array.from({ length: Math.min(jobs, SUITES.length) }, () => worker()));
console.log("\n" + SUITES.map((s) => resultBySuite.get(s)).filter(Boolean).join("\n"));
console.log(`\nSUMMARY: ${SUITES.length - failed}/${SUITES.length} 套件通过（并行 ${jobs}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
process.exit(failed ? 1 : 0);
