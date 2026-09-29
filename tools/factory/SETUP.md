# Set up this factory

Give this file to your coding agent, or follow it yourself. Every step is a command you can read first. Nothing is
piped into a shell, and nothing here asks you to trust instructions fetched from anywhere else: the package's own
`FACTORY.json` and `launch.mjs` are the whole setup, and you can read both before running anything.

The launcher sends nothing anywhere; the agents it starts send task context (your request, project files they read,
their outputs) to the model providers you configure, under those providers' terms.

## You need

This factory is **added to the OpenRig you already use**: your daemon, your home, your other rigs and OpenRig's own
kernel stay exactly as they are. You need:

- **OpenRig** at the version in `FACTORY.json` (`openrig.min`) or newer, installed and running as you normally use it
  (`rig daemon status`). No OpenRig yet? Install it first with OpenRig's own guide at https://openrig.dev.
- **Node.js 22** or newer.
- The **runtime CLIs** the factory's members use (for example Claude Code, Codex), installed and signed in as you
  normally are. This package contains no login material and never asks for any.
- The **tools** listed under `prerequisites` in `FACTORY.json`. The launcher checks each one and names anything missing.

## 1. Download and verify

Download the package and its checksum from the page you found it on, then check the hash **before unpacking**:

```bash
curl -fLO <package-url>/<factory-id>-<version>.tar.gz
curl -fLO <package-url>/<factory-id>-<version>.tar.gz.sha256
shasum -a 256 -c <factory-id>-<version>.tar.gz.sha256      # must print: OK
```

The hash on the page, in the `.sha256` file and in `FACTORY.json`'s own file list all refer to this same version.

## 2. Unpack somewhere stable

```bash
mkdir -p ~/rig-factories && tar -xzf <factory-id>-<version>.tar.gz -C ~/rig-factories
cd ~/rig-factories/<factory-id>-<version>
```

Keep this directory: the rigs run from the native bundles inside it.

## 3. Read before launching

- `FACTORY.json` lists every rig, member, skill, file hash, tool prerequisite and **permission change**.
- `source/` is the editable source of every rig. `rig.yaml` is the recommended configuration;
  `rig.test-models.yaml` (if present) is a cheaper **test** variant.
- `launch.mjs` is the launcher, a few hundred readable lines. It only verifies files, copies starter files, installs context packs
  and runs `rig` commands.

## What it adds, and what it leaves alone

- It **adds** the factory's rigs (see `FACTORY.json`), installs its context packs into your OpenRig context library,
  and writes into the project directory you choose.
- It **never** stops, restarts or changes your other rigs or OpenRig's kernel. If a rig with the same name as one of
  the factory's rigs already exists, the launcher refuses and names it rather than overwrite or duplicate it.
- Besides the project, OpenRig names one more writable path for each **Codex** seat: that rig's state folder under
  your OpenRig shared-docs root (`~/.openrig/shared-docs/rigs/<rig>/state/<pod>` on a normal install). OpenRig 0.6.1
  does not create that folder and the seat cannot create it, so the seat can write there only if something else
  already has. The author's
  permissions section at the end of this file says what else each seat may write.

Maintainers who want to test a factory in isolation (a throwaway OpenRig home and daemon) will find that recipe in
`TESTING.md`. It is not a step for using the factory.

## 4. Check everything without launching

Pick the project directory the agents should work in (it is created if missing):

```bash
node launch.mjs --project ~/my-factory-project --plan-only
```

This verifies every file hash and each bundle's integrity, checks OpenRig and the tools, copies the starter files into
your project, **prints every permission change the factory declares** (what it does, and whether it was tested),
and runs OpenRig's preflight (`rig up … --plan`, which writes a record and launches nothing). Context packs are
listed but not installed.

Starter files never overwrite yours. If your project already has a file with the same name and different content (a
`.gitignore`, for example), the launcher stops and names it. Merge the factory's version (in `starter/`) into yours by
hand, or move yours aside, then run the launcher again. A factory's starter `.gitignore` keeps the agents' own files
(and any file holding your machine's paths) out of your repository.

## 5. Launch

```bash
node launch.mjs --project ~/my-factory-project                      # recommended models
node launch.mjs --project ~/my-factory-project --profile test       # cheaper TEST models, if the factory ships them
```

The launcher installs the factory's context packs (`rig context add`) and reads every file back with
`rig context get`. Seats pull them the same way while they work.

Permission changes are **not** applied unless you add `--apply-permissions`, after reading what step 4 printed and
the author's own explanation at the end of this file. They are ordinary project files you can inspect and delete.
Without them, Codex seats can't reach the OpenRig daemon (their sandbox blocks it), so they can't hand work on.

After launching, the launcher checks that every member:

- is running in your project directory;
- got its startup files;
- runs the model of the profile you chose;
- has each of its skills where its runtime reads them (`.claude/skills` for Claude Code, `.agents/skills` for Codex),
  byte for byte.

It stops loudly if anything is missing.

## 6. Give it work

The launcher's last lines print the factory's first job. A message sent with `rig send` from a plain shell carries
**no sender name**, so a seat may not treat it as coming from you. Put your request in a file in the project (for
example `BRIEF.md`, or a file under `requests/`) and send a message that names that file. The factory's own guide
treats a named project file as the human's request.

## 7. Make it yours

Everything is local and editable. Nothing is configured through the website:

- **Models:** change `model:` on any member in `source/<rig>/rig.yaml`.
- **Harness:** change a member's `runtime:` (for example `claude-code` or `codex`) and its `profile:`.
- **Context:** edit the starter files in your project, or the agents' `guidance/` and `skills/` under `source/`.

Then rebuild the bundle from your edited source and relaunch:

```bash
rig bundle create "$PWD/source/<rig>/rig.yaml" -o "$PWD/bundles/<rig>.rigbundle" --name <rig> --bundle-version <version>-local
node launch.mjs --project ~/my-factory-project
```

A rebuilt bundle is yours; its hashes no longer match `FACTORY.json`, so the launcher will say so. That is expected.
Launch it with `rig up "$PWD/bundles/<rig>.rigbundle" --cwd ~/my-factory-project --yes`.

## Stopping

`rig down <rig-name>` stops a rig. To restart it later with its agents, files and workspace intact:
`rig down <rig-name> --snapshot`, then `rig up <rig-name> --existing --yes`.

If you delete a factory rig and launch it again later, queue items still addressed to its old seats can reach the new
ones; check `rig queue list` for them.
