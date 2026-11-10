# Sandbox image

The image every company's sandbox runs. It is based on `node:24-trixie`, the full Debian image, so git, curl,
gcc, make and python3 are already there. It adds `sandbox-shim` from `cloudflare/sandbox:1.0.3`, which the
gateway's file API runs, the harness at `/usr/local/bin/oryxa-harness`, the egress check at
`/usr/local/bin/oryxa-egress-check`, the isolation check at `/usr/local/bin/oryxa-isolation-check`, and `tini` from
Debian's archive as pid 1. No file in the image is setuid or setgid.

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
| `init`    | 1003 | Only pid 1 (`tini`) and its child, `sleep infinity`; it cannot log in          | Nothing                     |
| `root`    | 0    | Only the gateway's pack write and the harness's first moments                  | `/etc/oryxa/runs` (0700)    |

The image's default user is `init`, so pid 1 does not run as `agent`: an agent process can neither trace it nor
write `/proc/1/mem`, and nothing it leaves there outlives the clean start of the next run. The gateway's
compatibility date (2026-04-01 or later) gives the container its own pid namespace, in which the image's entrypoint,
`tini`, is pid 1. The gateway names the user on every call; an exec that named none would run as `init`, which owns
nothing. The image holds no credentials and no CA. When the gateway intercepts HTTPS, it re-signs the traffic with
an ephemeral CA that Cloudflare writes at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` when the container
starts. Every command the gateway runs gets `SSL_CERT_FILE` and the related variables pointing at that file.

## Pid 1 and setuid files

Pid 1 is `tini` (`/usr/bin/tini -- sleep infinity`), Debian trixie's `tini` package pinned at `0.19.0-3+b8`. apt
reads the `snapshot.debian.org` archive at `20261027T000000Z`, the timestamp the digest-pinned base image was itself
built from (the comment in its `/etc/apt/sources.list.d/debian.sources`), not the live archive, which drops a version
once Debian supersedes it. apt checks the package against the snapshot's signed index (only `Valid-Until`, which a
snapshot's Release files have passed, is not checked), and a build fails rather than take another version. Every
process orphaned in the container passes to pid 1, so when the clean start kills an earlier run's processes, `tini`
reaps them and no zombie is left until the container stops. Reaping needs no capability, and as pid 1 it does not
register as a subreaper. It reads no file after it starts, and the image sets none of its options or variables.
To update it, change the version in the Dockerfile to one the snapshot has for both amd64 and arm64, and the
`DEBIAN_SNAPSHOT` timestamp whenever the base image's digest changes. This is the only package the Dockerfile installs
with apt; the harness's npm packages come from its lockfile.

The base image ships `chage`, `chfn`, `chsh`, `expiry`, `gpasswd`, `mount`, `newgrp`, `passwd`, `su`, `umount`,
`ssh-agent`, `ssh-keysign` and `unix_chkpwd` setuid or setgid. The Dockerfile clears the bits on every file that has
them, after `tini` is installed, so a package added there is covered too. Nothing in a sandbox uses them: the harness
drops from root with `setuid` itself, the gateway runs every exec as a named user, and the git steps use HTTPS with
the credentials added by the gateway, so no SSH. No file in the base image has file capabilities either.

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
the agent's uid among its user ids, pid 1 included, and that no agent zombie waits to be reaped. It uses only
Python's standard library.

`test/real-image.sh <image>` runs both on Docker with no network, mounts or credentials, and checks that no file is
setuid or setgid. It leaves agent processes running (a detached session, a stopped process, a thread whose main
thread exited), runs the harness's clean start as root, and checks again. Two control containers replace `tini` with
plain `sleep infinity`. In one it runs as `init`, as the image did before #160: the clean start succeeds, but the
processes it killed stay as zombies, so the zombie check must fail there. In the other it runs as `agent`, as the
image did before #156: the pid 1 check must fail there, and the clean start must refuse to run. The `sandbox-image`
job in `.github/workflows/ci.yml` builds the `linux/amd64` image from this Dockerfile and runs it, on every pull
request that changes `sandbox/` or the workflow and on every push to `main`.

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
| 10 November 2026 | Local Docker, a build not for linux/amd64, `tini`   | `real-image.sh`: 13 of 13 passed (#160)            |
| Pending          | `real-image.sh` on the linux/amd64 image in CI      | To add as a CI job (lead review) and record        |
| Pending          | First Cloudflare deploy, `pid1` through the gateway | To run and record, with the ptrace scope it prints |
