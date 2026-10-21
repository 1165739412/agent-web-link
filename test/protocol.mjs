// C9 消息协议：ChatGPT ↔ 协调器/CodeBuddy 任务交接的标记块解析
// 设计原则:
//   - 无标记的普通文本 = 普通聊天/解释，一律不执行
//   - 标记不完整、JSON 非法、类型未知、taskId 缺失 → 解析失败，安全停止（不猜测）
//   - 报告块独立解析，失败同样不自动重试
export const MARKERS = {
  taskBegin: "AGENT_TASK_BEGIN",
  taskEnd: "AGENT_TASK_END",
  reportBegin: "AGENT_REPORT_BEGIN",
  reportEnd: "AGENT_REPORT_END",
};

export const TASK_TYPES = ["ASSISTANT_TASK", "CONTINUE", "STOP", "NEEDS_USER_INPUT", "TASK_COMPLETE"];
// C9-R13 R13-2: 新增 ACTIONS_DONE / PARTIAL。
// DONE 仅作兼容保留（由 ChatGPT TASK_COMPLETE 决策或 agent 实际验证后确认的任务完成态）；
// 执行器自动生成的报告一律用 ACTIONS_DONE（actions 执行成功，但目标未验证），不得自称为 DONE。
export const REPORT_STATUS = ["DONE", "ACTIONS_DONE", "FAILED", "BLOCKED", "PARTIAL"];

// 通用块提取: 返回 [{ok:true, body, raw}] 或 [{ok:false, error:"incomplete"}]
export function parseBlocks(text, begin, end) {
  if (typeof text !== "string") return [];
  const out = [];
  let idx = 0;
  for (;;) {
    const b = text.indexOf(begin, idx);
    if (b < 0) break;
    const e = text.indexOf(end, b + begin.length);
    if (e < 0) {
      out.push({ ok: false, error: "incomplete", raw: text.slice(b, b + begin.length + 200) });
      break;
    }
    const body = text.slice(b + begin.length, e).trim();
    out.push({ ok: true, body, raw: text.slice(b, e + end.length) });
    idx = e + end.length;
  }
  return out;
}

// 容错 JSON 提取: 剥离 markdown 代码围栏；修复无效反斜杠转义后解析
// C9-R6 实机缺陷修复: ChatGPT 重新措辞时会把 Windows 路径的合法转义 f:\\agent-link
// 规范化成单反斜杠 f:\agent-link（\a 为无效 JSON 转义）→ 严格解析失败、任务无法发现。
// 修复策略: 将"非法转义序列前的单个反斜杠"加倍；合法转义(\" \\ \/ \b \f \n \r \t \uXXXX)保持不变。
// 安全边界不变: 解析宽容化不放宽执行权——type 白名单、taskId 必填、执行器白名单与
// 路径包含校验(node_check target 必须解析在项目根内)均在解析之后独立生效。
function tryParseJson(body) {
  const cleaned = body
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  if (!cleaned.startsWith("{")) return undefined;
  const repaired = cleaned.replace(/\\(?!["\\\/bfnrtu])/g, "\\\\");
  try { return JSON.parse(repaired); } catch {}
  try { return JSON.parse(cleaned); } catch {}
  return undefined;
}

// 解析任务块。每块返回:
//   { ok:true,  kind:"task", type, taskId, summary, actions, echo, raw }
//   { ok:false, kind:"task", error:"incomplete"|"json"|"type"|"taskId", raw }  ← 调用方必须安全停止，不得猜测执行
export function parseTaskBlocks(text) {
  return parseBlocks(text, MARKERS.taskBegin, MARKERS.taskEnd).map((b) => {
    if (!b.ok) return { ...b, kind: "task" };
    const json = tryParseJson(b.body);
    if (!json || typeof json !== "object") {
      return { ok: false, kind: "task", error: "json", raw: b.body.slice(0, 200) };
    }
    if (!TASK_TYPES.includes(json.type)) {
      return { ok: false, kind: "task", error: "type", raw: b.body.slice(0, 200) };
    }
    if (typeof json.taskId !== "string" || !json.taskId.trim()) {
      return { ok: false, kind: "task", error: "taskId", raw: b.body.slice(0, 200) };
    }
    return {
      ok: true, kind: "task",
      type: json.type,
      taskId: json.taskId.trim(),
      summary: typeof json.summary === "string" ? json.summary : "",
      actions: Array.isArray(json.actions) ? json.actions : [],
      echo: typeof json.echo === "string" ? json.echo : null,
      raw: b.raw,
    };
  });
}

// 解析报告块（用于识别 ChatGPT 对报告的引用，防重复回传与误读）
export function parseReportBlocks(text) {
  return parseBlocks(text, MARKERS.reportBegin, MARKERS.reportEnd).map((b) => {
    if (!b.ok) return { ...b, kind: "report" };
    const json = tryParseJson(b.body);
    if (!json || typeof json !== "object" || typeof json.taskId !== "string" || !json.taskId.trim()) {
      return { ok: false, kind: "report", error: "json", raw: b.body.slice(0, 200) };
    }
    return { ok: true, kind: "report", taskId: json.taskId.trim(), status: json.status || null, raw: b.raw };
  });
}

// 消息差分: 依据 id（助手）或 hash（用户）区分新消息与历史消息
export function diffMessages(prev, cur) {
  const prevIds = new Set((prev || []).filter((m) => m.id).map((m) => m.id));
  const prevSigs = new Set((prev || []).filter((m) => !m.id).map((m) => `${m.role}:${m.hash ?? 0}`));
  const curMsgs = cur || [];
  return {
    newAssistants: curMsgs.filter((m) => m.role === "assistant" && m.id && !prevIds.has(m.id)),
    newUsers: curMsgs.filter((m) => m.role === "user" && !prevSigs.has(`${m.role}:${m.hash ?? 0}`)),
  };
}

// 定位某条助手消息之前最近的一条用户消息（任务来源关联）
export function latestUserBefore(messages, assistantIndex) {
  for (let i = assistantIndex; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") return messages[i];
  }
  return null;
}
