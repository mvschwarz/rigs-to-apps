# Cutdown

Turn hours of footage into the best minutes — agent-cut.

Point Cutdown at a pile of raw footage — a vacation, a birthday, a wedding, a
night out, a game, an event, a shoot — and review it fast. You watch the
proxies in the browser, **punch in / punch out** the moments worth keeping, and
your studio rig cuts them for you. Each cut lives on disk with its versions
side by side (original plus smoothing levels), and you **lock** the one the
video should use. The original footage is never touched; deletes are archived
and restorable.

Wedding footage is the case that proved the pattern, but Cutdown is
general-purpose: any long footage where the best two minutes are buried in
hours.

## What this package contains

- `app/cutdown.html` — the single-file review surface (LinkPix-dark).
- `app/cutdown-server.mjs` — the surface's backend: serves proxies with range
  support, lists clips/cuts, and persists attributed markers (JSONL,
  durable-first). It reads its footage/bundle roots from `--footage` / `--bundle`
  arguments.

## Studio Box prerequisite (not shipped here)

Cutdown reviews footage and records punches; **the actual cutting and smoothing
happen in an external toolchain that the Studio Box provides** — the
marker-watcher, the deterministic cut lane, and the ffmpeg-based smoothing. This
package does **not** ship that worker: a cut is written by the box's cutting
lane once a marker lands, not by this surface. Install Cutdown on a Studio Box
that runs that lane.

## Verbs (surface backend)

Read: `GET /api/clips`, `GET /api/markers`, `GET /api/cuts`. Write:
`POST /api/markers` (punch / delete), `POST /api/stabilize` (queue a smoothing
level), `POST /api/pick` (lock a version), `POST /api/cut-note`,
`POST /api/cut-retry`, `POST /api/cut-delete`. Static media is served under
`/media/`, `/cutprev/`, `/cuts/`, and `/master/`.
