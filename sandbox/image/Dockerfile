# The sandbox base image: the harness, Git and common build tools. Build context: sandbox/
#   docker build --platform linux/amd64 -f sandbox/image/Dockerfile sandbox
# The gateway's wrangler.jsonc builds it the same way. sandbox-shim is linux/amd64 only.
ARG NODE_IMAGE=node:24-trixie
ARG SANDBOX_SHIM_IMAGE=docker.io/cloudflare/sandbox:1.0.3

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
RUN chmod +x /opt/oryxa-harness/dist/main.js \
  && ln -s /opt/oryxa-harness/dist/main.js /usr/local/bin/oryxa-harness \
  && useradd --create-home --uid 1001 --shell /bin/bash agent \
  && mkdir -p /workspace/.oryxa \
  && chown -R agent:agent /workspace
# The agent never runs as root. HTTPS trusts the ephemeral CA that the gateway points every command at.
USER agent
WORKDIR /workspace
CMD ["sleep", "infinity"]
