#!/usr/bin/env python3
"""A stand-in for the web app's public address, for infra/scripts/test-smoke-test.sh only.

It answers the two routes smoke-test.sh calls with canned responses, enforces the session cookie and the
CSRF header (`X-Oryxa-Request: 1`), and logs one line per request.

    smoke-stub.py FLAGS LOGFILE        prints `PORT <n>` once it listens on a random loopback port

FLAGS is a comma-separated list, or `-`: rotate (the API reseals the session on the first signed-in request),
no-org (/v1/me answers without an organisation), down (/healthz answers 502, as the Worker does with no API),
slow (/v1/me takes 3 s, so the test can interrupt the script while it waits).
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FLAGS = set(sys.argv[1].split(","))
LOG = sys.argv[2]
COOKIE = "__Host-fde_session"
SESSION = "stubsession0123456789abcdef"
NEXT_SESSION = "stubreissued0123456789abcdef"

state = {"session": SESSION, "rotated": False}


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

    def do_GET(self):
        path, _, _ = self.path.partition("?")
        with open(LOG, "a") as f:
            f.write(f"GET {path}\n")
        if path == "/api/healthz":
            if self.headers.get("Cookie"):
                with open(LOG, "a") as f:
                    f.write("LEAK cookie sent to healthz\n")
            return self.send(502, {"error": "upstream"}) if "down" in FLAGS else self.send(200, b"ok")
        if self.headers.get("X-Oryxa-Request") != "1":
            return self.send(403, {"error": "csrf"})
        jar = self.headers.get("Cookie") or ""
        if f"{COOKIE}={state['session']}" not in jar.split("; "):
            return self.send(401, {"error": "unauthorized"})
        extra = []
        if "rotate" in FLAGS and not state["rotated"]:
            # The API reseals a refreshed session: the old cookie stops working from here on.
            state["rotated"] = True
            state["session"] = NEXT_SESSION
            extra = [("Set-Cookie", f"{COOKIE}={NEXT_SESSION}; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Lax")]
        if path == "/api/v1/me":
            if "slow" in FLAGS:
                time.sleep(3)
            me = {"user": {"id": "u1", "name": "Smoke"}, "role": "admin"}
            if "no-org" not in FLAGS:
                me["organisation"] = {"id": "o1", "name": "Test org"}
            return self.send(200, me, extra)
        return self.send(404, {"error": "not_found"}, extra)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(f"PORT {server.server_port}", flush=True)
server.serve_forever()
