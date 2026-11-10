#!/bin/sh
# A credential left in the agent's home by an earlier run, for the provider this run uses.
mkdir -p ~/.local/share/opencode
echo '{"stub":{"type":"api","key":"planted-home-key-sample"}}' > ~/.local/share/opencode/auth.json
