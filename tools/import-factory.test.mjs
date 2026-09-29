// Tests for tools/import-factory.mjs and the factory kind in tools/validate.mjs.
// Each builds a tiny but REAL factory archive (a RigSpec and AgentSpec that the
// pinned OpenRig parser accepts) and runs the real CLIs. No network, no daemon.
//
//   node --test tools/import-factory.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "factory-test-")));
const run = (args, env = {}) => spawnSync("node", args, { encoding: "utf8", env: { ...process.env, ...env } });

const RIG = `version: "0.2"
name: tiny-factory
summary: A one-seat test factory.
pods:
  - id: core
    label: Core
    members:
      - id: lead
        agent_ref: "local:agents/lead"
        profile: default
        runtime: claude-code
        cwd: .
        model: claude-opus-5-5
    edges: []
edges: []
`;
const AGENT = `name: tiny-lead
version: "1.0"
description: The only seat.
defaults:
  runtime: claude-code
profiles:
  default:
    uses:
      skills: [plan]
resources:
  skills:
    - id: plan
      path: skills/plan
`;

// Build <root>/factories/tiny/listing.json and a matching archive; `mutate(pkgDir)`
// runs after FACTORY.json is written, before packing.
function build({ mutate, listing = {} } = {}) {
  const root = tmp();
  const pkg = path.join(root, "build", "tiny-0.1.0");
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true }); fs.writeFileSync(path.join(pkg, rel), body); };
  w("source/tiny/rig.yaml", RIG);
  w("source/tiny/rig.test-models.yaml", RIG.replace("claude-opus-5-5", "claude-sonnet-5"));
  w("source/tiny/agents/lead/agent.yaml", AGENT);
  w("source/tiny/agents/lead/skills/plan/SKILL.md", "---\nname: plan\ndescription: plan\n---\n# plan\n");
  w("bundles/tiny.rigbundle", "not a real bundle; the importer never opens it\n");
  w("bundles/tiny.test-models.rigbundle", "not a real bundle either\n");
  const files = ["source/tiny/rig.yaml", "source/tiny/rig.test-models.yaml", "source/tiny/agents/lead/agent.yaml",
    "source/tiny/agents/lead/skills/plan/SKILL.md", "bundles/tiny.rigbundle", "bundles/tiny.test-models.rigbundle"]
    .map((p) => ({ path: p, sha256: sha256(path.join(pkg, p)), bytes: fs.statSync(path.join(pkg, p)).size }));
  const F = { package_format: 1, id: "tiny", version: "0.1.0", title: "Tiny", summary: "A test factory.",
    author: { name: "Test", url: "https://example.org" }, license: "MIT",
    rigs: [{ id: "tiny", name: "tiny-factory", bundles: {
      recommended: { path: "bundles/tiny.rigbundle", spec: "source/tiny/rig.yaml" },
      test: { path: "bundles/tiny.test-models.rigbundle", spec: "source/tiny/rig.test-models.yaml" } } }],
    starter: [], prerequisites: [], permissions: [], files };
  fs.writeFileSync(path.join(pkg, "FACTORY.json"), JSON.stringify(F, null, 2));
  mutate?.(pkg);
  const archive = path.join(root, "tiny-0.1.0.tar.gz");
  const t = spawnSync("tar", ["-czf", archive, "-C", path.join(root, "build"), "tiny-0.1.0"]);
  assert.equal(t.status, 0);
  const dir = path.join(root, "factories", "tiny");
  fs.mkdirSync(dir, { recursive: true });
  const L = { descriptor_version: 1, kind: "factory", id: "tiny", title: "Tiny", summary: "A test factory.", tags: [],
    author: { name: "Test", url: "https://example.org" }, license: "MIT",
    source: { repo: "https://github.com/test-author/tiny", path: "factories/tiny/", ref: null },
    release: { tag: "tiny-v0.1.0", asset: "tiny-0.1.0.tar.gz", sha256: sha256(archive) }, ...listing };
  fs.writeFileSync(path.join(dir, "listing.json"), JSON.stringify(L, null, 2));
  return { root, archive, listing: path.join(dir, "listing.json"), snapshot: path.join(dir, "snapshot.json") };
}
const importIt = (b) => run([path.join(TOOLS, "import-factory.mjs"), b.listing, b.archive]);
const validate = (b) => run([path.join(TOOLS, "validate.mjs"), "--registry", path.join(b.root, "registry.json")], { REGISTRY_ROOT: b.root });
const register = (b) => fs.writeFileSync(path.join(b.root, "registry.json"), JSON.stringify(["factories/tiny/listing.json"]));

