# Throwaway image for the OpenCode spike (issue #123). Never used by the product: the product's sandbox image is
# linux/amd64 only, and this builds for the machine it runs on (arm64 on the spike machine, amd64 in CI).
#   docker build -t fde-123-opencode -f opencode-spike/Dockerfile opencode-spike
FROM node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
ARG OPENCODE_VERSION=2.2.7
# SHA256SUMS of the release, pinned by its own hash so a re-uploaded asset list cannot move the pin.
ARG SHA256SUMS_SHA256=72c73a07124c65662239facaa7da2f3fe474078bbd4cbfa68bf90ae8fdca3b8b
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tcpdump iproute2 procps strace jq ripgrep \
  && rm -rf /var/lib/apt/lists/*
# The binary is downloaded here, at build time, and checked against the release's published checksum list.
RUN set -eu; \
  case "$(uname -m)" in aarch64) asset=opencode-linux-arm64.tar.gz;; x86_64) asset=opencode-linux-x64.tar.gz;; esac; \
  base="https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}"; \
  mkdir /tmp/dl && cd /tmp/dl; \
  curl -fsSL -o SHA256SUMS "$base/SHA256SUMS"; \
  echo "${SHA256SUMS_SHA256}  SHA256SUMS" | sha256sum -c -; \
  curl -fsSL -o "$asset" "$base/$asset"; \
  grep " $asset\$" SHA256SUMS | sha256sum -c -; \
  tar -xzf "$asset"; \
  install -m 0755 opencode /usr/local/bin/opencode; \
  cp SHA256SUMS /opt/SHA256SUMS; \
  cd / && rm -rf /tmp/dl
# OpenCode's grep and glob need ripgrep: they use an `rg` on PATH, else one downloaded from github.com. The lab keeps `rg`
# off PATH (in /opt/rg) so a case can show both.
RUN mkdir /opt/rg && mv /usr/bin/rg /opt/rg/rg
RUN useradd --create-home --uid 1001 --user-group --shell /bin/bash agent \
  && mkdir -p /workspace /spike && chown agent:agent /workspace
USER agent
WORKDIR /workspace
