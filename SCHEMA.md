# app.json schema (v1)

`tools/validate.mjs` **is** the authority — this document describes it; there is
no separate JSON-Schema file to drift. Unknown keys fail at **every** object
level. Node standard library only.

## Fields

| Field | Shape | Required | Notes |
|---|---|---|---|
| `manifest_version` | integer | yes | known value only (v1 = `1`); unknown ⇒ fail. |
| `id` | string | yes | lowercase-kebab; **equals the name of the directory containing `app.json`**; unique. |
| `name` | string | yes | display title. |
| `summary` | string | yes | one-line pitch (store card). |
| `category` | enum | yes | closed: `create` \| `build` \| `grow` \| `system` (lowercase). Doubles as the sidebar default group. |
| `maker` | `{ name, url }` | yes | both required (credit is first-class). |
| `media` | `{ screenshots, demo? }` | yes | the object is required. |
| `media.screenshots[]` | `[{ src, alt }]` | yes (may be `[]`) | each present item requires `src` + `alt`. |
| `media.demo` | string | optional | relative path OR `https://` URL only (reject `http://`, `javascript:`, `data:`). |
| `install.destination` | string | yes | must equal `~/studio/apps/<id>` exactly. |
| `install.surface.entry` | string | yes | single-file HTML door — relative `.html`, inside app dir, must exist. |
| `install.surface.path` | string | yes | absolute URL route: leading `/`, reject `..`, `?`, `#`. |
| `install.surface.glyph` | string | yes | sidebar icon/emoji. |
| `install.surface.hint` | string | optional | tooltip; default = `summary`. |
| `install.server` | `{ command, port{env,preferred} }` | optional | omit for a pure static surface. |
| `install.server.command` | string | (if server) | instruction string — NOT path-resolved. |
| `install.server.port` | `{ env, preferred }` | (if server) | env var name + preferred integer. |
| `install.verify[]` | `[string]` | yes | non-empty; ordered post-install checks the ops agent runs. |
| `verbs[]` | `[{ method, path, purpose }]` | yes | `method` ∈ `GET` \| `POST`. |

**Fixed README convention:** each app dir carries a `README.md` at that fixed
name — never named in the manifest (no `readme` field). The validator asserts
the app dir has a `README.md`.

**Forbidden keys** (fail on presence — they are simply "unknown"): `source`,
`version`, `pricing`, `deps`/`dependencies`, `review`, `fork`/`forked_from`,
`stats`/`installs`/`forks`/`stars`, `readme`. The registry location supplies the
source; the ops agent records the commit SHA at install.

## Field-scoped path safety

Path-like fields do **not** share one rule:

- **Relative file, inside the app dir, exists, and is a REGULAR FILE** —
  `media.screenshots[].src`, relative `media.demo`, `install.surface.entry`.
  Rejects `..`/absolute (lexical) first, then an absent path, then a **realpath
  escape** — an in-tree symlink resolving outside the app dir is rejected *after*
  `fs.realpath`, so the `startsWith(HERE)` containment idiom cannot be bypassed
  by a symlink — and finally a non-file (a directory named `entry.html` fails
  `not a regular file`).
- `install.surface.path` — absolute URL route (leading `/`, no `..`/`?`/`#`); not file-resolved.
- `install.destination` — must equal `~/studio/apps/<id>`; not file-resolved.
- `install.server.command` — an instruction string; not path-resolved.

## Check order

`parse → prototype-pollution guard → object shape → id (== dir name) →
unknown-field scan (every level) → required fields/types → field-scoped
value+path rules → README.md presence`. The order lets an id-matching fixture
isolate exactly one intended defect.

## Registry (`registry.json`)

A bare JSON array of manifest paths, each REGISTRY_ROOT-relative. Non-string /
object entries fail (`registry must be a bare list of manifest paths`); absolute
paths or any `..` segment fail (`registry path escapes root`). Every referenced
manifest is validated, and **app ids must be unique across the list** — two
entries resolving to the same id (same path, or distinct paths whose leaf dir is
the same) fail `duplicate app id '<id>'`. `REGISTRY_ROOT` is env-overridable
(default: cwd). Empty (`[]`) validates as `OK registry (0 manifests)`.
