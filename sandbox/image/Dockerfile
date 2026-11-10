# The sandbox base image: the harness, Git and common build tools. Build context: sandbox/
#   docker build --platform linux/amd64 -f sandbox/image/Dockerfile sandbox
# The gateway's wrangler.jsonc builds it the same way. sandbox-shim is linux/amd64 only.
# Pinned by digest: a moved tag cannot change what runs in a customer's sandbox. To update, resolve the new tag's
# digest (docker buildx imagetools inspect <image>:<tag>) and replace both parts.
ARG NODE_IMAGE=node:24-trixie@sha256:8c761eca2bf7eec965f946cf47b8090143cb41f45f2f8699af0cc0298d2d2d19
ARG SANDBOX_SHIM_IMAGE=docker.io/cloudflare/sandbox:1.0.3@sha256:fc1740c3cba26461f0ab1771287c84018ab2cca43a70ebb823087c85d780aaec

FROM ${SANDBOX_SHIM_IMAGE} AS shim

FROM ${NODE_IMAGE} AS harness
WORKDIR /build
COPY harness/package.json harness/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY harness/tsconfig.json harness/tsconfig.build.json ./
COPY harness/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# The full Debian image already has git, curl, gcc, make and python3.
FROM ${NODE_IMAGE}
# The Sandbox SDK's file API runs this helper; its version matches @cloudflare/sandbox in the gateway.
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=harness /build/package.json /opt/oryxa-harness/package.json
COPY --from=harness /build/node_modules /opt/oryxa-harness/node_modules
COPY --from=harness /build/dist /opt/oryxa-harness/dist
COPY image/egress-check.mjs /usr/local/bin/oryxa-egress-check
COPY image/isolation-check.py /usr/local/bin/oryxa-isolation-check
# tini reaps what the clean start kills; Debian's build, pinned exactly, and apt checks it against the signed archive.
# Then no setuid or setgid file is left (su, mount, passwd, ssh-keysign and the rest): nothing here needs one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini=0.19.0-3+b8 \
  && rm -rf /var/lib/apt/lists/* \
  && find / -xdev -perm /6000 -type f -exec chmod ug-s {} +
# Three users, ids fixed because the gateway and the harness name them (sandbox/harness/src/users.ts):
# - agent (1001) runs the agent and every command it starts, and owns /workspace;
# - harness (1002) is what the harness becomes after it starts the agent, so the agent cannot open its stdin;
# - init (1003) runs only pid 1, owns nothing and cannot log in, so the agent can neither trace nor signal it.
# Context packs live in a directory only root can open; the gateway writes them as root.
RUN chmod +x /opt/oryxa-harness/dist/main.js /usr/local/bin/oryxa-egress-check /usr/local/bin/oryxa-isolation-check \
  && ln -s /opt/oryxa-harness/dist/main.js /usr/local/bin/oryxa-harness \
  && useradd --create-home --uid 1001 --user-group --shell /bin/bash agent \
  && useradd --create-home --uid 1002 --user-group --shell /usr/sbin/nologin harness \
  && useradd --no-create-home --home-dir /nonexistent --uid 1003 --user-group --shell /usr/sbin/nologin init \
  && chmod 700 /home/harness \
  && mkdir -p /workspace /etc/oryxa/runs \
  && chown agent:agent /workspace \
  && chmod 700 /etc/oryxa/runs
# Pid 1 (tini; the gateway's compatibility date gives the container its own pid namespace) runs as init, not agent:
# an agent process could otherwise trace it or write /proc/1/mem, and code put there would outlive every run's kill.
# Orphans pass to it, so it reaps what the clean start kills; it needs no capability for that and is no subreaper.
# init is also the user of an exec that names none, which owns nothing; the gateway names the user on every exec.
# HTTPS trusts the ephemeral CA that the gateway points every command at.
USER init
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
