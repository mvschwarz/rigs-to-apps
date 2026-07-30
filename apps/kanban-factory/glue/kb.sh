#!/usr/bin/env bash
# Thin JSON-RPC glue for the Kanban board — "terminal-in/out as the API".
# NO browser/UI automation. Resolves project + column IDs DYNAMICALLY every run
# (never hardcoded). The token comes from KB_TOKEN, loaded from a 0600 env-file;
# it is NEVER printed, logged, or committed.
set -euo pipefail
: "${KB_URL:=http://127.0.0.1:8791/jsonrpc.php}"
: "${KB_USER:=jsonrpc}"
: "${KB_TOKEN:?KB_TOKEN must be provided from the 0600 env-file (never inline)}"

_rpc() { # _rpc METHOD PARAMS_JSON  -> raw JSON-RPC response on stdout
  local params="${2:-}"; [ -n "$params" ] || params='{}'
  curl -s -u "${KB_USER}:${KB_TOKEN}" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${params}}" "$KB_URL"
}
_pick() { python3 -c 'import sys,json;print(json.load(sys.stdin)["result"])'; }

case "${1:-}" in
  ensure-project) # NAME -> project_id (create, else look up existing)
    id="$(_rpc createProject "{\"name\":\"$2\"}" | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result");print(r if isinstance(r,int) else "")')"
    [ -n "$id" ] || id="$(_rpc getProjectByName "{\"name\":\"$2\"}" | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result") or {};print(r.get("id",""))')"
    echo "$id" ;;
  columns) # PID -> "<id> <title>" per line (dynamic resolution)
    _rpc getColumns "{\"project_id\":$2}" | python3 -c 'import sys,json;[print(c["id"],c["title"]) for c in json.load(sys.stdin)["result"]]' ;;
  done-column) # PID -> the Done column id, resolved dynamically
    "$0" columns "$2" | awk 'tolower($2)=="done"{print $1}' ;;
  create) # PID TITLE COL -> task_id
    _rpc createTask "{\"title\":\"$3\",\"project_id\":$2,\"column_id\":$4}" | _pick ;;
  move) # PID TID COL -> true|false (explicit moveTaskPosition into a column)
    _rpc moveTaskPosition "{\"project_id\":$2,\"task_id\":$3,\"column_id\":$4,\"position\":1,\"swimlane_id\":0}" | _pick ;;
  task) # TID -> "column_id=<n> is_active=<0|1>"
    _rpc getTask "{\"task_id\":$2}" | python3 -c 'import sys,json;t=json.load(sys.stdin)["result"];print("column_id="+str(t["column_id"]),"is_active="+str(t["is_active"]))' ;;
  comment) # TID TEXT -> comment_id (record one bounded work step ON the ticket)
    _rpc createComment "{\"task_id\":$2,\"user_id\":1,\"content\":\"$3\"}" | _pick ;;
  close) # TID -> true|false (terminal closeTask — run ONLY after the card is visibly in Done)
    _rpc closeTask "{\"task_id\":$2}" | _pick ;;
  *) echo "usage: kb.sh {ensure-project NAME | columns PID | done-column PID | create PID TITLE COL | move PID TID COL | task TID | comment TID TEXT | close TID}" >&2; exit 2 ;;
esac
