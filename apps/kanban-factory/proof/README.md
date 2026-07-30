# Proof — kanban-factory

Two layers of proof: (1) a **deterministic seam harness** (`lifecycle-proof.sh`) that the
**shipped glue** drives the real Kanboard board through the full lifecycle, and (2) a
**genuine agent-driven run** where the driving session (`dev-planner@openrig-build`) itself
issues the JSON-RPC lifecycle live — closing the earlier honest deferral. The seam harness
was first run 2026-07-29 in a disposable Linux Docker sandbox; the genuine agent-driven run
was executed 2026-07-29 **LOCAL on the mm2 host** under an explicit operator-sanctioned,
founder-directed **bounded exception** to the VM-only convention (Studio Box app runtime, not
OpenRig-core) — single loopback container, digest-pinned, owned names, reversible teardown.

- Image: `kanboard/kanboard@sha256:e9dc25fa37246a89a9b353b5657222961bd221afa463c32112307bc0385cca29`
  (v1.2.53), bound `127.0.0.1:8791` loopback-only; owned names `s07p2-kanboard` / `-data` / `-net`.

## What IS proven (the JSON-RPC seam)

- **RED** (board down, before boot): `board unreachable / auth failed` — `evidence-red.txt`.
- **GREEN x2** (`evidence-green1.txt`, `evidence-green2.txt`), each independent run: reachable+auth;
  columns resolved **dynamically**; `createTask`; `moveTaskPosition` through the columns into Done;
  one bounded work step recorded **on the ticket** (a comment); **VISIBLE OPEN in Done**
  (`column_id == Done` AND `is_active == 1`); **NEGATIVE** (bogus column rejected, card stays in Done).
  Runs used fresh projects (2 then 3) — not a one-shot fluke.
- **Token hygiene:** the API token is in NO tracked file — only the 0600 `.kbenv` / `.kbtoken`
  (`.gitignore`d, never committed). The only long hex in the package is the Kanboard image **digest**
  in `docker-compose.yaml`.
- **LOOK** (Kanboard's own UI, authenticated — no bespoke HTML): `evidence/board-done.png`,
  sha256 `76cd96196a4544a60f54324edbdc4997823cceeb7bbab8520b7306fd8af286ee`, 1500x950. Card #1
  "ship the demo cutdown" is **visibly in the open Done column** (Done header "1 (1)"), shows a
  comment icon (the recorded work step), and the filter reads `status:open` (the card is OPEN, not
  greyed/hidden). API and rendered UI **agree** (column_id = Done, is_active = 1). Personally inspected.

## What IS now proven — the genuine agent-driven run (deferral CLOSED)

The Phase-2 proof-contract item — one full ticket lifecycle **"picked up BY AN AGENT"** — is now
**PROVEN**. Under the founder's local build-mode ruling, the driving session
`dev-planner@openrig-build` itself drove the real JSON-RPC lifecycle live (that IS the genuine
agent-run; no author-run shell substituted). Two unique runs, dynamically-resolved IDs, at-most-once
(`run1-lifecycle.txt`, `run2-lifecycle.txt`):

- **PICKUP FIRST** — before any move, an explicit server-side comment **naming the driving session**
  is recorded on the ticket and the pre-move state captured (`column_id=first is_active=1`), so pickup
  is proven directly, never inferred from later column movement.
- move across dynamically-resolved named columns into Done.
- one bounded work step recorded on the ticket.
- **WORK COMPLETE** — visible OPEN Done (`column_id=Done is_active=1`), captured distinctly.
- **TERMINAL CLOSURE** — `closeTask` AFTER Done (`column_id=Done is_active=0`), captured distinctly.
  A greyed closed card alone is never equated with "work done"; the two states are recorded separately.

Visual acceptance is the **founder's live authenticated browser** on the running board
(`http://127.0.0.1:8791`), by founder ruling. A durable authenticated card-media screenshot of a
populated demo board (public-safe tickets across the columns, one visibly open in Done) is captured in
`evidence/`. The public read-only board route is disabled in this image config (HTTP 403), so no
public-board pixel shot is claimed; the API `getTask` states + the run transcripts are the ground-truth
receipts, and `evidence/board-done.png` (from the seam-harness run) remains a representative capture.

## Package-schema proof (canonical validators)

`proof/schema-validate.sh` runs the **canonical shipped validators** against the package root and requires
all four green (it invokes `rig`, never duplicates validator logic), so a schema drift cannot false-green:

```
bash proof/schema-validate.sh
#   rig spec validate rig.yaml
#   rig agent validate agents/orchestrator/agent.yaml
#   rig agent validate agents/board-driver/agent.yaml
#   rig spec preflight rig.yaml --rig-root .
```

RED before the repair (edge `hands_off_to`, agentspec `hooks`) is captured in `evidence-schema-red.txt`;
GREEN after the migration (`delegates_to`, `plugins: []`) in `evidence-schema-green1.txt` / `-green2.txt`.

