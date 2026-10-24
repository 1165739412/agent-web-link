// read_reply_schema_test —— R-002 ②：agent_link_read_reply 的 clearedPending 形态契约固化。
// 证据（relay.mjs clearMatchingPending）：四种组合均返回对象（{cleared,...}），从不返回数组；
// readLatestReply 在 clearPending=false 时不设置该键（mcp_server 侧 || undefined 剔除）。
// 因此 outputSchema 保持 {"type":"object"} 是正确的；本测试把该结论固化为断言，
// 防止未来 relay 改成数组时 structuredContent 再次静默丢失。
import assert from "node:assert";
import { TOOLS, validateSchema } from "./mcp_server.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log((cond ? "[PASS] " : "[FAIL] ") + name + (detail ? " | " + detail : ""));
};

const tool = TOOLS.find((t) => t.name === "agent_link_read_reply");
assert(tool, "read_reply 工具定义存在");
const schema = tool.outputSchema;

const base = { ok: true, replyText: "回复", targetUrl: "https://chat.deepseek.com/a/chat/s/x", lane: "default" };

// 形态 1：有清理记录（对象）
{
  const r = { ...base, clearedPending: { cleared: true, runId: "r-1", unverified: true }, assistantCount: 3, convId: "c", backend: "deepseek" };
  check("对象 clearedPending 通过", validateSchema(r, schema, "s").length === 0);
}
// 形态 2：无记录（cleared:false 对象）
{
  const r = { ...base, clearedPending: { cleared: false, reason: "NO_PENDING" } };
  check("无记录对象通过", validateSchema(r, schema, "s").length === 0);
}
// 形态 3：keepPending=true → 键不出现
{
  check("键缺失通过", validateSchema(base, schema, "s").length === 0);
}
// 形态 4（护栏）：若未来 relay 改成数组，必须在 server 侧先改 schema/归一——当前应判失败
{
  const r = { ...base, clearedPending: [{ cleared: true }] };
  const errs = validateSchema(r, schema, "s");
  check("数组形态当前被判失败（防静默丢失的护栏，改 relay 时须同步 schema）", errs.length > 0);
}
// 形态 5：assistantCount 整数（R-002 历史修复回归）
{
  const r = { ...base, assistantCount: 3 };
  check("assistantCount 整数通过", validateSchema(r, schema, "s").length === 0);
}

console.log(`\n===== read_reply_schema: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
