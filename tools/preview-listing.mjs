#!/usr/bin/env node
// Author preview — see what rigs.to will derive from your listing, BEFORE you
// open a pull request.
//
//   node tools/preview-listing.mjs bundles/<id>/rig.json [--json]
//
// It runs the SAME validator and the SAME importer registration uses, against a
// throwaway copy of your listing: nothing in this checkout is written, and no
// preview can pass here that registration would refuse. Needs Node >= 22 and
// git, plus `npm ci --prefix tools` once: the tools bring their own pinned
// OpenRig parser, so no OpenRig install is needed. Prints `FAIL: <reason>` and
// exits 1 on anything registration would refuse.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { importBundle } from "./import-bundle.mjs";

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const src = args.find((a) => !a.startsWith("--"));
  if (!src) throw new Error("usage: preview-listing.mjs bundles/<id>/rig.json [--json]");
  const srcDir = path.dirname(path.resolve(src));
  const id = path.basename(srcDir);

  // A throwaway registry: bundles/<id>/ copied as-is (descriptor + screenshots),
  // so the validator's id-equals-directory and path rules apply exactly.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rigsto-preview-"));
  try {
    const dir = path.join(tmp, "registry", "bundles", id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(srcDir, dir, { recursive: true });
    fs.rmSync(path.join(dir, "snapshot.json"), { force: true }); // a preview always imports fresh
    await importBundle({ descriptorPath: path.join(dir, "rig.json"), cacheDir: path.join(tmp, "cache") });
    const s = JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8"));
    if (json) return JSON.stringify(s, null, 2);
    return render(s);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function render(s) {
  const members = s.topology.pods.flatMap((p) => p.members.map((m) => ({ p, m })));
  const posture = new Map((s.launch_posture?.members ?? []).map((x) => [x.member, x]));
  const out = [];
  out.push(`OK — rigs.to would list '${s.id}'`, "");
  out.push(`${s.title}  by ${s.author.name}  (${s.license})`);
  out.push(`  ${s.summary}`);
  out.push(`  source  ${s.source.repo} @ ${s.source.ref.slice(0, 12)}  ${s.source.spec}`);
  out.push(`  parsed  by OpenRig ${s.parsed_by.openrig}. A preview is always "parsed, not launch-tested": maintainers add the`,
    `          launch-tested stamp only after a real launch of this exact commit.`, "");
  out.push(`Roles — ${s.topology.pods.length} pod(s), ${members.length} member(s), ${s.topology.edges.length} edge(s)`);
  for (const { p, m } of members) {
    const id = `${p.id}.${m.id}`, lp = posture.get(id);
    const post = !lp ? "" : lp.posture === "floor" ? "floor" : `policy ${lp.policy}`;
    out.push(`  ${id.padEnd(28)} ${String(m.runtime ?? "—").padEnd(12)} ${String(m.model ?? "default model").padEnd(18)} ${post}`);
  }
  for (const e of s.topology.edges) out.push(`  ${e.from} ${e.kind.replace(/_/g, " ")} ${e.to}`);
  out.push("", `Files — ${s.files.count} (${(s.files.bytes / 1024).toFixed(0)} KB): the spec's directory plus everything its members reference`);
  out.push(`Needs — OpenRig ${s.requirements.openrig.min}+; runtimes ${s.requirements.runtimes.join(", ") || "none declared"}${s.requirements.plugins.length ? `; plugins ${s.requirements.plugins.join(", ")}` : ""}`);
  if (s.risks.length) {
    out.push("", "Shown to readers before they launch:");
    for (const r of s.risks) out.push(`  • ${r.label}`);
  }
  out.push("", "Nothing was written to this checkout. To list it, open a pull request adding this directory to bundles/ and its rig.json to registry.json.");
  return out.join("\n");
}

main().then((m) => { console.log(m); process.exit(0); }, (e) => {
  console.log(`FAIL: ${String(e && e.message || e)}`);
  process.exit(1);
});
