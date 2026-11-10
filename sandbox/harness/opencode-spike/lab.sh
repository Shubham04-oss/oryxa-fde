#!/usr/bin/env bash
# The spike's lab: an isolated Docker network with no route out, whose only peers are an egress sink (DNS plus a
# logger for ports 80 and 443) and a stub model server. OpenCode runs in `fde-123-oc` with no credentials, no
# capabilities and a single scratch mount. A sidecar sharing its network namespace records every packet it sends
# and lists its listening sockets. Everything is named fde-123-* and `lab.sh down` removes it all.
#   LAB_DIR=/path/to/scratch ./lab.sh up | down | oc <cmd...> | sh <script-file-in-/spike>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
LAB_DIR="${LAB_DIR:?set LAB_DIR to a scratch directory}"
IMAGE="${IMAGE:-fde-123-opencode}"
NET=fde-123-net
SINK_IP=10.123.0.2
MODEL_IP=10.123.0.3
OC_IP=10.123.0.10
MARKER=.fde-123-lab

# Containers get their scripts by `docker cp`, not by a mount.
start_node() { # name ip script
  docker create --name "$1" --network "$NET" --ip "$2" --sysctl net.ipv4.ip_unprivileged_port_start=0 \
    --cap-drop ALL --security-opt no-new-privileges -v "$LAB_DIR:/scratch" "$IMAGE" node "/spike/$3" >/dev/null
  docker cp "$here/." "$1:/spike"
  docker start "$1" >/dev/null
}

case "${1:-}" in
  up)
    # LAB_DIR is mounted into the containers and later cleaned by root: only ever use a directory this script made.
    mkdir -p "$LAB_DIR"
    if [ ! -f "$LAB_DIR/$MARKER" ] && [ -n "$(ls -A "$LAB_DIR")" ]; then
      echo "lab.sh: $LAB_DIR is not empty and has no $MARKER marker; use an empty directory" >&2
      exit 1
    fi
    touch "$LAB_DIR/$MARKER"
    mkdir -p "$LAB_DIR/logs" "$LAB_DIR/cases" && chmod 777 "$LAB_DIR" "$LAB_DIR/logs" "$LAB_DIR/cases"
    docker network create --internal --subnet 10.123.0.0/24 "$NET" >/dev/null
    start_node fde-123-sink "$SINK_IP" sink.mjs
    start_node fde-123-model "$MODEL_IP" model-stub.mjs
    docker create --name fde-123-oc --network "$NET" --ip "$OC_IP" --dns "$SINK_IP" --dns-search . --cap-drop ALL \
      --security-opt no-new-privileges --pids-limit 512 --memory 2g -v "$LAB_DIR:/scratch" \
      -e HOME=/home/agent "$IMAGE" sleep infinity >/dev/null
    docker cp "$here/." fde-123-oc:/spike
    docker start fde-123-oc >/dev/null
    # Execute-only: the agent can run the binary but not read it, so the process is not dumpable and a same-user
    # process cannot open its /proc/<pid>/fd or environ (see OPENCODE.md, forged answers).
    docker exec -u root fde-123-oc chmod 0711 /usr/local/bin/opencode
    # Sidecar in the same network namespace: sends unroutable traffic to the sink so tcpdump sees the attempt.
    docker run -d --name fde-123-watch --network container:fde-123-oc --user root --cap-drop ALL \
      --cap-add NET_ADMIN --cap-add NET_RAW -v "$LAB_DIR:/scratch" "$IMAGE" sh -c \
      "ip route replace default via $SINK_IP && exec tcpdump -Z root -i eth0 -nn -l -tt 'not arp and not port 53' > /scratch/logs/packets.txt 2>&1" >/dev/null
    ;;
  down)
    docker rm -f fde-123-dl fde-123-watch fde-123-oc fde-123-model fde-123-sink 2>/dev/null || true
    docker network rm "$NET" 2>/dev/null || true
    # Files the containers wrote belong to their users; clear them the same way. Only a directory `up` made (it holds the
    # marker) is ever cleaned, on the host side and again inside the container, and the marker itself stays.
    if [ "${KEEP_LOGS:-0}" != 1 ]; then
      if [ -f "$LAB_DIR/$MARKER" ]; then
        docker run --rm --user root --network none -v "$LAB_DIR:/scratch" "$IMAGE" sh -c \
          "[ -f /scratch/$MARKER ] && find /scratch -mindepth 1 -maxdepth 1 ! -name $MARKER -exec rm -rf {} +" 2>/dev/null || true
      else
        echo "lab.sh: not cleaning $LAB_DIR: no $MARKER marker" >&2
      fi
    fi
    ;;
  oc) shift; docker exec -i fde-123-oc "$@" ;;
  reload) # copy the scripts again and restart the stub
    for c in fde-123-oc fde-123-model fde-123-sink; do docker cp "$here/." "$c:/spike"; done
    docker restart fde-123-model >/dev/null ;;
  clearlogs) docker exec fde-123-oc sh -c ': > /scratch/logs/model.jsonl; : > /scratch/logs/sink.jsonl'
    docker exec fde-123-watch sh -c ': > /scratch/logs/packets.txt' ;;
  perms) docker exec -u root fde-123-oc chmod "$2" /usr/local/bin/opencode ;; # perms 0755|0711
  sockets) docker exec fde-123-watch sh -c 'ss -tulnpH; echo ---; ss -tnpH' ;;
  *) echo "usage: lab.sh up|down|oc|sockets" >&2; exit 2 ;;
esac
