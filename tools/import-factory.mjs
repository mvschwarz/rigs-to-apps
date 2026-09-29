#!/usr/bin/env node
// Import a FACTORY PACKAGE listing: the built archive -> factories/<id>/snapshot.json.
//
//   node tools/import-factory.mjs factories/<id>/listing.json <archive.tar.gz>
//
// The snapshot is derived from the exact archive a user downloads, never from a
// source tree beside it: the archive's sha256 must equal the listing's
// release.sha256, and every file must match the archive's own FACTORY.json. Each
// rig, both model variants and every AgentSpec are parsed with OpenRig's own
// parser (the pinned tools/node_modules copy). Nothing in the archive is executed.
// Deterministic: sorted lists, no timestamps.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { loadOpenRigParser, PARSER_CLI_VERSION } from "./import-bundle.mjs";

const SNAPSHOT_VERSION = 1;
const fail = (m) => { console.error(`import-factory: ${m}`); process.exit(1); };
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isStr = (x) => typeof x === "string";
const posix = (p) => p.split(path.sep).join("/");
const filesUnder = (root) => !fs.existsSync(root) ? [] : fs.readdirSync(root, { withFileTypes: true })
  .sort((a, b) => byStr(a.name, b.name))
  .flatMap((e) => e.isDirectory() ? filesUnder(path.join(root, e.name)).map((f) => `${e.name}/${f}`) : [e.name]);

const [listingPath, archivePath] = process.argv.slice(2);
if (!listingPath || !archivePath) fail("usage: import-factory.mjs factories/<id>/listing.json <archive.tar.gz>");
const listing = JSON.parse(fs.readFileSync(listingPath, "utf8"));

// 1. The archive is the one the listing names, byte for byte.
const archiveSha = sha256(archivePath);
if (archiveSha !== listing.release?.sha256) fail(`archive sha256 ${archiveSha} does not equal listing release.sha256 ${listing.release?.sha256}`);
if (path.basename(archivePath) !== listing.release.asset) fail(`archive is named ${path.basename(archivePath)}, but the listing's asset is ${listing.release.asset}`);

