#!/usr/bin/env python3
"""A stand-in for the web app's public address, for infra/scripts/test-smoke-test.sh only.

It answers the routes smoke-test.sh calls with canned responses, enforces the session cookie and the
CSRF rules (`X-Oryxa-Request: 1` and the app's `Origin` on a write), and logs one line per request.

    smoke-stub.py FLAGS LOGFILE        prints `PORT <n>` once it listens on a random loopback port

FLAGS is a comma-separated list, or `-`: today-missing, rotate, ingest-stuck, ingest-fails, no-agent, run-fails,
run-waits.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FLAGS = set(sys.argv[1].split(","))
LOG = sys.argv[2]
COOKIE = "__Host-fde_session"
SESSION = "stubsession0123456789abcdef"
NEXT_SESSION = "stubreissued0123456789abcdef"

state = {
    "session": SESSION,
    "tasks": {},
    "stage": "discover",
    "doc_polls": 0,
    "run_polls": 0,
    "rotated": False,
}
MARKER = {"text": ""}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # the test reads our own log instead
        pass

    def send(self, status, body=None, headers=()):
        raw = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        self.send_response(status)
        self.send_header("Content-Type", "application/json" if body is not None else "text/plain")
        self.send_header("Content-Length", str(len(raw)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def handle_any(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if length else b""
        path, _, query = self.path.partition("?")
        with open(LOG, "a") as f:
            f.write(f"{method} {path}\n")
        if path == "/api/healthz":
            if self.headers.get("Cookie"):
                with open(LOG, "a") as f:
                    f.write("LEAK cookie sent to healthz\n")
            return self.send(200, b"ok")
        if not path.startswith("/api/v1/"):
            return self.send(404, {"error": "not_found"})
        path = path[len("/api") :]
        jar = self.headers.get("Cookie") or ""
        if f"{COOKIE}={state['session']}" not in jar.split("; "):
            return self.send(401, {"error": "unauthorized"})
        if method != "GET":
            origin = f"http://127.0.0.1:{self.server.server_port}"
            if self.headers.get("X-Oryxa-Request") != "1" or self.headers.get("Origin") != origin:
                return self.send(403, {"error": "csrf"})
        extra = []
        if "rotate" in FLAGS and not state["rotated"]:
            # The API reseals a refreshed session: the old cookie stops working from here on.
            state["rotated"] = True
            state["session"] = NEXT_SESSION
            extra = [("Set-Cookie", f"{COOKIE}={NEXT_SESSION}; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Lax")]
        self.route(method, path, query, data, extra)

    def route(self, method, path, query, data, extra):
        parts = path.strip("/").split("/")  # v1, companies, c, ...
        body = json.loads(data) if data and "json" in (self.headers.get("Content-Type") or "") else None

        def ok(status, out=None):
            return self.send(status, out, extra)

        if path == "/v1/me":
            return ok(200, {"user": {"id": "u1", "name": "Smoke"}, "organisation": {"id": "o1", "name": "Test org"}, "role": "admin"})
        if path == "/v1/companies" and method == "POST":
            return ok(201, {"id": "cmp_1", "name": body["name"]})
        if path == "/v1/today":
            items = [] if "today-missing" in FLAGS else [
                {"kind": "task", "task": {"id": t, "title": "x", "status": "todo"}, "company": {}, "project": {}}
                for t in state["tasks"]
            ]
            return ok(200, {"items": items})
        if len(parts) < 3 or parts[1] != "companies" or parts[2] != "cmp_1":
            return ok(404, {"error": "not_found"})
        rest = "/".join(parts[3:])
        if rest == "projects" and method == "POST":
            return ok(201, {"id": "prj_1", "company": "cmp_1", "name": body["name"], "stage": "discover"})
        if not rest.startswith(("documents", "search", "projects/prj_1")):
            return ok(404, {"error": "not_found"})
        sub = rest.removeprefix("projects/prj_1").strip("/")
        if sub == "tasks" and method == "POST":
            state["tasks"]["tsk_1"] = body["title"]
            return ok(201, {"id": "tsk_1", "title": body["title"], "status": body["status"]})
        if sub == "tasks/tsk_1" and method == "DELETE":
            state["tasks"].pop("tsk_1", None)
            return ok(204)
        if sub == "stage-checklist":
            items = [{"key": "scope_signed_off", "label": "Scope signed off", "met": False}] if state["stage"] == "discover" else []
            return ok(200, {"stage": state["stage"], "items": items})
        if sub == "stage" and method == "PUT":
            if state["stage"] == "discover" and not body.get("reason"):
                return ok(409, {"error": "rejected_checklist_open", "open": []})
            state["stage"] = body["stage"]
            return ok(200, {"id": "prj_1", "company": "cmp_1", "name": "x", "stage": state["stage"]})
        if rest == "documents" and method == "POST":
            MARKER["text"] = data.decode()
            return ok(201, {"id": "doc_1", "name": "x", "status": "pending", "chunks": 0})
        if rest == "documents/doc_1":
            state["doc_polls"] += 1
            if "ingest-fails" in FLAGS:
                return ok(200, {"id": "doc_1", "status": "failed", "failure": "unreadable", "chunks": 0})
            done = "ingest-stuck" not in FLAGS and state["doc_polls"] >= 3
            return ok(200, {"id": "doc_1", "status": "ingested" if done else "pending", "chunks": 1 if done else 0})
        if rest == "search":
            return ok(200, [{"document": "doc_1", "document_name": "x", "chunk": 0, "text": MARKER["text"], "score": 1.0}])
        if sub.startswith("agent-runs"):
            return self.agent(method, sub, body, ok)
        return ok(404, {"error": "not_found"})

    def agent(self, method, sub, body, ok):
        if "no-agent" in FLAGS:
            return self.send(404, b"")  # the router has no such route: no JSON body
        if sub == "agent-runs" and method == "GET":
            return ok(200, [])
        if sub == "agent-runs" and method == "POST":
            assert body["repository"] == {"owner": "oryxa-sample", "name": "hello", "base": "main"}, body
            return ok(202, {"id": "run_1", "state": "queued"})
        if sub == "agent-runs/run_1":
            state["run_polls"] += 1
            n = state["run_polls"]
            st = "queued" if n < 2 else "running" if n < 3 else "failed" if "run-fails" in FLAGS else "finished"
            if "run-waits" in FLAGS and n >= 2:
                st = "waiting_for_approval"
            return ok(200, {"id": "run_1", "state": st, "failure": "timed_out" if st == "failed" else None})
        if sub == "agent-runs/run_1/events":
            n = state["run_polls"]
            events = [] if n < 2 else [{"type": "message", "seq": 0}] if n < 3 else [{"type": "message", "seq": 0}, {"type": "result", "seq": 1}]
            return ok(200, {"events": events})
        if sub == "agent-runs/run_1/cancel" and method == "POST":
            return ok(202, {"id": "run_1", "state": "failed"})
        return ok(404, {"error": "not_found"})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PUT(self):
        self.handle_any("PUT")

    def do_DELETE(self):
        self.handle_any("DELETE")


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(f"PORT {server.server_port}", flush=True)
server.serve_forever()
