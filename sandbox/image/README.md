# Sandbox image

The image every company's sandbox runs. It is based on `node:24-trixie`, the full Debian image, so git, curl,
gcc, make and python3 are already there. It adds `sandbox-shim` from `cloudflare/sandbox:1.0.3`, which the
gateway's file API runs, the harness at `/usr/local/bin/oryxa-harness`, the egress check at
`/usr/local/bin/oryxa-egress-check` and the isolation check at `/usr/local/bin/oryxa-isolation-check`.

```bash
docker build --platform linux/amd64 -f sandbox/image/Dockerfile sandbox
```

The build context is `sandbox/`, and the gateway's `wrangler.jsonc` builds it the same way. `sandbox-shim` is
`linux/amd64` only. The image is about 750 MB compressed and 2.8 GB unpacked.

Both base images are pinned by digest as well as tag, so a moved tag cannot change what runs in a customer's
sandbox. To update one, resolve the new tag's digest (`docker buildx imagetools inspect <image>:<tag>`) and change
both parts of the reference.

## Users

| User      | Uid  | Runs                                                                           | Owns                        |
| --------- | ---- | ------------------------------------------------------------------------------ | --------------------------- |
| `agent`   | 1001 | The agent and every command it starts; every `exec` and file call from the API | `/workspace`, `/home/agent` |
| `harness` | 1002 | The harness, after it has started the agent as `agent`                         | `/home/harness` (0700)      |
| `init`    | 1003 | Only pid 1, the image's `sleep infinity`; it cannot log in                     | Nothing                     |
| `root`    | 0    | Only the gateway's pack write and the harness's first moments                  | `/etc/oryxa/runs` (0700)    |

The image's default user is `init`, so pid 1 does not run as `agent`: an agent process can neither trace it nor
write `/proc/1/mem`, and nothing it leaves there outlives the clean start of the next run. The gateway's
compatibility date (2026-04-01 or later) gives the container its own pid namespace, in which the image's command
is pid 1. The gateway names the user on every call; an exec that named none would run as `init`, which owns
nothing. The image holds no credentials and no CA. When the gateway intercepts HTTPS, it re-signs the traffic with
an ephemeral CA that Cloudflare writes at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` when the container
starts. Every command the gateway runs gets `SSL_CERT_FILE` and the related variables pointing at that file.

## Egress check

Only HTTP on 80 and HTTPS on 443 should leave a sandbox, and only through the gateway. Run the check on a deployed
sandbox and record the result below:

```bash
curl -sS -H "authorization: Bearer $SERVICE_TOKEN" -H "x-oryxa-lease: <generation>" -X POST \
  "$GATEWAY/v1/sandboxes/<tenant>/<company>/exec" -d '{"argv":["oryxa-egress-check"],"timeoutMs":120000}'
```

`<generation>` is the sandbox's current lease generation in the API's store (`sandbox/gateway/README.md`). A higher
one would make the gateway refuse every call from the run that holds the sandbox next.

It tries TCP to ports 22, 53, 853, 8080 and 8443 on public addresses, a UDP DNS query to public resolvers, a
lookup of a fresh random name through each configured resolver (an answer, even NXDOMAIN, means the query left),
and plain and TLS requests to a host that is not on the allowlist (only the gateway's `403` may answer). It
prints one line per check and exits 0 only if every check passed. It uses only Node's standard library, so the
image carries no extra network tools.

| Date            | Environment                                       | Result                                                     |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| 4 November 2026 | Local Docker, `--network none` (the check itself) | 17 of 17 passed                                            |
| 4 November 2026 | Local Docker, host network (egress open)          | 4 failed: UDP DNS and both resolvers answered, as expected |
| Pending         | First Cloudflare deploy                           | To run and record                                          |

## Isolation check

Nothing an agent run leaves behind may outlive the next run's clean start (ADR 0004, #156). `oryxa-isolation-check`
has two modes. `pid1`, run as `agent`, checks that pid 1 runs as another user and that `PTRACE_ATTACH`,
`PTRACE_SEIZE` and opening `/proc/1/mem` for writing are refused. A control on its own child shows the calls work
where the kernel allows them. `no-agent`, run as root right after a clean start, checks that no live process has
the agent's uid among its user ids, pid 1 included. It uses only Python's standard library.

`test/real-image.sh <image>` runs both on Docker with no network, mounts or credentials. It leaves agent processes
running (a detached session, a stopped process, a thread whose main thread exited), runs the harness's clean start
as root, and checks again. A control container starts pid 1 as `agent`, as the image did before #156: the pid 1
check must fail there, and the clean start must refuse to run. The CI job that runs it on the product image is a
separate, lead-reviewed step.

Docker is only a stand-in. Whether the agent can trace another process of its own user depends on the kernel's
`kernel.yama.ptrace_scope`, its capabilities and seccomp, which the Cloudflare runtime does not document. With
pid 1 under its own user the refusal no longer depends on them, but the first deployed sandbox runs the check and
records the ptrace scope it prints:

```bash
curl -sS -H "authorization: Bearer $SERVICE_TOKEN" -H "x-oryxa-lease: <generation>" -X POST \
  "$GATEWAY/v1/sandboxes/<tenant>/<company>/exec" -d '{"argv":["oryxa-isolation-check","pid1"],"timeoutMs":60000}'
```

| Date             | Environment                                         | Result                                             |
| ---------------- | --------------------------------------------------- | -------------------------------------------------- |
| 10 November 2026 | Local Docker, a build not for linux/amd64           | `real-image.sh`: 9 of 9 passed                     |
| Pending          | `real-image.sh` on the linux/amd64 image in CI      | To add as a CI job (lead review) and record        |
| Pending          | First Cloudflare deploy, `pid1` through the gateway | To run and record, with the ptrace scope it prints |
