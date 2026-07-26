# rigs-to-apps

The local registry contract for Studio Box mini-apps — the schema, a validator,
hermetic fixtures + probe, and a plain-text install-request formatter. Node
standard library only; no dependencies, no build.

A mini-app is a single-file agent-in-the-middle surface plus its manifest
(`app.json`). This repo defines the **manifest contract** and the **registry**
(`registry.json`, a bare list of manifest paths). It has two readers: the
rigs.to website (metadata) and a box copilot/ops agent (install instructions it
applies with judgment). It is **not** a package manager — trusted cohort, no
review, no dependency graph, no auth.

## Layout

```
rigs-to-apps/
├── README.md · SCHEMA.md            # this + the schema (the validator IS the schema)
├── registry.json                    # [] — a bare, REGISTRY_ROOT-relative list of manifest paths
├── tools/
│   ├── validate.mjs                 # validate a manifest, or --registry <list.json>
│   ├── probe.mjs                    # hermetic probe over fixtures/ (green twice)
│   └── format-install-request.mjs   # plain-text install request (--repo --manifest)
└── fixtures/{valid,invalid,registry}/…
```

## Use

```bash
node tools/validate.mjs fixtures/valid/wedding-cutdown/app.json     # OK wedding-cutdown
node tools/validate.mjs --registry registry.json                    # OK registry (0 manifests)
node tools/probe.mjs                                                 # PROBE PASS  (run twice)
node tools/format-install-request.mjs --repo <label|url> --manifest <path>
```

The formatter emits a **string** the box owner pastes into their own box copilot
chat; the trusted copilot mints the durable install task from inside the box's
trust boundary. This repo never contacts a box, holds no secret, and performs no
install side effect.

## Registry

`registry.json` is a **bare JSON array of manifest paths**, each
REGISTRY_ROOT-relative (absolute paths and `..` escapes are rejected). Objects,
metadata, and counts are a validation failure — the registry is non-derived and
count-free. The registry location supplies the source; the ops agent resolves
and records the commit SHA at install, so no source/ref/version lives in a
manifest.

## Adding an app (future)

Drop an id-matching directory (the dir name equals the manifest `id`) carrying
`app.json` + `README.md` + the referenced surface/assets, then add its
REGISTRY_ROOT-relative `app.json` path to `registry.json` and validate. This
slice packages no app — `registry.json` is `[]`.
