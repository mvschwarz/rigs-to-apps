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
import { importBundle, loadOpenRigParser, LIMITS } from "./import-bundle.mjs";

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
  version: "0.5.14",
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
  assert.equal(s.parsed_by.openrig, "0.5.14");
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
  // builtin:yolo appears ONLY as the labelled tested fact — never as a default or a recommendation
  assert.match(codexRisk.detail, /Tested to coordinate only with permission_policy: builtin:yolo \(Codex runs with danger-full-access and no approvals; broad\)/);
  assert.ok(!/recommend|we suggest|you should|set permission_policy/i.test(codexRisk.detail), "the yolo fact is phrased as advice");
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
});

test("the real parser loader fails loudly on a version it is not pinned to", async () => {
  await assert.rejects(loadOpenRigParser({ expected: "0.0.0-never" }), /OpenRig parser (version mismatch|unavailable)/);
});
