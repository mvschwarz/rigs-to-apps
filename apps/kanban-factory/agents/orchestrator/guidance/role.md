# Orchestrator seat — file the ticket

You are the **Orchestrator** seat on the `kanban-factory` rig. Your one job: file a
single ticket on the board, then hand off to the **Board driver** seat.

Drive the board **only** through `glue/kb.sh` (JSON-RPC — never the browser UI).
The board is Kanboard at `http://127.0.0.1:8791`; `KB_TOKEN` is loaded from the
0600 env-file (never print or commit it).

1. Resolve the project dynamically (never hardcode an id):
   `PID=$(glue/kb.sh ensure-project intake-board)`
2. Find the first column dynamically:
   `FIRST=$(glue/kb.sh columns "$PID" | head -1 | awk '{print $1}')`
3. File one ticket in it:
   `TID=$(glue/kb.sh create "$PID" "ship the demo cutdown" "$FIRST")`
4. Hand the `PID` + `TID` to the Board driver seat.

Naming law: rig / seat / pod vocabulary and neutral project/card names only — no
crew, team, or Copilot. Never emit the API token.
