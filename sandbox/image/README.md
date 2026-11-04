# Sandbox image

The image every company's sandbox runs. It is based on `node:24-trixie`, the full Debian image, so git, curl,
gcc, make and python3 are already there. It adds `sandbox-shim` from `cloudflare/sandbox:1.0.3`, which the
gateway's file API runs, the harness at `/usr/local/bin/oryxa-harness`, and the egress check at
`/usr/local/bin/oryxa-egress-check`.

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
| `root`    | 0    | Only the gateway's pack write and the harness's first moments                  | `/etc/oryxa/runs` (0700)    |

The image's default user is `agent`, but the gateway names the user on every call. The image holds no
credentials and no CA. When the gateway intercepts HTTPS, it re-signs the traffic with an ephemeral CA that
Cloudflare writes at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` when the container starts. Every command
the gateway runs gets `SSL_CERT_FILE` and the related variables pointing at that file.

## Egress check

Only HTTP on 80 and HTTPS on 443 should leave a sandbox, and only through the gateway. Run the check on a deployed
sandbox and record the result below:

```bash
curl -sS -H "authorization: Bearer $SERVICE_TOKEN" -X POST \
  "$GATEWAY/v1/sandboxes/<tenant>/<company>/exec" -d '{"argv":["oryxa-egress-check"],"timeoutMs":120000}'
```

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
