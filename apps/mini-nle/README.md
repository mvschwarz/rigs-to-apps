# Mini-NLE

A lightweight agent-paired video editor — storyboard + timeline cockpit,
distilled from hundreds of hours of real human+agent editing.

A video editor you share with an agent. You steer from the storyboard — scenes,
beats, takes — and the agent assembles, retimes, and renders. Click any word in
the script and the playhead cuts there. Lock what's finished; when every slot is
locked, the film is done.

This would've been a whole project to build. Here, it's a folder in a bundle.

## What this package contains

- `app/mini-nle.html` — the single-file editing surface (brass machined skin,
  vanilla HTML + JS, no build).

That is the whole package: one surface plus this manifest, README, and a
screenshot. **No server ships here** — see below.

`app/mini-nle.html` is a **generated build artifact** (stitched by
`stitch-nle.py` from the content-strategy chunks over `timeline-viewer.html`)
and is **never hand-edited**. This package pins a specific Studio Box source
commit and ships that generated artifact byte-identical; the source commit and
the generated-artifact hash live in the review evidence, never in a manifest
field.

## Runtime provider (Option C — canonical source vs shared provider)

This package **is the canonical reviewed source** of the Mini-NLE surface. The
**runtime is the box's shared `export-server`** — the same timeline and media
services the Cutdown and Media Manager surfaces use. It serves this surface and
answers its API verbs (`/api/patch`, `/api/project-assets`, `/api/timelines`,
`/api/project-info`, `/api/media`, …). This package therefore **declares no
server of its own and never ships or copies `export-server`**: the box already
provides it. The install destination `~/studio/apps/mini-nle` is the **installed
canonical source on disk**, not the path the shared server reads the project
bundle from at runtime.

## Install = drift-aware instructions for the box lead agent

The box's served surface and this registry snapshot can diverge because box
deploys move continuously. Install is a judgment call for the box lead agent,
under a **no-rollback drift rule**:

1. **Compare** the canonical installed source (`~/studio/apps/mini-nle`) against
   the box's served surface.
2. **Missing / provably broken / provably older** than the canonical source →
   **repair**: copy the canonical source in, then verify the shared route and
   API answer.
3. **Newer (forward drift)** → **leave it untouched and report**. The box surface
   may legitimately be ahead of this snapshot; never overwrite it.
4. **Ambiguous** relative age or health → **leave it untouched and report** to
   the box lead agent, and take no destructive action.

The rule is asymmetric on purpose: only ever move the box **forward** to the
canonical source when it is behind or broken — never roll a live box **backward**
to an older snapshot.

## Verbs (served by the shared provider)

Read: `GET /api/patch`, `GET /api/note`, `GET /api/receivers`,
`GET /api/templates`, `GET /api/slot-history`, `GET /api/health`,
`GET /api/project-assets`, `GET /api/timelines`, `GET /api/project-info`,
`GET /api/media`, `GET /api/history-since`, `GET /api/probe-duration`,
`GET /api/thumb`, `GET /api/library`, `GET /api/library/media`, `GET /api/tags`,
`GET /api/export-status/<id>`, `GET /api/validate-export`,
`GET /api/validate-audio`. Write: `POST /api/patch`, `POST /api/patch/validate`,
`POST /api/patch/apply`, `POST /api/patch/discard`, `POST /api/note`,
`POST /api/note/flush`, `POST /api/note/done`, `POST /api/approve`,
`POST /api/annotation`, `POST /api/reconform`, `POST /api/timeline/select`,
`POST /api/project-assets/rebuild`, `POST /api/reveal-file`,
`POST /api/library/route`, `POST /api/tags`, `POST /api/focus`,
`POST /api/export-review`, `POST /api/export-final`. These are answered by the
box's shared `export-server`, not by this package.
