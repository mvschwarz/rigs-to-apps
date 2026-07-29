# Files

Browse, read, edit, and preview every file in your home-scoped roots — and ask an
allowlisted agent seat to edit alongside you, live.

Files is your box's everything-editor: a roots + folder-tree rail on the left and a
single preview/edit pane on the right (LinkPix-dark, vanilla HTML + JS, no build). It
opens markdown, code, images, video, and HTML. You **read** and **edit** files across
your **home-scoped file roots** — writes are backed up on save and use mtime-based
conflict honesty, so an agent editing the same file never silently clobbers your work.
And from any file you can **ask an allowlisted agent seat** to make a change while you
watch it land — the ask-the-agent rail. It holds no state of its own: the files on disk
are the state.

## What this package contains

- `app/files.html` — the single-file review surface (LinkPix-dark, vanilla HTML + JS,
  no build).

That is the whole package: one surface plus this manifest, README, and a screenshot.
**No server ships here** — see below.

## Runtime provider (Option C — canonical source vs shared provider)

This package **is the canonical reviewed source** of the Files surface. The **runtime is
the box's shared `serve-shell.mjs` (:8789)** — the same shell server that serves the
box's other same-host surfaces. It serves this surface and answers its API verbs
(`/api/files/tree`, `/api/files/read`, `/api/files/raw`, `/api/files/write`,
`/api/files/roots`, `/api/demo/say`, …). This package therefore **declares no server of
its own and never ships or copies `serve-shell.mjs`, `files-roots.json`, `surfaces.json`,
or any shell module tree** — the box already provides them.

Three locations stay distinct, on purpose:

- **Runtime provider** — the box's shared `serve-shell` on `:8789`. It serves surfaces
  from its own `app/shell/` directory only; it does not serve from the install
  destination.
- **Installed canonical source** — `install.destination` `~/studio/apps/files`, the
  reviewed copy on disk used for drift comparison. It is **not** the path the shell
  serves from, so a per-app server pointed here would be a fake runtime path.
- **Data root** — the user's **home-scoped file roots** (`STUDIOBOX_FILES_ROOTS` /
  the `files-roots.json` overlay), guarded to live inside `$HOME` and never a keys or
  secrets directory. Files **reads and writes there**, **never** at `~/studio/apps/files`.

## Install = drift-aware instructions for the box lead agent

The box's served surface and this registry snapshot can diverge because box deploys move
continuously. Install is a judgment call for the box lead agent, under a **no-rollback
drift rule**:

1. **Compare** the canonical installed source (`~/studio/apps/files`) against the box's
   served surface.
2. **Missing / provably broken / provably older** than the canonical source →
   **repair**: copy the canonical source in, then verify the shared route and a read verb
   answer.
3. **Newer (forward drift)** → **leave it untouched and report**. The box surface may
   legitimately be ahead of this snapshot; never overwrite it.
4. **Ambiguous** relative age or health → **leave it untouched and report** to the box
   lead agent, and take no destructive action.

The rule is asymmetric on purpose: only ever move the box **forward** to the canonical
source when it is behind or broken — never roll a live box **backward** to an older
snapshot. Verification uses **read verbs only** — never a write or roots verb.

## Verbs (served by the shared provider)

Read: `GET /api/files/tree`, `GET /api/files/read`, `GET /api/files/raw`,
`GET /api/files/search`, `GET /api/files/goto`, `GET /api/files/tags`.
Write / act: `POST /api/files/goto`, `POST /api/files/write`, `POST /api/files/roots`,
`POST /api/demo/say` (ask an allowlisted agent seat — the ask-the-agent rail, roster-
guarded by the shell). These are answered by the box's shared `serve-shell`, not by this
package.

> **Follow-up (not part of this package):** the surface also references
> `POST /api/focus`, but the shared `serve-shell` does not implement that route (focus is
> a different provider's rail), so it degrades and is intentionally **not** declared as a
> verb here. Either the shell gains a `/api/focus` handler or the surface drops the call —
> a separate determination.
