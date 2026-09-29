// Hermetic tests for tools/import-bundle.mjs. No network, no daemon, no
// OpenRig install. Two collaborators are doubles:
//   fetchSource: copies a fixture "author repo" into place (or fails, like git);
//   parser:      a TEST DOUBLE for OpenRig's RigSpecCodec/RigSpecSchema and
//                AgentSpec parser. Fixture specs are written in JSON syntax (YAML
//                is a JSON superset), so JSON.parse stands in. The REAL parsers
//                are exercised by the real import recorded in the slice proof.
// The descriptor validator is the REAL tools/validate.mjs.
//
//   node --test tools/import-bundle.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { importBundle, loadOpenRigParser, LIMITS, PARSER_CLI_VERSION } from "./import-bundle.mjs";

const REF = "a".repeat(40);
const PRIVATE = "private-host-7f3a";

const RIG = {
  version: "0.2", name: "tiny", culture_file: "CULTURE.md",
  pods: [{ id: "core", label: "Core", members: [
    { id: "lead", runtime: "claude-code", agentRef: "local:agents/lead", cwd: "." },
    { id: "helper", runtime: "codex", agentRef: "local:agents/helper", cwd: "." },
  ], edges: [{ kind: "delegates_to", from: "lead", to: "helper" }] }],
  edges: [],
};
const AGENT = (name, extra = {}) => ({ name, version: "1.0", imports: [{ ref: "local:../shared" }],
  profiles: { default: { uses: { skills: ["plan"], plugins: ["shared:openrig-core"] } } }, ...extra });

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// A registry with one descriptor at bundles/<id>/rig.json.
function registry({ descriptor = {}, source = {} } = {}) {
  const root = tmp("rigsto-reg-");
  const id = descriptor.id ?? "tiny";
  const dir = path.join(root, "bundles", id);
  fs.mkdirSync(dir, { recursive: true });
  const d = {
    descriptor_version: 1, kind: "rig-bundle", id, title: "Tiny rig", summary: "A two-member test rig.",
    tags: ["test"], author: { name: "Test Author", url: "https://github.com/test-author" }, license: "MIT",
    source: { repo: "https://github.com/test-author/tiny", ref: REF, spec: "rigs/tiny/rig.yaml", ...source },
    media: { screenshots: [] }, ...descriptor,
  };
  fs.writeFileSync(path.join(dir, "rig.json"), JSON.stringify(d, null, 2));
  return { descriptorPath: path.join(dir, "rig.json"), snapshotPath: path.join(dir, "snapshot.json") };
}

// A fixture author repo; `mutate(repo)` plants symlinks, oversized files, etc.
function authorRepo(mutate) {
  const repo = tmp("rigsto-src-");
  const rig = path.join(repo, "rigs", "tiny");
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(rig, rel)), { recursive: true }); fs.writeFileSync(path.join(rig, rel), body); };
  w("rig.yaml", JSON.stringify(RIG, null, 2));
  w("CULTURE.md", "# culture\n");
  w("agents/lead/agent.yaml", JSON.stringify(AGENT("lead")));
  w("agents/lead/guidance/role.md", "lead\n");
  w("agents/helper/agent.yaml", JSON.stringify(AGENT("helper", { defaults: { runtime: "codex", model: "gpt-6-astra" } })));
  w("agents/shared/agent.yaml", JSON.stringify({ name: "shared", version: "1.0" }));
  w("agents/shared/skills/plan/SKILL.md", "# plan\n");
  fs.writeFileSync(path.join(repo, "UNRELATED.md"), "not referenced\n");
  if (mutate) mutate(repo, rig);
  return repo;
}

const fetchFrom = (repoDir) => ({ dest }) => {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(repoDir, dest, { recursive: true, verbatimSymlinks: true });
};
const failingFetch = () => { throw new Error("fetch failed for https://github.com/test-author/tiny: repository not found"); };

