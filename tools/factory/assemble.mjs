#!/usr/bin/env node
// Assemble a factory PACKAGE directory from a factory source tree and the
// native bundles the rigs-to-builder environment already created.
//
//   node tools/factory/assemble.mjs <factory-src-dir> <bundles-dir> <out-dir>
//
// <factory-src-dir>/factory.json declares the factory (see FACTORY-FORMAT.md).
// Everything DERIVED — each rig's members and skills, every file's hash — is
// computed here from the real files with OpenRig's own parser (the pinned
// tools/node_modules/@openrig/cli), never typed by the author. Deterministic:
// sorted keys and lists, no timestamps. The package is NEVER called a
// .rigbundle; its bundles/ directory holds the native ones.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadOpenRigParser, PARSER_CLI_VERSION } from "../import-bundle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.log(`FAIL: ${m}`); process.exit(1); };
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const walk = (root) => {
  const out = [];
  (function w(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => byStr(a.name, b.name))) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) die(`symlink not allowed in a factory package: ${path.relative(root, p)}`);
      if (e.isDirectory()) w(p); else out.push(p);
    }
  })(root);
  return out;
};
const copy = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); };
// A top-level file several rigs may contribute: identical bytes are placed once; different bytes are an error.
// Returns true when it placed a new file.
const place = (src, dst) => {
  if (fs.existsSync(dst)) {
    if (sha256(dst) !== sha256(src)) die(`two rigs ship different content for ${path.relative(outDir, dst)}`);
    return false;
  }
  copy(src, dst);
  return true;
};

const [srcDir, bundlesDir, outDir] = process.argv.slice(2);
if (!srcDir || !bundlesDir || !outDir) die("usage: assemble.mjs <factory-src-dir> <bundles-dir> <out-dir>");
const decl = JSON.parse(fs.readFileSync(path.join(srcDir, "factory.json"), "utf8"));
for (const k of ["id", "version", "title", "summary", "author", "license", "rigs", "prerequisites", "permissions"]) {
  if (!(k in decl)) die(`factory.json is missing "${k}"`);
}
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) die(`output dir is not empty: ${outDir}`);
fs.mkdirSync(outDir, { recursive: true });

