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

# rig.json schema (rig-bundle listings, descriptor v1)

A rig listing is a **small presentation descriptor** at `bundles/<id>/rig.json`. It never restates runtime
truth: pods, members, edges, agents and files are **derived at import** from the author's real `rig.yaml` by
OpenRig's own parsers, so any key naming them is unknown and fails. `tools/validate.mjs` is still the authority;
registry entries are dispatched by filename (`app.json` or `rig.json`), and ids are unique across both kinds.

| Field | Shape | Required | Notes |
|---|---|---|---|
| `descriptor_version` | integer | yes | known value only (`1`). |
| `kind` | string | yes | exactly `"rig-bundle"`. |
| `id` | string | yes | lowercase-kebab; equals the directory containing `rig.json`. |
| `title` | string | yes | at most 80 chars. |
| `summary` | string | yes | at most 240 chars. |
| `tags[]` | `[string]` | yes (may be `[]`) | lowercase-kebab, unique, at most 8. |
| `author` | `{ name, url }` | yes | `url` must be `https://`. Credit is first-class. |
| `license` | string | yes | an SPDX identifier, or `NOASSERTION`. |
| `source.repo` | string | yes | a public `https://github.com/<owner>/<repo>` URL, no `.git`. |
| `source.ref` | string | yes | a **full 40-character commit SHA**. Branches and tags move; a listing pins. |
| `source.spec` | string | yes | repo-relative path to the `rig.yaml` entrypoint (the primary route). No `..`, `.`, absolute or `\`. |
| `source.bundle` | string | optional | repo-relative path to a prebuilt `.rigbundle` at the same pin. Recorded, never opened. |
| `media.screenshots[]` | `[{ src, alt }]` | yes (may be `[]`) | png/jpg/webp/gif inside the listing dir, a regular file, at most 2 MB, at most 6. Same realpath containment as apps. |

A **listed** rig (in `registry.json`) must have a `snapshot.json` beside it, produced by `tools/import-bundle.mjs`.

## Import (`tools/import-bundle.mjs`)

`node tools/import-bundle.mjs bundles/<id>/rig.json --cache <dir>`

1. Validates the descriptor with `tools/validate.mjs`.
2. Fetches **exactly** `source.ref` with git: hooks disabled, no submodules, no LFS smudge, no prompts. Bounded
   (20 000 files / 200 MB).
3. Reads `source.spec` (at most 256 KB, realpath-contained) and parses it with **OpenRig's own**
   `RigSpecCodec` + `RigSpecSchema`; follows each member's `local:` agent_ref and every AgentSpec `imports`
   entry with OpenRig's AgentSpec parser. No hand parser, no fallback.
4. Lists (and hashes) the spec's directory, the culture file, docs, and every referenced agent directory.
   Bounded (2 000 files / 20 MB); a symlink escaping the repo fails.
5. Writes `snapshot.json` atomically: topology, agents, files, runtimes, plugins, honest risk labels and the
   install steps (marked `untested` until exercised).

**Nothing from the author's repo is executed, packed or launched** — no `rig bundle create`, `install` or `up`,
and so no host/session provenance is ever read or stamped. A final scan refuses to write a snapshot that names
this host, home directory, session or the import cache. Any failure prints `FAIL: <reason>` and leaves the
previous `snapshot.json` byte-for-byte intact. Two imports at one pin are byte-identical.

**Version coupling.** OpenRig exposes no public parsed-spec output, so the importer loads the parsers from the
active install's `daemon/dist/domain/` and fails loudly unless it is exactly `PARSER_CLI_VERSION`. Bumping it
is deliberate: re-import every listing and diff. A supported export (or a parsed spec on
`rig bundle inspect --json`) would retire this.

`node --test tools/import-bundle.test.mjs` covers valid import, determinism, invalid descriptors, unsafe paths
(`..`, absolute, symlink escape, oversized, escaping `agent_ref`), failed fetch and parser rejection (both
preserving the last good snapshot), the private-term refusal, and the optional bundle.
