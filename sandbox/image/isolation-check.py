#!/usr/bin/python3 -I
# Checks, from inside a sandbox, that nothing an agent run leaves behind can outlive the next run's clean start
# (ADR 0004, "nothing carries over between runs"; #156). Two modes:
#   oryxa-isolation-check pid1      as agent: pid 1 runs as another user, and attaching to it with ptrace and
#                                   opening /proc/1/mem for writing are both refused.
#   oryxa-isolation-check no-agent  as root, right after a clean start: no live process has the agent's uid among
#                                   its real, effective, saved or file system user ids, and pid 1 has reaped
#                                   every one that was killed, so no zombie is left either.
# On a deployed sandbox, `pid1` runs through the gateway, which runs every exec as agent:
#   POST /v1/sandboxes/<tenant>/<company>/exec  {"argv": ["oryxa-isolation-check", "pid1"], "timeoutMs": 60000}
# Each line is one check; the exit code is 0 only when every check passed. Uses only Python's standard library.
import ctypes
import errno
import json
import os
import signal
import subprocess
import sys

AGENT_UID = 1001  # sandbox/harness/src/users.ts
PTRACE_ATTACH, PTRACE_DETACH, PTRACE_SEIZE = 16, 17, 0x4206
results = []


def record(check, observed, passed):
    results.append({"check": check, "observed": observed, "pass": passed})
    print(f"{'PASS' if passed else 'FAIL'}  {check}: {observed}", flush=True)


def note(check, observed):
    print(f"INFO  {check}: {observed}", flush=True)


def status(pid):
    with open(f"/proc/{pid}/status") as f:
        return dict(line.rstrip("\n").split(":\t", 1) for line in f if ":\t" in line)


def uids(fields):
    return [int(u) for u in fields["Uid"].split()]


libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
libc.ptrace.restype = ctypes.c_long


def ptrace(request, pid):
    """0 when the kernel allowed it, else the errno name."""
    ctypes.set_errno(0)
    if libc.ptrace(request, pid, None, None) == 0:
        return 0
    return errno.errorcode.get(ctypes.get_errno(), str(ctypes.get_errno()))


def open_mem(pid):
    """'opened' when /proc/<pid>/mem opened for writing, else the errno name."""
    try:
        os.close(os.open(f"/proc/{pid}/mem", os.O_RDWR))
        return "opened"
    except OSError as e:
        return errno.errorcode.get(e.errno, str(e.errno))


def setting(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError as e:
        return errno.errorcode.get(e.errno, str(e.errno))


def pid1():
    me = os.getuid()
    record("runs as agent", f"uid {me}", me == AGENT_UID)
    note("kernel.yama.ptrace_scope", setting("/proc/sys/kernel/yama/ptrace_scope"))
    note("own effective capabilities", status("self")["CapEff"])
    init = uids(status(1))
    record("pid 1 runs as another user", f"pid 1 user ids {init}", me not in init)

    # Control: the same calls on a child of this process succeed where the kernel allows tracing at all, so a refusal
    # of pid 1 below comes from the kernel's rules, not from a broken call.
    child = subprocess.Popen(["sleep", "30"])
    try:
        attached = ptrace(PTRACE_ATTACH, child.pid)
        if attached == 0:
            os.waitpid(child.pid, 0)
            ptrace(PTRACE_DETACH, child.pid)
        note("control: attach to own child", "allowed" if attached == 0 else f"refused ({attached})")
        note("control: open own child's mem for writing", open_mem(child.pid))
    finally:
        child.kill()
        child.wait()

    for name, request in (("PTRACE_ATTACH", PTRACE_ATTACH), ("PTRACE_SEIZE", PTRACE_SEIZE)):
        outcome = ptrace(request, 1)
        if outcome == 0:
            ptrace(PTRACE_DETACH, 1)
        record(f"{name} on pid 1 is refused", "allowed" if outcome == 0 else outcome, outcome == "EPERM")
    mem = open_mem(1)
    record("/proc/1/mem cannot be opened for writing", mem, mem in ("EACCES", "EPERM"))


def no_agent():
    record("runs as root", f"uid {os.getuid()}", os.getuid() == 0)
    live, zombies = [], []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            fields = status(name)
        except (FileNotFoundError, ProcessLookupError):
            continue
        if AGENT_UID not in uids(fields):
            continue
        # A zombie with one thread runs nothing and waits to be reaped; with more, its other threads still run.
        if fields.get("State", "")[:1] in ("Z", "X") and fields.get("Threads") == "1":
            zombies.append(int(name))
        else:
            live.append({"pid": int(name), "name": fields.get("Name"), "uids": uids(fields)})
    record("no live process has an agent user id, pid 1 included", json.dumps(live), live == [])
    record("no agent zombie waits to be reaped", json.dumps(zombies), zombies == [])


modes = {"pid1": pid1, "no-agent": no_agent}
if len(sys.argv) != 2 or sys.argv[1] not in modes:
    print(f"usage: {sys.argv[0]} {'|'.join(modes)}", file=sys.stderr)
    sys.exit(2)
signal.alarm(30)
modes[sys.argv[1]]()
failed = sum(1 for r in results if not r["pass"])
print(json.dumps({"checks": len(results), "failed": failed}))
sys.exit(0 if failed == 0 else 1)
