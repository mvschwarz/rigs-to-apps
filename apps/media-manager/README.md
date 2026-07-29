# Media Manager

Tag, curate, and route your studio's media — an agent-run asset library.

Every clip, photo, and render in one place. Media lands, the agent files and tags
it; you search, preview, and route assets to whatever app needs them next. Lock the
keepers. Keep every version. Never lose the good take again.

## What this package contains

- `app/media-manager.html` — the single-file review surface (LinkPix-dark, vanilla
  HTML + JS, no build).

That is the whole package: one surface plus this manifest, README, and a
screenshot. **No server ships here** — see below.

## Runtime provider (Option C — canonical source vs shared provider)

This package **is the canonical reviewed source** of the Media Manager surface.
The **runtime is the box's shared `export-server`** — the same media services the
NLE and Cutdown surfaces use. It serves this surface and answers its API verbs
(`/api/project-assets`, `/api/tags`, `/api/curation`, `/api/library`,
`/api/media`, …). This package therefore **declares no server of its own and never
ships or copies `export-server`**: the box already provides it. The install
destination `~/studio/apps/media-manager` is the **installed canonical source on
disk**, not the path the shared server reads assets from at runtime.

## Install = drift-aware instructions for the box lead agent

The box's served surface and this registry snapshot can diverge because box deploys
move continuously. Install is a judgment call for the box lead agent, under a
**no-rollback drift rule**:

1. **Compare** the canonical installed source (`~/studio/apps/media-manager`)
   against the box's served surface.
2. **Missing / provably broken / provably older** than the canonical source →
   **repair**: copy the canonical source in, then verify the shared route and API
   answer.
3. **Newer (forward drift)** → **leave it untouched and report**. The box surface
   may legitimately be ahead of this snapshot; never overwrite it.
4. **Ambiguous** relative age or health → **leave it untouched and report** to the
   box lead agent, and take no destructive action.

The rule is asymmetric on purpose: only ever move the box **forward** to the
canonical source when it is behind or broken — never roll a live box **backward**
to an older snapshot.

## Verbs (served by the shared provider)

Read: `GET /api/project-assets`, `GET /api/curation`, `GET /api/tags`,
`GET /api/library`, `GET /api/library/media`, `GET /api/media`, `GET /api/exports`,
`GET /api/patch`. Write: `POST /api/tags`, `POST /api/selections`,
`POST /api/focus`, `POST /api/library/route`. These are answered by the box's
shared `export-server`, not by this package.
