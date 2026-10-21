// 测试用 mock runner：读取任务 drop 文件并回显，用于验证 agent_dispatch 任务感知管道（无需 claude/登录）
import fs from "node:fs";
const tf = process.argv[2];
const task = JSON.parse(fs.readFileSync(tf, "utf8"));
console.log(`MOCK-EXECUTED:${task.taskId}`);
process.exit(0);
