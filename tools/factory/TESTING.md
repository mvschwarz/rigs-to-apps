# Isolated test recipe (for maintainers and CI)

This is **not** a step for using the factory. `SETUP.md` adds the factory to the OpenRig you already run. This recipe
runs it in a throwaway OpenRig home with its own daemon, for repeatable tests that must not touch anyone's real
OpenRig.

Put the instance's variables in ONE env file (`test.env`) and source it before anything starts, so the daemon and
the launcher see the same values. `test.env`:

```bash
export OPENRIG_HOME="$PWD/test-home"
export OPENRIG_SHARED_DOCS_ROOT="$PWD/test-home/shared-docs"
export OPENRIG_URL=http://127.0.0.1:7440
export TMUX_TMPDIR="$PWD/test-tmux"
```

Then:

```bash
. ./test.env
mkdir -p "$OPENRIG_HOME" "$OPENRIG_SHARED_DOCS_ROOT" "$TMUX_TMPDIR"
rig daemon start --port 7440 --host 127.0.0.1 --no-kernel
node launch.mjs --project "$PWD/test-project" --profile test --apply-permissions
# ... then stop every factory rig (rig down <rig-name>) and: rig daemon stop
```

- `--no-kernel` starts only the daemon, so a test pays for no kernel agent seats. A real user's OpenRig normally runs
  its kernel, and the factory is built to sit beside it.
- `TMUX_TMPDIR` gives the test its own terminal server: terminal session names are shared per OS user.
- A fresh home starts with an empty queue, so no items from an earlier test reach the new seats.
- Set `OPENRIG_SHARED_DOCS_ROOT` as well as `OPENRIG_HOME`; the launcher refuses a separate home without it. OpenRig 0.6.1 builds each Codex seat's writable state
  folder (`<root>/rigs/<rig>/state/<pod>`) from `OPENRIG_SHARED_DOCS_ROOT`, else `~/.openrig/shared-docs`, and never
  from `OPENRIG_HOME`. Without it, a test instance's Codex seats get write access inside the OS user's real OpenRig.
- To test the default path the way users have it, drop `--no-kernel` and start another rig first: the factory must
  come up beside them and leave both unchanged.
