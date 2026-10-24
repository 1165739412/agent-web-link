// eval_budget_test —— R-002 根因 (b) 的离线回归：CDP 求值永久挂起时，
// evalWithBudget 必须在预算内返回结构化错误而不是永久卡死（DS 批次 8 评审钉死）。
// 纯 mock，不触浏览器。运行：node test/eval_budget_test.mjs
import assert from "node:assert";
import { PAGE_ECHO_BUDGET_MS, EVAL_BUDGET_MS, evalWithBudget, typeIntoComposer } from "./agent_backends.mjs";
import { REQ_TIMEOUT } from "./cdp_ws_client.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log((cond ? "[PASS] " : "[FAIL] ") + name + (detail ? " | " + detail : ""));
};

// 静态不变量（分层，DS 复查第 1 条）：页面预算 < 外部预算 + margin < REQ_TIMEOUT
check("分层预算：page < external < REQ_TIMEOUT",
  PAGE_ECHO_BUDGET_MS < EVAL_BUDGET_MS && EVAL_BUDGET_MS + 1000 < REQ_TIMEOUT,
  `page=${PAGE_ECHO_BUDGET_MS} external=${EVAL_BUDGET_MS} REQ_TIMEOUT=${REQ_TIMEOUT}`);

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

// 静态：typeIntoComposer 页面循环上限为 50（5s=PAGE_ECHO_BUDGET_MS）且 send 走 evalWithBudget
{
  const src = (await import("node:fs")).readFileSync(new URL("./agent_backends.mjs", import.meta.url), "utf8");
  check("页面回显循环 ≤50 次（5s）", src.includes("i < 50"));
  check("发送链路经 evalWithBudget",
    (src.match(/await evalWithBudget\(c, expr\)/g) || []).length >= 2);
}

// 分层回归（DS 复查第 1 条新增）：页面预算走满返回 echoed:false —— 必须是优雅降级而非
// EVAL_BUDGET_EXCEEDED（mock evaluate 在页面预算内正常返回，证明 fallback 路径可达）
{
  const fakeCdp = {
    send: async () => ({ result: { value: JSON.stringify({ ok: true, echoed: false, len: 5 }) } }),
  };
  const fakeBackend = { composer: "textarea", sendButton: "#x", user: "", assistant: "",
                        loadErrPattern: "", limitPatterns: [], newChatButtonPattern: "" };
  const r = await typeIntoComposer(fakeCdp, "hello", fakeBackend);
  check("页面预算走满 → echoed:false 优雅降级（非 hard error）",
        r.ok === true && r.echoed === false, JSON.stringify(r));
}

console.log(`\n===== eval_budget: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
