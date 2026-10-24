// eval_budget_test —— R-002 根因 (b) 的离线回归：CDP 求值永久挂起时，
// evalWithBudget 必须在预算内返回结构化错误而不是永久卡死（DS 批次 8 评审钉死）。
// 纯 mock，不触浏览器。运行：node test/eval_budget_test.mjs
import assert from "node:assert";
import { EVAL_BUDGET_MS, evalWithBudget } from "./agent_backends.mjs";
import { REQ_TIMEOUT } from "./cdp_ws_client.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log((cond ? "[PASS] " : "[FAIL] ") + name + (detail ? " | " + detail : ""));
};

// 静态不变量：页面预算 < CDP REQ_TIMEOUT
check("budget < REQ_TIMEOUT", EVAL_BUDGET_MS < REQ_TIMEOUT,
  `EVAL_BUDGET_MS=${EVAL_BUDGET_MS} REQ_TIMEOUT=${REQ_TIMEOUT}`);

// 用例 1：CDP 永不 resolve（模拟上下文损坏）→ 预算内拒绝 EVAL_BUDGET_EXCEEDED
{
  const hangingCdp = { send: () => new Promise(() => {}) };
  const t0 = Date.now();
  await assert.rejects(
    evalWithBudget(hangingCdp, "(async()=>{})()", { budgetMs: 300 }),
    (e) => e.name === "EVAL_BUDGET_EXCEEDED",
  );
  const dt = Date.now() - t0;
  check("挂起求值在预算内拒绝", dt < 300 + 500, `${dt}ms`);
}

// 用例 2：正常求值照常返回（不误伤）
{
  const okCdp = { send: async () => ({ result: { value: "RESULT_OK" } }) };
  const r = await evalWithBudget(okCdp, "1+1", { awaitPromise: false });
  check("正常求值不误伤", r.result.value === "RESULT_OK");
}

// 用例 3：慢求值（> 预算）同样被拒绝
{
  const slowCdp = { send: () => new Promise((res) => setTimeout(() => res({ result: { value: 1 } }), 2000)) };
  await assert.rejects(evalWithBudget(slowCdp, "x", { budgetMs: 100 }),
    (e) => e.name === "EVAL_BUDGET_EXCEEDED");
  check("慢求值超预算拒绝", true);
}

// 静态：typeIntoComposer 页面循环上限为 80（8s）且 send 走 evalWithBudget
{
  const src = (await import("node:fs")).readFileSync(new URL("./agent_backends.mjs", import.meta.url), "utf8");
  check("页面回显循环 ≤80 次（8s）", src.includes("i < 80"));
  check("发送链路经 evalWithBudget", src.includes("await evalWithBudget(c, expr)") >= 0
    && (src.match(/await evalWithBudget\(c, expr\)/g) || []).length >= 2);
}

console.log(`\n===== eval_budget: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
