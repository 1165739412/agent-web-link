// 可复用 DS 发送器：node send_to_ds.mjs <消息文件> [taskRef]
// 走生产 relay.sendAndRead 路径，定向到 DeepSeek 会话，读回回复并打印。
import fs from "node:fs";
import { sendAndRead, loadRelayConfig } from "./relay.mjs";

const file = process.argv[2];
const text = fs.readFileSync(file, "utf8");
const cfg = loadRelayConfig().config;
cfg.replyTimeoutMs = 120000; cfg.pollMs = 1500; cfg.stableNeed = 2;
// 目标 DeepSeek 会话需由使用者自行提供（环境变量 DS_CONV 或命令行第三参数），
// 不硬编码任何私人会话 ID。未提供时明确报错，避免误发到陌生会话。
const CONV = process.env.DS_CONV || process.argv[3] || "";
if (!/^[0-9a-fA-F-]{8,}$/.test(CONV)) {
  console.error("缺少有效的 DS_CONV（DeepSeek 会话 ID）。用法：DS_CONV=<id> node send_to_ds.mjs <消息文件>");
  process.exit(64);
}
const rr = await sendAndRead({ config: cfg, text, stateDir: "test/state", preferConvId: CONV, log: (m) => console.error(m) });
console.log("DS_ROUND " + JSON.stringify({
  ok: rr.ok, reason: rr.reason || null, runId: rr.runId, convId: rr.convId,
  backend: rr.backend || null, replyId: rr.replyId || null,
  replyText: rr.replyText || null,
}, null, 1));
process.exit(rr.ok ? 0 : 1);