// 2. Unpack into a temp dir (tar only reads; nothing inside is run) and verify every file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "import-factory-"));
try {
  const t = spawnSync("tar", ["-xzf", path.resolve(archivePath), "-C", tmp], { encoding: "utf8" });
  if (t.status !== 0) fail(`could not unpack the archive: ${t.stderr.trim()}`);
  const tops = fs.readdirSync(tmp);
  if (tops.length !== 1) fail(`the archive must hold exactly one top directory, found: ${tops.join(", ")}`);
  const PKG = path.join(tmp, tops[0]);
  const F = JSON.parse(fs.readFileSync(path.join(PKG, "FACTORY.json"), "utf8"));
  if (F.id !== listing.id) fail(`FACTORY.json id ${F.id} does not equal listing id ${listing.id}`);
  if (tops[0] !== `${F.id}-${F.version}`) fail(`top directory ${tops[0]} is not ${F.id}-${F.version}`);
  if (listing.release.tag !== `${F.id}-v${F.version}`) fail(`release tag ${listing.release.tag} is not ${F.id}-v${F.version}`);
  const listed = new Set(F.files.map((f) => f.path));
  for (const f of F.files) {
    const p = path.join(PKG, f.path);
    if (!fs.existsSync(p) || sha256(p) !== f.sha256) fail(`archive file ${f.path} is missing or does not match FACTORY.json`);
  }
  for (const rel of filesUnder(PKG)) if (rel !== "FACTORY.json" && !listed.has(rel)) fail(`archive holds ${rel}, which FACTORY.json does not list`);

  // 3. Every rig, parsed with OpenRig's own parser, from the archive's source/.
  const parser = await loadOpenRigParser();
  const parseRig = (rel) => {
    const raw = parser.rig.parse(fs.readFileSync(path.join(PKG, rel), "utf8"));
    const v = parser.rig.validate(raw);
    if (!v?.valid) fail(`${rel} is not a valid RigSpec: ${(v?.errors ?? []).join("; ")}`);
    return parser.rig.normalize(raw);
  };
  const parseAgent = (rel) => {
    const raw = parser.agent.parse(fs.readFileSync(path.join(PKG, rel), "utf8"));
    const v = parser.agent.validate(raw);
    if (!v?.valid) fail(`${rel} is not a valid AgentSpec: ${(v?.errors ?? []).join("; ")}`);
    return parser.agent.normalize(raw);
  };
  const fileEntry = (rel) => { const f = F.files.find((x) => x.path === rel); return f ? { path: rel, bytes: f.bytes } : null; };

  const rigs = F.rigs.map((r) => {
    const specRel = r.bundles.recommended.spec;
    const specDir = path.posix.dirname(specRel);
    const spec = parseRig(specRel);
    const testSpec = r.bundles.test ? parseRig(r.bundles.test.spec) : null;
    const testModel = new Map((testSpec?.pods ?? []).flatMap((p) => p.members.map((m) => [`${p.id}.${m.id}`, m.model ?? null])));
    const agents = new Map();
    const agentOf = (ref) => {
      if (!isStr(ref) || !ref.startsWith("local:")) return null;
      const dir = path.posix.normalize(path.posix.join(specDir, ref.slice("local:".length)));
      if (!dir.startsWith(`${specDir}/`)) fail(`agent_ref ${ref} leaves the rig's source directory`);
      if (agents.has(dir)) return dir;
      const a = parseAgent(`${dir}/agent.yaml`);
      const skills = (a.resources?.skills ?? []).map((s) => {
        const sdir = path.posix.join(dir, s.path);
        return { id: String(s.id), path: sdir, files: filesUnder(path.join(PKG, sdir)).map((f) => fileEntry(`${sdir}/${f}`)).filter(Boolean) };
      }).sort((x, y) => byStr(x.id, y.id));
      agents.set(dir, {
        dir, name: String(a.name ?? path.posix.basename(dir)), version: a.version != null ? String(a.version) : null,
        description: isStr(a.description) ? a.description : null,
        runtime: isStr(a.defaults?.runtime) ? a.defaults.runtime : null,
        skills,
        guidance: (a.resources?.guidance ?? []).map((g) => path.posix.join(dir, g.path)).sort(byStr),
        startup: (a.startup?.files ?? []).map((s) => path.posix.join(dir, s.path)),
        plugins: [...new Set(Object.values(a.profiles ?? {}).flatMap((p) => p?.uses?.plugins ?? []))].filter(isStr).sort(byStr),
        files: filesUnder(path.join(PKG, dir)).map((f) => fileEntry(`${dir}/${f}`)).filter(Boolean),
      });
      return dir;
    };
    const pods = spec.pods.map((p) => ({
      id: String(p.id), label: isStr(p.label) ? p.label : null,
      members: p.members.map((m) => ({
        id: String(m.id), label: isStr(m.label) ? m.label : null,
        runtime: isStr(m.runtime) ? m.runtime : null,
        model: { recommended: m.model ?? null, test: testModel.get(`${p.id}.${m.id}`) ?? null },
        agent: agentOf(m.agentRef),
      })),
    }));
    const edges = [];
    for (const p of spec.pods) for (const e of p.edges ?? []) edges.push({ kind: e.kind, from: `${p.id}.${e.from}`, to: `${p.id}.${e.to}` });
    for (const e of spec.edges ?? []) edges.push({ kind: e.kind, from: e.from, to: e.to });
    const bundleOf = (b) => { const f = F.files.find((x) => x.path === b.path); return { path: b.path, sha256: f.sha256, bytes: f.bytes }; };
    return {
      id: r.id, name: spec.name, summary: isStr(spec.summary) ? spec.summary.trim() : null,
      source_dir: specDir, spec: specRel, test_spec: r.bundles.test?.spec ?? null,
      culture: spec.cultureFile ? path.posix.join(specDir, spec.cultureFile) : null,
      startup: (spec.startup?.files ?? []).map((s) => path.posix.join(specDir, s.path)),
      bundle: bundleOf(r.bundles.recommended), test_bundle: r.bundles.test ? bundleOf(r.bundles.test) : null,
      topology: { pods, edges },
      agents: [...agents.values()].sort((x, y) => byStr(x.dir, y.dir)),
    };
  });

  // 4. The one version + hash that Download and "Copy setup prompt" both use.
  const url = `${listing.source.repo}/releases/download/${listing.release.tag}/${listing.release.asset}`;
  const setupPrompt = [
    `Set up ${F.title} ${F.version}, an OpenRig factory from rigs.to.`,
    ``,
    `1. Download the archive and check its hash before unpacking. The sha256 must be exactly ${archiveSha}:`,
    `   curl -fLO ${url}`,
    `   echo "${archiveSha}  ${listing.release.asset}" | shasum -a 256 -c`,
    `2. Unpack it somewhere stable and read SETUP.md inside before running anything:`,
    `   mkdir -p ~/rig-factories && tar -xzf ${listing.release.asset} -C ~/rig-factories`,
    `   cd ~/rig-factories/${F.id}-${F.version}`,
    `3. Follow SETUP.md with the OpenRig I already run (leave my other rigs and its kernel alone): run`,
    `   node launch.mjs --project <dir> --plan-only, explain to me every permission change it prints, and launch only`,
    `   after I agree. Never pipe anything into a shell.`,
  ].join("\n");

  // "QA verified" is a maintainer record, never the author's or this importer's claim:
  // only an entry for this exact id, version AND archive sha256 stamps the snapshot.
  const vf = path.join(path.dirname(path.dirname(path.dirname(path.resolve(listingPath)))), "verified-factories.json");
  const verifiedList = fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf, "utf8")) : [];
  const verified = (Array.isArray(verifiedList) ? verifiedList : []).find((v) => v.id === F.id && v.version === F.version && v.sha256 === archiveSha) ?? null;

  const snapshot = {
    snapshot_version: SNAPSHOT_VERSION,
    id: F.id, version: F.version, content_id: F.content_id ?? null,
    title: F.title, summary: F.summary, lineage: F.lineage ?? null,
    author: F.author, license: F.license,
    source: { repo: listing.source.repo, path: listing.source.path, ref: listing.source.ref ?? null },
    archive: { asset: listing.release.asset, tag: listing.release.tag, sha256: archiveSha, bytes: fs.statSync(archivePath).size, url },
    built_by: F.built_by, openrig: F.openrig,
    parsed_by: { openrig: PARSER_CLI_VERSION, parsers: "RigSpecCodec + RigSpecSchema + AgentSpec" },
    models_test_label: F.models?.test?._label ?? null,
    rigs, context_packs: F.context_packs ?? [], starter: F.starter, prerequisites: F.prerequisites,
    permissions: F.permissions, first_job: F.first_job ?? null, expected_output: F.expected_output ?? [],
    verified: verified ? { verdict: verified.verdict, qa: verified.qa, date: verified.date, openrig: verified.openrig,
      runtimes: verified.runtimes, models: verified.models, path: verified.path } : null,
    files: F.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    setup_prompt: setupPrompt,
  };
  const out = path.join(path.dirname(listingPath), "snapshot.json");
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`OK ${F.id} ${F.version}: ${rigs.length} rig(s), ${rigs.reduce((n, r) => n + r.agents.length, 0)} AgentSpec(s), ${F.files.length} files -> ${out}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