const parser = await loadOpenRigParser();
const rigs = [];
const starter = [];
for (const r of decl.rigs) {
  const rigSrc = path.join(srcDir, r.dir);
  // Members and skills come from the RECOMMENDED spec as OpenRig parses it; the
  // test variant must have the same members (only models differ).
  const members = {};
  for (const [variant, file] of Object.entries(r.variants)) {
    const raw = parser.rig.parse(fs.readFileSync(path.join(rigSrc, file), "utf8"));
    const v = parser.rig.validate(raw);
    if (!v.valid) die(`${r.dir}/${file} is not a valid RigSpec: ${v.errors.join("; ")}`);
    const spec = parser.rig.normalize(raw);
    members[variant] = { name: spec.name, culture: spec.cultureFile ?? null,
      list: spec.pods.flatMap((p) => p.members.map((m) => `${p.id}.${m.id}`)).sort(byStr),
      detail: spec.pods.flatMap((p) => p.members.map((m) => ({ id: `${p.id}.${m.id}`, runtime: m.runtime ?? null, agentRef: m.agentRef ?? null }))),
      agents: [...new Set(spec.pods.flatMap((p) => p.members.map((m) => m.agentRef)).filter((a) => a?.startsWith("local:")))].sort(byStr),
      models: Object.fromEntries(spec.pods.flatMap((p) => p.members.map((m) => [`${p.id}.${m.id}`, m.model ?? "runtime default"]))) };
  }
  if (members.test && JSON.stringify(members.test.list) !== JSON.stringify(members.recommended.list)) {
    die(`${r.dir}: the test variant's members differ from the recommended spec`);
  }
  const skills = members.recommended.agents.flatMap((ref) => {
    const sd = path.join(rigSrc, ref.slice("local:".length), "skills");
    return fs.existsSync(sd) ? fs.readdirSync(sd).filter((n) => fs.existsSync(path.join(sd, n, "SKILL.md"))) : [];
  }).sort(byStr);
  const bundles = {};
  for (const [variant, file] of Object.entries(r.variants)) {
    const bname = variant === "recommended" ? `${r.id}.rigbundle` : `${r.id}.${variant}-models.rigbundle`;
    const bsrc = path.join(bundlesDir, bname);
    if (!fs.existsSync(bsrc)) die(`missing native bundle ${bname} (built by the rigs-to-builder environment)`);
    copy(bsrc, path.join(outDir, "bundles", bname));
    // The .sha256 beside a bundle is OpenRig's own digest file (a bare hash) and
    // ships byte for byte: `rig bundle inspect` validates the digest against it, and
    // rewriting it (for example into `sha256sum -c` form) makes digestValid false —
    // product 0.1.3 failed exactly that way. Check it matches, never reformat it.
    const bare = fs.readFileSync(`${bsrc}.sha256`, "utf8").trim().split(/\s+/)[0];
    if (bare !== sha256(bsrc)) die(`${bname}.sha256 does not match the bundle it sits beside`);
    copy(`${bsrc}.sha256`, path.join(outDir, "bundles", `${bname}.sha256`));
    bundles[variant] = { path: `bundles/${bname}`, spec: `source/${r.dir}/${file}` };
  }
  // starter_dir goes to starter/ (copied into the user's project); each `lift` dir
  // (e.g. context, LICENSES) goes to the package top level; the rest is source/<rig>/.
  // Several rigs may lift the same file only if its bytes are identical.
  const lift = r.lift ?? [];
  for (const f of walk(rigSrc)) {
    const rel = path.relative(rigSrc, f).split(path.sep).join("/");
    const top = rel.split("/")[0];
    if (r.starter_dir && rel.startsWith(`${r.starter_dir}/`)) {
      const to = rel.slice(r.starter_dir.length + 1);
      if (place(f, path.join(outDir, "starter", to))) starter.push({ from: `starter/${to}`, to });
    } else if (lift.includes(top) && rel !== top) place(f, path.join(outDir, rel));
    else copy(f, path.join(outDir, "source", r.dir, rel));
  }
  // Per member: its runtime, its agent dir in the package, and the skills in THAT
  // dir (projected per runtime at launch, and compared byte for byte by the launcher).
  const agentDir = (ref) => (ref?.startsWith("local:") ? path.posix.join("source", r.dir, ref.slice("local:".length)) : null);
  const skillsOf = (ref) => {
    if (!ref?.startsWith("local:")) return [];
    const sd = path.join(rigSrc, ref.slice("local:".length), "skills");
    return fs.existsSync(sd) ? fs.readdirSync(sd).filter((n) => fs.existsSync(path.join(sd, n, "SKILL.md"))).sort(byStr) : [];
  };
  const memberDetail = members.recommended.detail.map((m) => ({ id: m.id, runtime: m.runtime, agent_dir: agentDir(m.agentRef), skills: skillsOf(m.agentRef) }))
    .sort((a, b) => byStr(a.id, b.id));
  rigs.push({ id: r.id, name: members.recommended.name, culture: members.recommended.culture,
    members: members.recommended.list, member_detail: memberDetail, skills, bundles,
    models: Object.fromEntries(Object.entries(members).map(([k, v]) => [k, v.models])) });
}

// Factory-level shared material (a multi-rig factory keeps one starter/, context/
// and LICENSES/ beside its rig dirs): same mapping as the per-rig starter_dir and lift.
if (decl.starter_dir) {
  const root = path.join(srcDir, decl.starter_dir);
  if (!fs.existsSync(root)) die(`starter_dir ${decl.starter_dir} does not exist`);
  for (const f of walk(root)) {
    const to = path.relative(root, f).split(path.sep).join("/");
    if (place(f, path.join(outDir, "starter", to))) starter.push({ from: `starter/${to}`, to });
  }
}
for (const d of decl.lift ?? []) {
  const root = path.join(srcDir, d);
  if (!fs.existsSync(root)) die(`lift entry ${d} does not exist`);
  // A lifted FILE (e.g. a factory-root PERMISSIONS.md) ships at the package top level too,
  // not only quoted in SETUP.md.
  if (fs.statSync(root).isFile()) { place(root, path.join(outDir, path.basename(d))); continue; }
  for (const f of walk(root)) place(f, path.join(outDir, path.basename(d), path.relative(root, f)));
}

// Every permission file must be a starter file (the launcher places them only on request).
for (const p of decl.permissions) for (const f of p.files) {
  if (!starter.some((s) => s.to === f)) die(`permission file ${f} is not among the starter files`);
}

