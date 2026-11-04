# Sandbox image

The image every company's sandbox runs. It is based on `node:24-trixie`, the full Debian image, so git, curl,
gcc, make and python3 are already there. It adds `sandbox-shim` from `cloudflare/sandbox:1.0.3`, which the
gateway's file API runs, and the harness at `/usr/local/bin/oryxa-harness`. Everything runs as the non-root user
`agent`, in `/workspace`.

```bash
docker build --platform linux/amd64 -f sandbox/image/Dockerfile sandbox
```

The build context is `sandbox/`, and the gateway's `wrangler.jsonc` builds it the same way. `sandbox-shim` is
`linux/amd64` only. The image is about 750 MB compressed and 2.8 GB unpacked.

The image holds no credentials and no CA. When the gateway intercepts HTTPS, it re-signs the traffic with an
ephemeral CA that Cloudflare writes at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` when the container
starts. Every command the gateway runs gets `SSL_CERT_FILE` and the related variables pointing at that file.
