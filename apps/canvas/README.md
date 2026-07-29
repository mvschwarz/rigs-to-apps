# Canvas

An infinite storyboard the agent draws on with you — arrange, sketch, think out loud.

**Requires a tldraw production license (get one from tldraw).** The Canvas surface
renders around the tldraw editor; the production license is yours to obtain from
tldraw — it is not bundled or shipped by this package.

Canvas is the Studio Box thinking surface: an infinite storyboard for media
cards, notes, ink, arrows, frames, and pages. Its LinkPix-dark shell surrounds
the tldraw editor. Canvas owns the shell outside `#editor`; the box's vendored
tldraw runtime owns everything rendered inside `#editor`.

## Runtime provider

This is an Option-C shared-provider package. The package installs the reviewed
canonical surface at `~/studio/apps/canvas/app/canvas.html`. It does not ship or
install an app-specific server, supporting module tree, or tldraw vendor tree.
The box's existing shared `export-server` is the runtime provider: it serves
`/canvas.html`, the optional `/canvas-license.json`, the static tldraw runtime,
and the Canvas API rails declared in `app.json`.

The install destination is canonical source, not a runtime workspace. Never use
`~/studio/apps/canvas` as `--slice-root`, `--media-root`, or `--canvas-root`.
Those roots belong to the box and must be selected independently by its shared
provider.

## Install and repair

Compare the canonical installed Canvas surface with the surface served by the
box's shared provider.

1. If the served surface is missing, provably broken, or provably older than
   the canonical package, repair only the Canvas surface and then re-run the
   shared-provider render and API checks.
2. If the served surface is newer, leave it untouched and report the forward
   drift to the box lead agent.
3. If relative age or health is ambiguous, leave it untouched, report the
   ambiguity to the box lead agent, and take no destructive action.

Repair never copies or replaces the shared export-server, its modules, or its
vendored tldraw runtime. It never creates a per-app Canvas server.

## Shared-provider API

The surface uses exactly these agent-facing method/path pairs:

- `GET /api/canvases`
- `POST /api/canvases`
- `GET /api/canvas`
- `POST /api/canvas/apply`
- `GET /api/project-assets`
- `GET /api/library`
- `GET /api/tags`
- `GET /api/media`
- `GET /api/library/media`
- `GET /api/thumb`
- `POST /api/selections`
- `POST /api/focus`

Query strings do not create additional verbs. The optional
`GET /canvas-license.json` and static `/vendor/` requests are provider runtime
prerequisites, not agent-facing app verbs.
