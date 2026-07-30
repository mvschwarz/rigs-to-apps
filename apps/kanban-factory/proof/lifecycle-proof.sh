#!/usr/bin/env bash
# DETERMINISTIC lifecycle proof of the SHIPPED glue against the running board.
# NOT an agent run — this is a deterministic harness that proves the JSON-RPC
# SEAM (the package's glue drives the real board). A genuine agent-seat-attributed
# run is DEFERRED to a rig-capable environment (see proof/README.md).
# RED if the board is unreachable; GREEN when a ticket is created, moved through
# the columns, records a work step, lands in VISIBLE OPEN Done (WORK COMPLETE,
# is_active=1), survives a negative, and is then closeTask'd into TERMINAL CLOSURE
# (is_active=0, still IN the Done column) — the two states asserted DISTINCTLY.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
KB="$HERE/glue/kb.sh"
PROJECT="${1:-lifecycle-proof}"
fail(){ echo "FAIL: $*"; exit 1; }

PID="$("$KB" ensure-project "$PROJECT" 2>/dev/null)" || fail "board unreachable / auth failed (RED)"
[[ "$PID" =~ ^[0-9]+$ ]] || fail "board unreachable / lifecycle not proved (RED): PID='$PID'"
echo "ok  reachable+auth, project=$PID"

FIRST="$("$KB" columns "$PID" | head -1 | awk '{print $1}')"
DONE="$("$KB" done-column "$PID")"
[[ -n "$FIRST" && -n "$DONE" ]] || fail "columns not resolved (first=$FIRST done=$DONE)"
echo "ok  columns resolved dynamically (first=$FIRST done=$DONE)"

TID="$("$KB" create "$PID" "ship the demo cutdown" "$FIRST")"
[[ "$TID" =~ ^[0-9]+$ ]] || fail "createTask (TID='$TID')"
echo "ok  createTask -> $TID"

for COL in $("$KB" columns "$PID" | awk -v f="$FIRST" -v d="$DONE" '$1>=f && $1<=d {print $1}' | tail -n +2); do
  [[ "$("$KB" move "$PID" "$TID" "$COL")" == "True" ]] || fail "move -> $COL"
done
echo "ok  moved through columns into Done ($DONE)"

CID="$("$KB" comment "$TID" "cut the 90s highlight reel; assembly attached")"
[[ "$CID" =~ ^[0-9]+$ ]] || fail "comment (work step) CID='$CID'"
echo "ok  work step recorded on ticket (comment=$CID)"

read -r C A < <("$KB" task "$TID" | sed 's/column_id=//;s/is_active=//')
[[ "$C" == "$DONE" && "$A" == "1" ]] || fail "not visible-open-in-Done (column_id=$C is_active=$A want $DONE/1)"
echo "ok  VISIBLE OPEN in Done (column_id=$C is_active=$A)"

[[ "$("$KB" move "$PID" "$TID" 999999)" == "False" ]] || fail "negative: bogus move not rejected"
read -r C2 _ < <("$KB" task "$TID" | sed 's/column_id=//;s/is_active=//')
[[ "$C2" == "$DONE" ]] || fail "negative: card left Done after bogus move (col=$C2)"
echo "ok  NEGATIVE: bogus column rejected, card stays in Done"

# TERMINAL CLOSURE (fixed product ruling): closeTask AFTER the card is visibly in
# Done, and assert the closed state DISTINCTLY from work-complete — a greyed closed
# card alone is NOT "work done"; work-complete was the visible-OPEN-Done state above.
[[ "$("$KB" close "$TID")" == "True" ]] || fail "closeTask did not return True"
read -r C3 A3 < <("$KB" task "$TID" | sed 's/column_id=//;s/is_active=//')
[[ "$C3" == "$DONE" && "$A3" == "0" ]] || fail "not terminal-closed-in-Done (column_id=$C3 is_active=$A3 want $DONE/0)"
echo "ok  TERMINAL CLOSURE: closed, still in Done (column_id=$C3 is_active=$A3)"
echo "LIFECYCLE GREEN (project=$PID task=$TID) — work-complete (Done/open) + terminal-closure (Done/closed) both proved distinctly"
