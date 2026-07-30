# Runbook — kanban-factory (scratch)

The path of least resistance to the arc: a docker'd Kanban board + two seats that
drive the ticket lifecycle over JSON-RPC. Kanboard's own UI is the surface (no
bespoke HTML). Runtime is VM-only.

## Bring up the board

```
docker compose -f docker-compose.yaml up -d      # boots s07p2-kanboard on 127.0.0.1:8791 (health-gated)
```

## Token bootstrap (one-time, lower-code path — proven in the first act)

Read Kanboard's auto-generated application token straight from its SQLite settings
and write a **0600 env-file** — never print, log, or commit the value:

```
docker exec -i s07p2-kanboard php \
  -r 'echo (new PDO("sqlite:/var/www/app/data/db.sqlite"))
        ->query("SELECT value FROM settings WHERE option=\x27api_token\x27")->fetchColumn();' \
  > .kbtoken && chmod 600 .kbtoken
printf 'KB_TOKEN=%s\n' "$(cat .kbtoken)" > .kbenv && chmod 600 .kbenv   # .gitignored
```

(Rejected alternative: a UI login + CSRF scrape — more code, more brittle.)

## Drive the lifecycle

The seats drive the board only through `glue/kb.sh` (JSON-RPC, dynamic IDs). The
deterministic seam proof runs the same glue:

```
set -a; . ./.kbenv; set +a
bash proof/lifecycle-proof.sh            # GREEN: create -> move -> work step -> VISIBLE OPEN Done + negative
```

## LOOK (Kanboard's own UI)

Screenshot the board (authenticated) and confirm the card is **visibly in the open
Done column**. See `proof/README.md` for the captured evidence.

## Teardown (owned resources only)

```
docker compose -f docker-compose.yaml down -v    # removes s07p2-kanboard + its volume + network
```
