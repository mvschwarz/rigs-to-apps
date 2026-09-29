#!/usr/bin/env node
// Private-path gate: runs BEFORE any `rig bundle create`.
//
//   node tools/factory/precheck.mjs <factory-src-dir>
//
// `rig bundle create`'s own check misses /Users, ~ and absolute cwd values, so
// this refuses them in everything a seat is launched from: every rig spec
// variant, every AgentSpec it references, every startup file (rig-level and
// per agent) and the culture file. It names the file and line of each hit.
// Vendored third-party skill docs are out of scope (they may legitimately show
// `~/.cache`-style examples); the specs that DECIDE where a seat runs are in.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadOpenRigParser } from "../import-bundle.mjs";

const src = process.argv[2];
if (!src) { console.log("FAIL: usage: precheck.mjs <factory-src-dir>"); process.exit(2); }
const decl = JSON.parse(fs.readFileSync(path.join(src, "factory.json"), "utf8"));
const parser = await loadOpenRigParser();

const PATTERNS = [
  [/\/Users\//, "a macOS home path (/Users/…)"],
  [/\/home\/[^/\s"'`]+\//, "a Linux home path (/home/<user>/…)"],
  [/(^|[\s"'`=:(\[])~\//, "a home-relative path (~/…)"],
];
const hits = [];
const seen = new Set(); // a startup file shared by both model variants is scanned once
const scan = (file, label) => {
  if (!fs.existsSync(file) || seen.has(file)) return;
  seen.add(file);
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    for (const [re, what] of PATTERNS) if (re.test(line)) hits.push(`${label}:${i + 1}: ${what}: ${line.trim().slice(0, 120)}`);
  });
};

for (const r of decl.rigs) {
  const rigDir = path.join(src, r.dir);
  const agents = new Set();
  for (const file of Object.values(r.variants)) {
    const specPath = path.join(rigDir, file);
    const rel = path.join(r.dir, file);
    scan(specPath, rel);
    const spec = parser.rig.normalize(parser.rig.parse(fs.readFileSync(specPath, "utf8")));
    for (const p of spec.pods) for (const m of p.members) {
      if (typeof m.cwd === "string" && (m.cwd.startsWith("/") || m.cwd.startsWith("~"))) {
        hits.push(`${rel}: member ${p.id}.${m.id} has an absolute cwd (${m.cwd}) — use "." or a relative path`);
      }
      if (typeof m.agentRef === "string" && m.agentRef.startsWith("local:")) agents.add(m.agentRef.slice("local:".length));
    }
    for (const f of spec.startup?.files ?? []) scan(path.join(rigDir, f.path), path.join(r.dir, f.path));
    if (spec.cultureFile) scan(path.join(rigDir, spec.cultureFile), path.join(r.dir, spec.cultureFile));
  }
  // Starter files and context packs are copied or installed on the user's machine too.
  for (const d of [r.starter_dir, ...(r.lift ?? []).filter((x) => x !== "LICENSES")].filter(Boolean)) {
    const root = path.join(rigDir, d);
    if (!fs.existsSync(root)) continue;
    const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).sort().forEach((n) => walk(path.join(p, n))) : scan(p, path.relative(src, p));
    walk(root);
  }
  for (const a of [...agents].sort()) {
    const agentYaml = path.join(rigDir, a, "agent.yaml");
    const rel = path.join(r.dir, a, "agent.yaml");
    scan(agentYaml, rel);
    if (!fs.existsSync(agentYaml)) continue;
    const spec = parser.agent.normalize(parser.agent.parse(fs.readFileSync(agentYaml, "utf8")));
    for (const f of spec.startup?.files ?? []) scan(path.join(rigDir, a, f.path), path.join(r.dir, a, f.path));
    for (const g of spec.resources?.guidance ?? []) scan(path.join(rigDir, a, g.path), path.join(r.dir, a, g.path));
  }
}

// Factory-level starter and lifted dirs (shared by several rigs).
for (const d of [decl.starter_dir, ...(decl.lift ?? []).filter((x) => path.basename(x) !== "LICENSES")].filter(Boolean)) {
  const root = path.join(src, d);
  if (!fs.existsSync(root)) continue;
  const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).sort().forEach((n) => walk(path.join(p, n))) : scan(p, path.relative(src, p));
  walk(root);
}

if (hits.length) {
  console.log(`FAIL: ${hits.length} private or absolute path(s) in what the seats launch from:`);
  for (const h of hits) console.log(`  ${h}`);
  process.exit(1);
}
console.log("OK no private or absolute paths in specs, AgentSpecs, startup files or culture");
