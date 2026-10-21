// C9-R24-MCP 步骤1：通过正式任务提交接口（local_service.submit，HTTP POST /v1/tasks 的同款实现）提交一个 agent 模式任务。
// agent 模式：只登记、不自带白名单动作、本地 Worker 永不执行，交由真实 Host MCP 会话领取执行。
// 不启动 HTTP 服务器、不触发 startup 恢复（不调用 start()/kick()），仅纯登记，避免触碰历史证据。
import { createTaskService, DEFAULT_PROJECTS_FILE, DEFAULT_TOKEN_FILE } from "./local_service.mjs";
import fs from "node:fs";
import path from "node:path";

const svc = createTaskService({ projectsFile: DEFAULT_PROJECTS_FILE, tokenFile: DEFAULT_TOKEN_FILE, log: () => {} });
const taskId = "t-r24mcp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
const summary = process.argv[2] || "对 test/protocol.mjs 执行 node_check 语法检查（C9-R24-MCP 实机闭环验证）";
const res = svc.submit({ project: "agent-link", taskId, summary, mode: "agent" });
console.log("SUBMIT " + JSON.stringify({ taskId, ...res }));
if (res.ok) {
  fs.writeFileSync(path.join(DEFAULT_PROJECTS_FILE, "..", "state", "r24mcp_taskid.txt"), taskId, "utf8");
}
process.exit(res.ok ? 0 : 1);
