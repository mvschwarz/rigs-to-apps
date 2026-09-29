# Maintaining rig listings

For whoever merges listing pull requests and publishes rigs.to. Authors should read
[`SUBMITTING.md`](SUBMITTING.md) instead.

Ground rules that every step below keeps:

- **Authors' repositories are authoritative.** A listing points at one pinned commit of the author's public repo
  and never copies or rewrites their files.
- **Nothing from an author's repo is executed.** The importer fetches with git (hooks off, no submodules, no LFS,
  no prompts) and reads files. It never runs `rig bundle create`, `rig bundle install` or `rig up`.
- **No host or session provenance ever enters a snapshot**, and a final scan refuses to write one that names this
  host, home directory, session or the import cache.

## Register a submission

1. **From an issue:** write `bundles/<id>/rig.json` from the author's repo (`source.ref` = the full SHA of the
   commit you are listing). **From a pull request:** review the author's `rig.json`.
2. Preview: `node tools/preview-listing.mjs bundles/<id>/rig.json`
3. Import: `node tools/import-bundle.mjs bundles/<id>/rig.json --cache <dir>`. This writes
   `bundles/<id>/snapshot.json`.
4. Append `"bundles/<id>/rig.json"` to `registry.json` and check the whole registry:
   `REGISTRY_ROOT=. node tools/validate.mjs --registry registry.json`
5. Commit `rig.json`, `snapshot.json`, any screenshots and `registry.json` **together**.

The validator refuses a second listing of the same repo + spec under a new id (`lists the same source as …`). The
same rig at a newer commit is a refresh of the existing listing, never a second one.

## Author refresh (moving a listing to a newer commit)

This is a **catalog revision**, and nothing else. It does not upgrade rigs people already run (OpenRig 0.6.1
can't update a running rig in place, and the rig page says so).

1. Change `source.ref` in `bundles/<id>/rig.json` to the new full SHA (from the author's PR, or on their request).
2. Run the import.
   - **Success:** commit the descriptor and the new `snapshot.json` together; the page republishes at the new
     commit.
   - **Failure:** the importer prints `FAIL: <reason>` and leaves the previous `snapshot.json` byte-for-byte
     intact. Don't merge the ref change; send the reason to the author. If a descriptor ever lands ahead of its
     snapshot, the site still renders the last good snapshot, at the commit **that snapshot** pins. A page never
     shows a commit that wasn't successfully imported.
3. A new commit **loses the launch-tested stamp** until it is launched again (below).

## The launch-tested stamp (`verified.json`)

A listing reads **"launch tested on OpenRig <version>"** only after someone actually launches that exact commit
with the published steps, on a clean instance, and the members answer. Record it in `verified.json` at the registry
root, then re-import that listing:

```json
[{ "id": "pm-team", "ref": "<full sha that was launched>", "openrig": "0.6.1",
   "runtimes": { "codex": "0.159.0", "claude-code": "not recorded" } }]
```

Record runtime versions you observed; write `"not recorded"` rather than guessing. Authors can't set this, and
the preview never shows it.

## Parser version

The importer reads `rig.yaml` and every AgentSpec with **OpenRig's own parsers**, imported from the
`@openrig/cli` package **pinned in `tools/package.json`**. Install it with `npm ci --prefix tools` (Node >= 22;
`tools/.npmrc` disables install scripts, so nothing in the dependency tree runs). The parser version is a fact of
this repository, never of the host: authors and maintainers on any OpenRig version (or none) import identically.

The modules are package internals (`daemon/dist/domain/`). OpenRig publishes no parsed-spec output yet, so the
importer refuses to run unless the installed package is exactly `PARSER_CLI_VERSION` and still exports what it
reads. To move the pin:
1. Change `tools/package.json` and `PARSER_CLI_VERSION` together (a test asserts they agree).
2. Run `npm install --prefix tools` and commit the lockfile.
3. Re-import **every** listing.
4. Review the snapshot diffs before committing: expect only the `parsed_by.openrig` stamp to change unless the
   parser's output did.

## Pins that are committed but not yet pushed

If a listing pins a commit that exists locally but isn't on GitHub yet (for example a first-party example fixed in
the same release), import it from a local clone:

`node tools/import-bundle.mjs bundles/<id>/rig.json --cache <dir> --mirror <local clone>`

The commit ID is content-addressed, so the snapshot is identical to a GitHub fetch and records only the public URL.
**Push that commit before the site that links to it is deployed.**

## Corrections and withdrawal

- **Credit or licence corrections:** apply them on the word of the repository owner (a PR or an issue from that
  account).
- **Withdrawal:** remove `bundles/<id>/` and its line in `registry.json`, then republish the site. Honor an
  author's request without debate. A listed repo that turns private or disappears can't be refreshed, so withdraw
  it.

## Publishing order

1. Push the registry first, with every pinned commit it references already on GitHub.
2. Compile the site against that exact registry commit (`REGISTRY_SHA` is stamped on every page and used in the
   listing links), review the output, and deploy exactly that output.
3. If the registry commit changes afterwards (a rebase or squash), recompile before deploying.
