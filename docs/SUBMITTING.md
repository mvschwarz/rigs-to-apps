# List your rig on rigs.to

rigs.to shows OpenRig configurations — rigs — so other people can read one before they run it. You keep your
rig in **your own public GitHub repository**. rigs.to only points at it, pinned to one exact commit, and
generates the page from your real `rig.yaml`. You don't write a web page and you don't hand over your repo.

There are two ways in:

- **The quick way — open an issue with just your repository's URL.** A maintainer writes the listing for you.
  Use the *"List my rig"* issue template.
- **The direct way — a small pull request** adding one file, `bundles/<id>/rig.json`. The rest of this guide
  describes that file.

No account is needed on rigs.to; submissions are GitHub issues and pull requests.

## 1. What your repository needs

- It is **public** on GitHub.
- It contains a pod-aware **`rig.yaml`** (RigSpec) that OpenRig accepts. Check it with:
  `rig spec validate path/to/rig.yaml`
- Every member's `agent_ref` is a `local:` path **inside the same repository**, and every agent directory has
  its `agent.yaml`. rigs.to lists exactly those files, so readers see what they would run.
- A licence you state honestly (an SPDX identifier such as `MIT` or `Apache-2.0`).
- No secrets, private paths or personal state in the spec or agent files. Everything they reference is shown on
  the page, byte for byte.

## 2. The listing file — `bundles/<id>/rig.json`

A small presentation file. It never repeats what is in your `rig.yaml`: roles, members, handoffs, runtimes and
files are read from the spec itself.

```json
{
  "descriptor_version": 1,
  "kind": "rig-bundle",
  "id": "pm-team",
  "title": "PM team",
  "summary": "A product-management rig: a PM lead runs the feature flow, with a researcher and a coder.",
  "tags": ["product", "research"],
  "author": { "name": "Your Name", "url": "https://github.com/your-name" },
  "license": "Apache-2.0",
  "source": {
    "repo": "https://github.com/your-name/your-repo",
    "ref": "d83bbebe97430c3f2777226fecc089d31e276aa8",
    "spec": "path/to/rig.yaml"
  },
  "media": { "screenshots": [] }
}
```

| Field | Rules |
|---|---|
| `id` | lowercase-kebab; **the directory name must match** (`bundles/pm-team/rig.json`). |
| `title` / `summary` | up to 80 / 240 characters. |
| `tags` | up to 8, lowercase-kebab. |
| `author` | the credit on the page. `url` must be `https://`. |
| `source.ref` | a **full 40-character commit SHA** — never a branch or tag, because those move. The page shows exactly this commit. |
| `source.spec` | the path to `rig.yaml` inside your repo. |
| `source.bundle` | optional: a prebuilt `.rigbundle` in the same repo at the same commit. |
| `media.screenshots` | optional images (`png`, `jpg`, `webp`, `gif`, up to 2 MB each, up to 6) placed next to `rig.json`, each with `alt` text. With none, the page says so and uses the generated role diagram. |

The full field reference is [`SCHEMA.md`](../SCHEMA.md); `tools/validate.mjs` is the authority.

## 3. Preview it before you submit

You need **Node >= 22** and **git**. The preview tool brings its own OpenRig parser (pinned in
`tools/package.json`), so **no OpenRig install is needed to preview**, and the version you run makes no
difference. From a checkout of this registry:

```bash
npm ci --prefix tools        # once: installs the pinned parser; runs no install scripts
node tools/preview-listing.mjs bundles/<id>/rig.json
```

It runs the **same** checks and import that registration runs, against a throwaway copy, and prints what the page
will show: roles and handoffs, members' runtimes and pinned models, the files listed, requirements, and the notes
readers see before launching. Nothing in your checkout changes. If registration would refuse your listing, the
preview refuses it with the same message.

A preview always says **"parsed, not launch-tested"**. The *launch tested* stamp is added by maintainers only
after they actually launch that exact commit.

## 4. Submit

**Pull request:** add `bundles/<id>/rig.json` (and any screenshots) and append `"bundles/<id>/rig.json"` to
`registry.json`. A maintainer runs the import, which adds `bundles/<id>/snapshot.json` — you don't write that file.

**Issue:** use *"List my rig"* and paste your repository URL (plus the path to `rig.yaml` if it isn't obvious).

## 5. What readers will see

- your title, summary, tags and credit, with a link to your repository **at the pinned commit**;
- a role diagram and a member table (runtime, pinned model, launch posture), read from your spec by OpenRig's
  own parser;
- the files your rig is made of, each linked at the pinned commit;
- what they need (OpenRig version, runtime CLIs, plugins) and honest notes — for example that pinned models
  need a runtime that supports them, or that Codex members need a tested two-file project setup to coordinate;
- the launch steps: clone, check out your pinned commit, and `rig up` into their own project directory.

rigs.to never runs your repository's code while building the page.

## 6. Refresh your listing (author refresh)

When you change your rig, **move the pin**: open a pull request that changes `source.ref` in your `rig.json` to
the new commit (preview it first). A maintainer re-imports it and the page republishes at the new commit.

If the new commit can't be imported — it fails validation, the repo is unreachable, OpenRig rejects the spec —
**the previous page stays up exactly as it was**, still showing the old commit, and the pull request tells you
why.

> This is a *catalog refresh* — the listing moves to a newer commit. It is **not** a way to upgrade a rig that
> someone is already running: OpenRig 0.6.1 can't update a running rig to a newer source commit in place, and
> each rig page says so.

## 7. Corrections and withdrawal

- **Credit or licence wrong?** Open a pull request fixing `author` or `license`, or an issue from the account
  that owns the repository. Corrections to credit are applied on the repository owner's word.
- **Withdraw a listing** by opening a pull request that removes `bundles/<id>/` and its line in
  `registry.json`, or an issue asking for removal. Your repository stays yours; removing the listing only removes
  the page.
- If a listed repository goes private or disappears, refreshes stop working and maintainers withdraw the
  listing.

## When something is refused

Every refusal names what to change. The common ones:

| Message | Fix |
|---|---|
| `source.ref must be a full 40-character commit SHA` | use `git rev-parse HEAD`, not a branch name |
| `id must equal the bundle directory name` | rename the directory or the `id` so they match |
| `unknown field 'pods'` (or `members`, `agents`, …) | remove it — those come from your `rig.yaml` |
| `OpenRig's RigSpecSchema rejected the spec: …` | fix your `rig.yaml`; `rig spec validate` shows the same errors |
| `path escapes source repo` | keep `spec` and every `local:` agent_ref inside the repository |
| `lists the same source as '<id>'` | that rig is already listed — refresh the existing listing instead |
| `fetch failed … at <sha>` | the repo must be public and the commit must be pushed |
