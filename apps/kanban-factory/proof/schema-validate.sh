#!/usr/bin/env bash
# Load-bearing PACKAGE-SCHEMA proof. Runs the CANONICAL shipped validators against
# this package root and requires all four green. It INVOKES the validators (rig) —
# it never duplicates validator logic — so a future schema drift cannot false-green.
#   rig spec validate rig.yaml
#   rig agent validate agents/orchestrator/agent.yaml
#   rig agent validate agents/board-driver/agent.yaml
#   rig spec preflight rig.yaml --rig-root .
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
rc=0
check(){ # LABEL -- CMD...
  local label="$1"; shift
  echo "=== $label ==="
  local out; out="$("$@" 2>&1)"; echo "$out"
  echo "$out" | python3 -c 'import sys,json
d=json.load(sys.stdin); ok=d.get("valid", d.get("ready"))
sys.exit(0 if ok is True else 1)' || { echo "  <<< NOT VALID"; rc=1; }
  echo
}
check "rig spec validate rig.yaml"                       rig spec validate rig.yaml --json
check "rig agent validate agents/orchestrator/agent.yaml" rig agent validate agents/orchestrator/agent.yaml --json
check "rig agent validate agents/board-driver/agent.yaml"  rig agent validate agents/board-driver/agent.yaml --json
check "rig spec preflight rig.yaml --rig-root ."          rig spec preflight rig.yaml --rig-root . --json
if [ "$rc" = 0 ]; then echo "SCHEMA GREEN (4/4 canonical commands valid)"; else echo "SCHEMA RED"; fi
exit $rc