// TEST DOUBLE for OpenRig's parsers — see header.
const parser = {
  version: PARSER_CLI_VERSION,
  rig: {
    parse: (y) => JSON.parse(y),
    validate: (r) => (Array.isArray(r?.pods) ? { valid: true, errors: [] } : { valid: false, errors: ["pods: required"] }),
    normalize: (r) => ({ ...r, cultureFile: r.culture_file }),
  },
  agent: {
    parse: (y) => JSON.parse(y),
    validate: (r) => (typeof r?.name === "string" ? { valid: true, errors: [] } : { valid: false, errors: ["name: required"] }),
    normalize: (r) => r,
  },
  edgeKinds: new Set(["delegates_to", "spawned_by", "can_observe", "collaborates_with", "escalates_to"]),
};

const run = (reg, repo, extra = {}) => importBundle({
  descriptorPath: reg.descriptorPath, cacheDir: tmp("rigsto-cache-"),
  fetchSource: fetchFrom(repo), parser, leakTerms: [PRIVATE], ...extra,
});

test("valid import: topology, agents and imports, files and risks come from the parsed specs", async () => {
  const reg = registry();
  await run(reg, authorRepo());
  const s = JSON.parse(fs.readFileSync(reg.snapshotPath, "utf8"));
  assert.equal(s.source.ref, REF);
  assert.equal(s.parsed_by.openrig, PARSER_CLI_VERSION);
  assert.deepEqual(s.topology.pods[0].members.map((m) => `${m.id}:${m.runtime}:${m.agent}`),
    ["lead:claude-code:rigs/tiny/agents/lead", "helper:codex:rigs/tiny/agents/helper"]);
  assert.deepEqual(s.topology.edges, [{ kind: "delegates_to", from: "core.lead", to: "core.helper" }]);
  assert.deepEqual(s.agents.map((a) => a.path), ["rigs/tiny/agents/helper", "rigs/tiny/agents/lead", "rigs/tiny/agents/shared"]);
  // spec dir (top level) + culture + every referenced agent dir, recursively — and nothing unreferenced
  const paths = s.files.entries.map((f) => f.path);
  assert.ok(paths.includes("rigs/tiny/rig.yaml") && paths.includes("rigs/tiny/CULTURE.md"));
  assert.ok(paths.includes("rigs/tiny/agents/shared/skills/plan/SKILL.md"), "an imported agent's files were not listed");
  assert.ok(!paths.includes("UNRELATED.md"), "an unreferenced file was listed");
  assert.deepEqual(s.requirements.runtimes, ["claude-code", "codex"]);
  assert.deepEqual(s.risks.map((r) => r.id), ["model-pins", "host-plugins", "codex-floor", "no-author-auth"]);
  assert.deepEqual(s.launch_posture.members.map((m) => `${m.runtime}:${m.posture}`), ["claude-code:floor", "codex:floor"]);
  const codexRisk = s.risks.find((r) => r.id === "codex-floor");
  assert.match(codexRisk.detail, /core\.helper/);
  assert.ok(!/core\.lead/.test(codexRisk.detail), "a Claude Code member at floor was flagged — it coordinates out of the box");
  assert.ok(!/yolo|danger-full-access/i.test(JSON.stringify(s)), "the retired yolo line is still in the snapshot");
  const files = s.install.codex_coordination.files;
  assert.deepEqual(files.map((f) => f.path), [".codex/config.toml", ".codex/rules/openrig.rules"], "the tested setup is TWO files");
  assert.match(files[0].text, /approval_policy = "never"[\s\S]*sandbox_mode = "workspace-write"[\s\S]*\[sandbox_workspace_write\][\s\S]*network_access = false/);
  assert.match(files[1].text, /pattern = \["rig"\],\n    decision = "allow"/);
  assert.match(s.install.codex_coordination.effect, /^Tested configuration: with these two files,/);
  assert.equal(s.license_url, "https://spdx.org/licenses/MIT.html", "no licence file in the fixture repo -> the SPDX page");
  assert.deepEqual(s.install.restart.steps.map((x) => x.command), ["rig down tiny --snapshot", "rig up tiny --existing --yes"]);
  assert.equal(s.install.restart.label, "Restart the rig (keeps its agents, files and workspace)");
  assert.ok(!/configuration change/i.test(JSON.stringify(s.install)), "restart is still described as applying a config change");
  assert.match(s.install.update, /can't update a running rig to a newer source commit in place/);
  assert.ok(!/--delete|rig import|workspace-only/.test(JSON.stringify(s.install)), "a workaround recipe crept into the update text");
  assert.match(s.risks[0].detail, /gpt-6-astra/);
  assert.equal(s.install.status, "parsed, not launch-tested");
  assert.equal(s.install.launch_tested, null);
  assert.equal(s.install.bundle_steps, null, "route B shown for a listing with no bundle");
  assert.deepEqual(s.requirements.models, [{ member: "core.helper", runtime: "codex", model: "gpt-6-astra" }]);
  assert.equal(s.requirements.openrig.min, "0.6.1");
  assert.ok(s.install.steps.some((st) => /--plan$/.test(st.command)) && s.install.steps.some((st) => /--yes$/.test(st.command)));
  assert.ok(s.install.steps.every((st) => !/bundle (create|install)/.test(st.command)), "the install block still packs a bundle");
});

test("two imports at one pin are byte-identical", async () => {
  const reg = registry();
  const repo = authorRepo();
  await run(reg, repo);
  const a = fs.readFileSync(reg.snapshotPath);
  await run(reg, repo);
  assert.equal(Buffer.compare(a, fs.readFileSync(reg.snapshotPath)), 0);
});

test("invalid descriptor fails with the validator's reason and writes nothing", async () => {
  for (const [opts, why] of [
    [{ source: { ref: "main" } }, /full 40-character commit SHA/],
    [{ source: { repo: "http://github.com/test-author/tiny" } }, /public https:\/\/github.com/],
    [{ source: { bundle: "rigs/tiny/tiny.zip" } }, /source.bundle must name a .rigbundle/],
    [{ descriptor: { topology: { pods: [] } } }, /unknown field 'topology'/],
    [{ descriptor: { kind: "app" } }, /kind must be "rig-bundle"/],
  ]) {
    const reg = registry(opts);
    await assert.rejects(run(reg, authorRepo()), why);
    assert.ok(!fs.existsSync(reg.snapshotPath), "a snapshot was written for an invalid descriptor");
  }
});

test("unsafe paths are refused: .., absolute, symlink escape, oversized, escaping agent_ref", async () => {
  await assert.rejects(run(registry({ source: { spec: "../outside/rig.yaml" } }), authorRepo()), /path escapes source repo/);
  await assert.rejects(run(registry({ source: { spec: "/etc/rig.yaml" } }), authorRepo()), /path escapes source repo/);

  const outside = tmp("rigsto-outside-");
  fs.writeFileSync(path.join(outside, "rig.yaml"), JSON.stringify(RIG));
  await assert.rejects(run(registry(), authorRepo((repo, rig) => {
    fs.rmSync(path.join(rig, "rig.yaml"));
    fs.symlinkSync(path.join(outside, "rig.yaml"), path.join(rig, "rig.yaml"));
  })), /escapes source repo \(symlink\)/);

  await assert.rejects(run(registry(), authorRepo((repo, rig) =>
    fs.writeFileSync(path.join(rig, "rig.yaml"), "#".repeat(LIMITS.specBytes + 1)))), /too large/);

  // an agent_ref that climbs out of the checkout
  await assert.rejects(run(registry(), authorRepo((repo, rig) => {
    const spec = JSON.parse(JSON.stringify(RIG)); spec.pods[0].members[0].agentRef = "local:../../../../../etc";
    fs.writeFileSync(path.join(rig, "rig.yaml"), JSON.stringify(spec));
  })), /path escapes source repo/);

  // a symlink INSIDE a referenced agent dir pointing out of the repo
  await assert.rejects(run(registry(), authorRepo((repo, rig) =>
    fs.symlinkSync(path.join(outside, "rig.yaml"), path.join(rig, "agents", "lead", "stolen.md")))), /listed file escapes source repo \(symlink\)/);
});

test("an author refresh to a new commit moves the snapshot's pinned revision with it", async () => {
  const reg = registry();
  await run(reg, authorRepo());
  assert.equal(JSON.parse(fs.readFileSync(reg.snapshotPath, "utf8")).source.ref, REF);
  const NEXT = "c".repeat(40);
  const d = JSON.parse(fs.readFileSync(reg.descriptorPath, "utf8")); d.source.ref = NEXT;
  fs.writeFileSync(reg.descriptorPath, JSON.stringify(d, null, 2));
  await run(reg, authorRepo());
  const s = JSON.parse(fs.readFileSync(reg.snapshotPath, "utf8"));
  assert.equal(s.source.ref, NEXT, "the refreshed page does not show the new commit");
  assert.ok(s.source.tree_url.endsWith(`/tree/${NEXT}`) && s.files.entries.length > 0);
});

test("failed fetch fails loudly and preserves the last good snapshot byte-for-byte", async () => {
  const reg = registry();
  await run(reg, authorRepo());
  const lastGood = fs.readFileSync(reg.snapshotPath);
  await assert.rejects(run(reg, authorRepo(), { fetchSource: failingFetch }), /fetch failed/);
  assert.equal(Buffer.compare(lastGood, fs.readFileSync(reg.snapshotPath)), 0, "the last good snapshot changed");
});

test("OpenRig rejecting the spec surfaces its reason and preserves the last good snapshot", async () => {
  const reg = registry();
  await run(reg, authorRepo());
  const lastGood = fs.readFileSync(reg.snapshotPath);
  const why = 'pods[0].members[0].summary: unknown key "summary"';
  const rejecting = { ...parser, rig: { ...parser.rig, validate: () => ({ valid: false, errors: [why] }) } };
  await assert.rejects(run(reg, authorRepo(), { parser: rejecting }), (e) => e.message.includes(why) && /RigSpecSchema rejected/.test(e.message));
  assert.equal(Buffer.compare(lastGood, fs.readFileSync(reg.snapshotPath)), 0);
});

test("parser failures are loud — no hand-parsed fallback", async () => {
  const throwing = { ...parser, rig: { ...parser.rig, parse: () => { throw new Error("bad indentation"); } } };
  await assert.rejects(run(registry(), authorRepo(), { parser: throwing }), /RigSpecCodec could not parse.*bad indentation/);
  const badAgent = { ...parser, agent: { ...parser.agent, validate: () => ({ valid: false, errors: ["profiles: bad"] }) } };
  await assert.rejects(run(registry(), authorRepo(), { parser: badAgent }), /rejected the AgentSpec.*profiles: bad/);
  const unknownEdge = { ...parser, edgeKinds: new Set(["spawned_by"]) };
  await assert.rejects(run(registry(), authorRepo(), { parser: unknownEdge }), /edge kind OpenRig does not know/);
});

test("a snapshot that would name a private term is refused, not written", async () => {
  const reg = registry({ descriptor: { summary: `Built on ${PRIVATE}.` } });
  await assert.rejects(run(reg, authorRepo()), /private term/);
  assert.ok(!fs.existsSync(reg.snapshotPath));
});

test("an optional prebuilt .rigbundle is recorded (hashed, linked), never opened", async () => {
  const reg = registry({ source: { bundle: "dist/tiny.rigbundle" } });
  await run(reg, authorRepo((repo) => { fs.mkdirSync(path.join(repo, "dist")); fs.writeFileSync(path.join(repo, "dist", "tiny.rigbundle"), "not even a tarball"); }));
  const s = JSON.parse(fs.readFileSync(reg.snapshotPath, "utf8"));
  assert.equal(s.source.bundle.path, "dist/tiny.rigbundle");
  assert.match(s.source.bundle.sha256, /^[0-9a-f]{64}$/);
  assert.match(s.install.bundle_steps.at(-1).command, /rig up "\$PWD\/tiny\/dist\/tiny\.rigbundle" --cwd .* --yes$/);
  await assert.rejects(run(registry({ source: { bundle: "dist/missing.rigbundle" } }), authorRepo()), /source.bundle not found/);
});

test("launch-tested comes ONLY from verified.json, and only for the exact id + commit", async () => {
  const reg = registry();
  const root = path.resolve(path.dirname(reg.descriptorPath), "..", "..");
  fs.writeFileSync(path.join(root, "verified.json"), JSON.stringify([{ id: "tiny", ref: "b".repeat(40), openrig: "0.6.1", runtimes: { codex: "0.159" } }]));
  await run(reg, authorRepo());
  let s = JSON.parse(fs.readFileSync(reg.snapshotPath, "utf8"));
  assert.equal(s.install.launch_tested, null, "a verification for a DIFFERENT commit was applied to this one");
  fs.writeFileSync(path.join(root, "verified.json"), JSON.stringify([{ id: "tiny", ref: REF, openrig: "0.6.1", runtimes: { codex: "0.159" } }]));
  await run(reg, authorRepo());
  s = JSON.parse(fs.readFileSync(reg.snapshotPath, "utf8"));
  assert.equal(s.install.status, "launch tested on OpenRig 0.6.1");
  assert.deepEqual(s.install.launch_tested, { openrig: "0.6.1", runtimes: { codex: "0.159" } });
});

test("a declared permission_policy is shown verbatim and clears the floor risk", async () => {
  const reg = registry();
  await run(reg, authorRepo((repo, rig) => {
    const spec = JSON.parse(JSON.stringify(RIG)); spec.permissionPolicy = "builtin:coordinated";
    fs.writeFileSync(path.join(rig, "rig.yaml"), JSON.stringify(spec));
  }));
  const s = JSON.parse(fs.readFileSync(reg.snapshotPath, "utf8"));
  assert.deepEqual(s.launch_posture.members.map((m) => `${m.posture}:${m.policy}`), ["declared:builtin:coordinated", "declared:builtin:coordinated"]);
  assert.ok(!s.risks.some((r) => r.id === "codex-floor"));
  assert.equal(s.install.codex_coordination, null, "a Codex rule was shown for a listing with no Codex member at floor");
});

test("the licence links to the repo's own licence file at the pinned commit when it has one", async () => {
  const reg = registry();
  await run(reg, authorRepo((repo) => fs.writeFileSync(path.join(repo, "LICENSE"), "MIT License\n")));
  const s = JSON.parse(fs.readFileSync(reg.snapshotPath, "utf8"));
  assert.equal(s.license_url, `https://github.com/test-author/tiny/blob/${REF}/LICENSE`);
});

test("the CLI runs when invoked through a symlinked path (macOS /tmp -> /private/tmp)", () => {
  // QA-found: the run-as-CLI guard compared argv[1] as given against the
  // realpath'd module URL, so a symlinked invocation path skipped main() and
  // EXITED 0 HAVING DONE NOTHING — a check that cannot fail. Invoked with no
  // arguments through a symlink, the CLI must refuse loudly like it does
  // through its real path.
  const tools = path.dirname(fileURLToPath(import.meta.url));
  const alias = path.join(tmp("rigsto-alias-"), "tools");
  fs.symlinkSync(tools, alias, "dir");
  for (const script of [path.join(tools, "import-bundle.mjs"), path.join(alias, "import-bundle.mjs")]) {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(r.status, 1, `${script === path.join(alias, "import-bundle.mjs") ? "symlinked" : "real"} path exited ${r.status} — silent success`);
    assert.match(r.stdout, /^FAIL: usage: import-bundle\.mjs/);
  }
});

test("the parser loader fails loudly on a version it is not pinned to, or when not installed", async () => {
  await assert.rejects(loadOpenRigParser({ expected: "0.0.0-never" }), /OpenRig parser (version mismatch|unavailable).*npm ci --prefix tools/);
  await assert.rejects(loadOpenRigParser({ toolsDir: tmp("rigsto-empty-tools-") }), /not installed for the registry tools.*npm ci --prefix tools/);
});

test("the parser pin is ONE fact: PARSER_CLI_VERSION equals tools/package.json, and loads from the tool-local install", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@openrig/cli"], PARSER_CLI_VERSION, "tools/package.json and PARSER_CLI_VERSION disagree");
  const p = await loadOpenRigParser();
  assert.equal(p.version, PARSER_CLI_VERSION);
  assert.equal(p.rig.validate(p.rig.parse('version: "0.2"\nname: t\npods:\n  - id: a\n    label: A\n    members:\n      - id: m\n        agent_ref: "local:x"\n        runtime: codex\n        profile: default\n        cwd: "."\n    edges: []\nedges: []\n')).valid, true);
});