test("imports a real archive: rigs, both model profiles, AgentSpec, skills, one hash", () => {
  const b = build();
  const r = importIt(b);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(b.snapshot, "utf8"));
  assert.equal(s.archive.sha256, sha256(b.archive));
  assert.equal(s.archive.sha256_url, `${s.archive.url}.sha256`);
  assert.match(s.setup_prompt, new RegExp(s.archive.sha256));
  assert.match(s.setup_prompt, new RegExp(s.archive.url.replace(/[.?/]/g, "\\$&")));
  const m = s.rigs[0].topology.pods[0].members[0];
  assert.deepEqual(m.model, { recommended: "claude-opus-5-5", test: "claude-sonnet-5" });
  assert.equal(m.agent, "source/tiny/agents/lead");
  assert.deepEqual(s.rigs[0].agents[0].skills.map((k) => k.id), ["plan"]);
  register(b);
  assert.equal(validate(b).status, 0, validate(b).stdout);
});

test("refuses an archive whose sha256 differs from the listing's", () => {
  const b = build();
  fs.appendFileSync(b.archive, "x");
  const r = importIt(b);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not equal listing release\.sha256/);
});

test("refuses an archive whose file differs from its own FACTORY.json", () => {
  const b = build({ mutate: (pkg) => fs.appendFileSync(path.join(pkg, "source/tiny/agents/lead/agent.yaml"), "# changed\n") });
  const r = importIt(b);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /agent\.yaml is missing or does not match FACTORY\.json/);
});

test("refuses an archive holding a file FACTORY.json does not list", () => {
  const b = build({ mutate: (pkg) => fs.writeFileSync(path.join(pkg, "EXTRA.md"), "unlisted\n") });
  const r = importIt(b);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /EXTRA\.md, which FACTORY\.json does not list/);
});

test("validator refuses a snapshot imported from a different archive than the listing names", () => {
  const b = build();
  assert.equal(importIt(b).status, 0);
  const L = JSON.parse(fs.readFileSync(b.listing, "utf8"));
  L.release.sha256 = "0".repeat(64);
  fs.writeFileSync(b.listing, JSON.stringify(L));
  register(b);
  const v = validate(b);
  assert.notEqual(v.status, 0);
  assert.match(v.stdout, /imported from a different archive/);
});

test("validator refuses a release tag or asset that does not match the id and version", () => {
  for (const release of [{ tag: "tiny-0.1.0" }, { tag: "other-v0.1.0" }, { asset: "tiny-0.1.1.tar.gz" }]) {
    const b = build();
    const L = JSON.parse(fs.readFileSync(b.listing, "utf8"));
    Object.assign(L.release, release);
    fs.writeFileSync(b.listing, JSON.stringify(L));
    const v = run([path.join(TOOLS, "validate.mjs"), b.listing]);
    assert.notEqual(v.status, 0, JSON.stringify(release));
    assert.match(v.stdout, /release\.(tag|asset) must be/);
  }
});

// --- verified-factories.json: the maintainer's post-QA record, bound to the exact archive ---
const record = (b, over = {}) => ({ id: "tiny", version: "0.1.0", sha256: sha256(b.archive), verdict: "SHIP", qa: "independent QA (non-author builder seat)",
  date: "2026-09-29", openrig: "0.6.1", runtimes: { "claude-code": "2.1.220" }, models: "test", path: "additive", ...over });
