"""C9-R20 本地协作服务 Python 客户端（仅标准库，无第三方依赖）。

用途：其他项目的 Python 脚本无需实现 ChatGPT 通信 / Agent 调度 / 任务登记 / 去重 /
报告回传，只要提交任务、查询状态、取回报告即可。

安全边界：
  - 只与本机服务通信（建议 --base-url http://127.0.0.1:<port>）；
  - 命令与工作目录由服务端的受信任项目配置决定，本客户端只能指定项目名与白名单动作（op/target）；
  - 客户端不接受任意 shell 命令。

用法示例：
  python agent_link_client.py health
  python agent_link_client.py node-check --project agent-link --target test/protocol.mjs
  python agent_link_client.py submit --project agent-link --target test/protocol.mjs --summary "语法检查"
  python agent_link_client.py wait   --project agent-link --task-id <id>
  python agent_link_client.py report --project agent-link --task-id <id>
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request


class AgentLinkError(RuntimeError):
    def __init__(self, http_status, code, message):
        super().__init__(f"HTTP {http_status} {code}: {message}")
        self.http_status = http_status
        self.code = code
        self.message = message


class AgentLinkClient:
    def __init__(self, base_url="http://127.0.0.1:8787", token=None, token_file=None, timeout=15):
        token = token or os.environ.get("AGENT_LINK_TOKEN")
        if not token and token_file:
            with open(token_file, "r", encoding="utf-8") as f:
                token = f.read().strip()
        if not token:
            raise ValueError("缺少服务令牌：请传 token、token_file 或设置 AGENT_LINK_TOKEN")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    # ---------- 传输 ----------
    def _request(self, method, path, payload=None, auth=True):
        url = self.base_url + path
        data = None
        headers = {"accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["content-type"] = "application/json"
        if auth:
            headers["x-auth-token"] = self.token
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                obj = json.loads(body)
            except Exception:
                obj = {}
            raise AgentLinkError(e.code, obj.get("code", "HTTP_ERROR"), obj.get("message", body[:200]))

    # ---------- 三个基本操作 ----------
    def health(self):
        return self._request("GET", "/v1/health", auth=False)

    def submit(self, project, actions, summary=None, task_id=None, mode=None):
        """提交任务。mode="agent" 表示交给真实编程 Agent 执行（不接受 actions）。"""
        payload = {"project": project, "actions": actions or []}
        if summary:
            payload["summary"] = summary
        if task_id:
            payload["taskId"] = task_id
        if mode:
            payload["mode"] = mode
        return self._request("POST", "/v1/tasks", payload)

    def submit_agent_task(self, project, summary, task_id=None):
        return self.submit(project, [], summary=summary, task_id=task_id, mode="agent")

    def status(self, project, task_id):
        return self._request("GET", f"/v1/tasks/{task_id}?project={project}")

    def report(self, project, task_id):
        return self._request("GET", f"/v1/tasks/{task_id}/report?project={project}")

    # ---------- 便捷封装 ----------
    def wait(self, project, task_id, timeout=120, interval=0.3):
        """轮询到终态（REPORTED / FAILED / BLOCKED / REPORT_UNKNOWN），返回最后的状态对象。"""
        terminal = {"REPORTED", "FAILED", "BLOCKED", "REPORT_UNKNOWN"}
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = self.status(project, task_id)
            if last.get("task", {}).get("phase") in terminal:
                return last
            time.sleep(interval)
        raise TimeoutError(f"任务未在 {timeout}s 内结束，最后状态: {json.dumps(last, ensure_ascii=False)}")

    def node_check(self, project, target, summary=None, timeout=120):
        """提交一个 node_check 任务并等待完成，返回 (提交响应, 状态, 报告)。"""
        submitted = self.submit(project, [{"op": "node_check", "target": target}],
                                summary=summary or f"node_check {target}")
        st = self.wait(project, submitted["taskId"], timeout=timeout)
        rep = self.report(project, submitted["taskId"])
        return submitted, st, rep


def _build_parser():
    p = argparse.ArgumentParser(description="agent-link 本地服务客户端")
    p.add_argument("--base-url", default=os.environ.get("AGENT_LINK_BASE_URL", "http://127.0.0.1:8787"))
    p.add_argument("--token-file", default=os.environ.get("AGENT_LINK_TOKEN_FILE"))
    p.add_argument("--token", default=None)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("health")

    s = sub.add_parser("submit")
    s.add_argument("--project", required=True)
    s.add_argument("--target", required=True)
    s.add_argument("--summary", default=None)
    s.add_argument("--task-id", default=None)

    g = sub.add_parser("agent-task", help="提交由真实编程 Agent 执行的任务（不接受命令，只给工作内容描述）")
    g.add_argument("--project", required=True)
    g.add_argument("--summary", required=True)
    g.add_argument("--task-id", default=None)

    for name in ("wait", "report"):
        q = sub.add_parser(name)
        q.add_argument("--project", required=True)
        q.add_argument("--task-id", required=True)
        if name == "wait":
            q.add_argument("--timeout", type=float, default=120)

    n = sub.add_parser("node-check")
    n.add_argument("--project", required=True)
    n.add_argument("--target", required=True)
    n.add_argument("--summary", default=None)
    n.add_argument("--timeout", type=float, default=120)
    return p


def main(argv=None):
    args = _build_parser().parse_args(argv)
    client = AgentLinkClient(base_url=args.base_url, token=args.token, token_file=args.token_file)
    try:
        if args.cmd == "health":
            out = client.health()
        elif args.cmd == "submit":
            out = client.submit(args.project, [{"op": "node_check", "target": args.target}],
                                summary=args.summary, task_id=args.task_id)
        elif args.cmd == "agent-task":
            out = client.submit_agent_task(args.project, args.summary, task_id=args.task_id)
        elif args.cmd == "wait":
            out = client.wait(args.project, args.task_id, timeout=args.timeout)
        elif args.cmd == "report":
            out = client.report(args.project, args.task_id)
        elif args.cmd == "node-check":
            _, st, rep = client.node_check(args.project, args.target, summary=args.summary, timeout=args.timeout)
            out = {"status": st, "report": rep}
        else:
            raise SystemExit(f"未知命令: {args.cmd}")
    except AgentLinkError as e:
        print(json.dumps({"ok": False, "httpStatus": e.http_status, "code": e.code, "message": e.message},
                         ensure_ascii=False))
        return 1
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
