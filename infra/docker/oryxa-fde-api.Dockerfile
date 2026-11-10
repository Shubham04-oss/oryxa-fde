# The oryxa-fde backend image for ECS Fargate, linux/arm64 (the repository keeps its name, oryxa-fde-api).
# One image, several entrypoints: every task runs the same commit's binaries, so the API, the workers
# and the one-off migrations can never disagree about the schema or the events. Each task definition
# picks its binary with `entryPoint`; the API is the image's default. The binaries are compiled before this, on
# the runner (.github/workflows/deploy-api.yml), so the image only adds them to a distroless base: no
# shell, no package manager and no other program, runs as nonroot, writes nothing to its read-only root filesystem.
#   docker build --platform linux/arm64 -f infra/docker/oryxa-fde-api.Dockerfile <dir holding the four binaries>
# Debian 13 (glibc 2.41): the runners that build the binary link against glibc 2.39, newer than
# Debian 12 has. The workflow refuses a binary that needs more than 2.41.
# `oryxa-fde-api` serves (the entrypoint). The migrate task overrides the entrypoint with
# `/usr/local/bin/oryxa-fde-ops migrate`, the one-off operations binary from the same package, and the API's
# container health check runs `/usr/local/bin/oryxa-fde-ops healthcheck` (one GET to /healthz on loopback). The workers
# run `/usr/local/bin/oryxa-fde-ingest` (it also runs itself as `extract <content-type>` in a child, by its
# own path) and `/usr/local/bin/oryxa-fde-lifecycle`; they listen on nothing and have no health check.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:08476c244888bfb425bae1ae4dd7c17f093e972aab8426883d97f3c6f280f7c1
COPY --chmod=0555 oryxa-fde-api oryxa-fde-ops oryxa-fde-ingest oryxa-fde-lifecycle /usr/local/bin/
USER nonroot
ENTRYPOINT ["/usr/local/bin/oryxa-fde-api"]