const writeVerified = (b, list) => fs.writeFileSync(path.join(b.root, "verified-factories.json"), JSON.stringify(list));

test("a verified record for this exact id, version and sha256 stamps the snapshot", () => {
  const b = build();
  writeVerified(b, [record(b)]);
  assert.equal(importIt(b).status, 0);
  const s = JSON.parse(fs.readFileSync(b.snapshot, "utf8"));
  assert.equal(s.verified?.verdict, "SHIP");
  assert.equal(s.verified?.models, "test");
});

test("a verified record for a DIFFERENT archive of the same version does not stamp it", () => {
  const b = build();
  writeVerified(b, [record(b, { sha256: "f".repeat(64) })]);
  assert.equal(importIt(b).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(b.snapshot, "utf8")).verified, null);
});

test("the registry validator refuses a malformed verified record", () => {
  for (const bad of [{ verdict: "PASS" }, { models: "premium" }, { path: "fresh-home" }, { sha256: "abc" }, { extra: 1 }, { qa: "independent QA: builder-impl" }, { qa: "reviewer-qa@some-rig" }]) {
    const b = build();
    assert.equal(importIt(b).status, 0);
    register(b);
    writeVerified(b, [record(b, bad)]);
    const v = validate(b);
    assert.notEqual(v.status, 0, JSON.stringify(bad));
    assert.match(v.stdout, /verified-factories\.json|unknown field/);
  }
});

test("a factory listing licence may be an SPDX expression; malformed ones are refused", () => {
  for (const [license, good] of [["Apache-2.0 AND MIT", true], ["(MIT OR Apache-2.0) AND BSD-3-Clause", true],
      ["GPL-2.0-only WITH Classpath-exception-2.0", true], ["Apache-2.0 AND", false], ["Apache 2.0", false],
      ["AND MIT", false], ["(MIT", false], ["MIT; rm -rf", false]]) {
    const b = build({ listing: { license } });
    const v = run([path.join(TOOLS, "validate.mjs"), b.listing]);
    assert.equal(v.status === 0, good, `${license}: ${v.stdout}`);
  }
});

test("agent_run_version: accepted with a delta_qa and an earlier version; refused otherwise", () => {
  const cases = [
    [{ version: "0.1.0", agent_run_version: "0.0.9", delta_qa: "independent delta QA (non-author builder seat)" }, true],
    [{ version: "0.1.0", agent_run_version: "0.0.9" }, false],                                  // no delta QA reference
    [{ version: "0.1.0", agent_run_version: "0.1.0", delta_qa: "independent delta QA" }, false], // not strictly earlier
    [{ version: "0.1.0", agent_run_version: "0.2.0", delta_qa: "independent delta QA" }, false], // later
    [{ version: "0.1.0", delta_qa: "independent delta QA" }, false],                             // delta_qa alone
    [{ version: "0.1.0", agent_run_version: "0.0.9", delta_qa: "checked by builder-impl" }, false], // seat-like
  ];
  for (const [over, good] of cases) {
    const b = build();
    assert.equal(importIt(b).status, 0);
    register(b);
    writeVerified(b, [record(b, over)]);
    const v = validate(b);
    assert.equal(v.status === 0, good, `${JSON.stringify(over)}: ${v.stdout}`);
  }
});

test("the snapshot carries agent_run_version and delta_qa when the record has them", () => {
  const b = build();
  writeVerified(b, [record(b, { agent_run_version: "0.0.9", delta_qa: "independent delta QA (non-author builder seat)" })]);
  assert.equal(importIt(b).status, 0);
  const s = JSON.parse(fs.readFileSync(b.snapshot, "utf8"));
  assert.equal(s.verified.agent_run_version, "0.0.9");
  assert.equal(s.verified.delta_qa, "independent delta QA (non-author builder seat)");
});