// Context packs: every directory under the package's context/ with a manifest.yaml.
// The launcher installs each with `rig context add` and proves every file retrievable.
const contextPacks = [];
const ctxRoot = path.join(outDir, "context");
if (fs.existsSync(ctxRoot)) for (const d of fs.readdirSync(ctxRoot).sort(byStr)) {
  const man = path.join(ctxRoot, d, "manifest.yaml");
  if (!fs.existsSync(man)) continue;
  const text = fs.readFileSync(man, "utf8");
  const name = text.match(/^name:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  if (!name) die(`context/${d}/manifest.yaml has no name`);
  // 0.6.1's `rig context add` refuses a manifest without taxonomy, or files given as bare names.
  if (!/^taxonomy:\s*\S/m.test(text)) die(`context/${d}/manifest.yaml has no taxonomy (rig context add refuses it)`);
  const files = [...text.matchAll(/^\s*-\s*path:\s*["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  if (!files.length) die(`context/${d}/manifest.yaml lists no files as {path, role} entries`);
  for (const f of files) if (!fs.existsSync(path.join(ctxRoot, d, f))) die(`context/${d}/manifest.yaml lists ${f}, which is not in the pack`);
  contextPacks.push({ name, path: `context/${d}`, files });
}

// The launcher and setup prompt ship verbatim from these tools.
copy(path.join(HERE, "launch.mjs"), path.join(outDir, "launch.mjs"));
copy(path.join(HERE, "TESTING.md"), path.join(outDir, "TESTING.md"));
// SETUP.md: the generic setup prompt, then — verbatim, attributed — the
// author's own plain-language permissions doc, if the factory declares one.
let setup = fs.readFileSync(path.join(HERE, "SETUP.md"), "utf8");
if (decl.permissions_doc) {
  const doc = fs.readFileSync(path.join(srcDir, decl.permissions_doc), "utf8").replace(/\n+$/, "");
  // Byte for byte: the author's file follows the separator unchanged, headings included.
  setup += `\n---\n\n**This factory's permission changes, from the factory's author, verbatim (\`${path.basename(decl.permissions_doc)}\`).** ` +
    `The launcher shows these and applies them only with \`--apply-permissions\`.\n\n` + doc + "\n";
}
// An adaptation's attribution (and any optional upstream setup it describes) also
// follows byte for byte. Nothing in it is run by the launcher.
if (decl.attribution_doc) {
  const doc = fs.readFileSync(path.join(srcDir, decl.attribution_doc), "utf8").replace(/\n+$/, "");
  setup += `\n---\n\n**Attribution, from the factory's author, verbatim (\`${path.basename(decl.attribution_doc)}\`).** ` +
    `Any upstream setup it describes is optional, run only by you if you choose, and never by the launcher or the agents.\n\n` + doc + "\n";
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "SETUP.md"), setup);
for (const l of decl.licenses ?? []) copy(path.join(srcDir, l.from), path.join(outDir, "LICENSES", l.to));

// Per-file licence: the first file_licenses rule whose `match` occurs in the path,
// else file_license_default (else the factory licence). Declared by the author.
const licenseOf = (rel) => (decl.file_licenses ?? []).find((r) => rel.includes(r.match))?.license ?? decl.file_license_default ?? decl.license;
const files = walk(outDir).map((p) => path.relative(outDir, p).split(path.sep).join("/")).sort(byStr)
  .map((rel) => ({ path: rel, sha256: sha256(path.join(outDir, rel)), bytes: fs.statSync(path.join(outDir, rel)).size,
    ...(decl.file_licenses ? { license: licenseOf(rel) } : {}) }));

// content_id: one hash over every packaged file's path and sha256, so two builds
// with any byte difference never share an identity, whatever their version label.
const contentId = crypto.createHash("sha256").update(files.map((f) => `${f.sha256}  ${f.path}\n`).join("")).digest("hex");

const factory = {
  package_format: 1,
  id: decl.id, version: decl.version, content_id: contentId, title: decl.title, summary: decl.summary,
  author: decl.author, license: decl.license, source: decl.source ?? null, lineage: decl.lineage ?? null,
  built_by: "the rigs-to-builder packaging environment (native bundles stamp sourceHost \"rigs-to-builder\")",
  openrig: { min: decl.openrig?.min ?? "0.6.1", tested: decl.openrig?.tested ?? null, parser: PARSER_CLI_VERSION },
  rigs,
  models: { test: { _label: "TEST — cheap smoke-test models; the recommended configuration is the default" } },
  context_packs: contextPacks,
  starter: starter.sort((a, b) => byStr(a.to, b.to)),
  prerequisites: decl.prerequisites,
  permissions: decl.permissions,
  first_job: decl.first_job ?? null,
  expected_output: decl.expected_output ?? [],
  files,
};
fs.writeFileSync(path.join(outDir, "FACTORY.json"), JSON.stringify(factory, null, 2) + "\n");
console.log(`OK ${decl.id} ${decl.version}: ${rigs.length} rig(s), ${contextPacks.length} context pack(s), ${files.length} files, content_id ${contentId}`);
