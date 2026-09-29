#!/usr/bin/env node
// rigs-to-apps validator — the validator IS the schema (SCHEMA.md documents
// it; no separate JSON-Schema file to drift). Node standard library only.
//
// Two modes:
//   node tools/validate.mjs <path/to/app.json>      -> validate one manifest
//   node tools/validate.mjs --registry <list.json>  -> validate a bare registry list
//
// On success prints `OK <id>` / `OK registry (<n> manifest[s])` and exits 0.
// On the FIRST violation prints `FAIL: <reason>` and exits 1. Checks run in a
// fixed order so an id-matching fixture isolates exactly one intended defect:
//   parse -> prototype-pollution guard -> object shape -> id (== dir name) ->
//   unknown-field scan (every object level) -> required fields/types ->
//   field-scoped value+path rules.
//
// Field-scoped path safety (do NOT apply one rule to every path-like field):
//   - relative-file-INSIDE-app-dir AND must-EXIST: media.screenshots[].src,
//     relative media.demo, install.surface.entry. Rejects `..`/absolute
//     (lexical) first, then absence, then a realpath ESCAPE (an in-tree symlink
//     resolving outside the app dir) — realpath BEFORE containment, so the
//     serve-shell.mjs `startsWith(HERE)` idiom cannot be bypassed by a symlink.
//   - install.surface.path: absolute URL route (leading /, reject ../?/#).
//   - install.destination: must equal `~/studio/apps/<id>` exactly.
//   - install.server.command: an instruction string, NOT path-resolved.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };

const CATEGORIES = ["create", "build", "grow", "system"];
const METHODS = ["GET", "POST"];
const PROTO_KEYS = ["__proto__", "constructor", "prototype"];

// Known keys per object level. A key outside its level's set fails (this also
// catches every forbidden family: source|version|pricing|deps|dependencies|
// review|fork|forked_from|stats|installs|forks|stars|readme — all "unknown").
const KNOWN = {
  root: ["manifest_version", "id", "name", "summary", "category", "maker", "media", "install", "verbs"],
  maker: ["name", "url"],
  media: ["screenshots", "demo"],
  screenshot: ["src", "alt"],
  install: ["destination", "surface", "server", "verify"],
  surface: ["entry", "path", "glyph", "hint"],
  server: ["command", "port"],
  port: ["env", "preferred"],
  verb: ["method", "path", "purpose"],
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const kebab = (s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);

// Deep prototype-pollution guard: JSON.parse DOES create an own "__proto__"
// key (unlike an object literal), so getOwnPropertyNames surfaces it.
function guardProto(v) {
  if (Array.isArray(v)) { for (const x of v) guardProto(x); return; }
  if (isObj(v)) {
    for (const k of Object.getOwnPropertyNames(v)) {
      if (PROTO_KEYS.includes(k)) fail(`prototype-pollution key '${k}' rejected`);
      guardProto(v[k]);
    }
  }
}

// A key outside the level's known set fails; report the offending key name.
function unknownScan(obj, known) {
  for (const k of Object.keys(obj)) if (!known.includes(k)) fail(`unknown field '${k}'`);
}

// --- field-scoped path rules --------------------------------------------

// Relative file that must sit inside `appDirReal` (realpath'd), EXIST, and be a
// REGULAR FILE. realpath BEFORE containment defeats an in-tree symlink escape;
// the isFile() gate defeats a directory named like a file (e.g. `entry.html/`).
function checkRelFileInside(field, rel, appDirReal) {
  if (!isStr(rel)) fail(`${field} must be a string`);
  if (rel === "" || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    fail(`path escapes app dir: ${field}`);
  }
  const candidate = path.resolve(appDirReal, rel);
  if (!fs.existsSync(candidate)) fail(`referenced file absent: ${field}`);
  let real;
  try { real = fs.realpathSync(candidate); } catch { fail(`referenced file absent: ${field}`); }
  if (real !== appDirReal && !real.startsWith(appDirReal + path.sep)) {
    fail(`path escapes app dir: ${field}`);
  }
  if (!fs.statSync(real).isFile()) fail(`not a regular file: ${field}`);
}

function checkSurfacePath(p) {
  if (!isStr(p)) fail("install.surface.path must be a string");
  if (!p.startsWith("/") || p.includes("..") || p.includes("?") || p.includes("#")) {
    fail("surface.path must be an absolute route (leading /, no ../?/#)");
  }
}

// --- manifest validation -------------------------------------------------

function validateManifest(manifestPath) {
  let raw;
  try { raw = fs.readFileSync(manifestPath, "utf8"); }
  catch { fail(`cannot read manifest: ${manifestPath}`); }
  let m;
  try { m = JSON.parse(raw); }
  catch (e) { fail(`invalid JSON: ${String(e.message)}`); }

  guardProto(m);
  if (!isObj(m)) fail("manifest must be a JSON object");

  // id == the name of the directory CONTAINING app.json (before field errors).
  const appDir = path.dirname(path.resolve(manifestPath));
  const appDirReal = fs.realpathSync(appDir);
  const dirName = path.basename(appDirReal);
  if (!isStr(m.id)) fail("id must be a string");
  if (!kebab(m.id)) fail("id must be lowercase-kebab");
  if (m.id !== dirName) fail(`id must equal the app directory name ('${dirName}')`);

  // Unknown-field scan at every object level (fires before missing-required).
  unknownScan(m, KNOWN.root);
  if (isObj(m.maker)) unknownScan(m.maker, KNOWN.maker);
  if (isObj(m.media)) unknownScan(m.media, KNOWN.media);
  if (isObj(m.media) && Array.isArray(m.media.screenshots))
    for (const s of m.media.screenshots) if (isObj(s)) unknownScan(s, KNOWN.screenshot);
  if (isObj(m.install)) unknownScan(m.install, KNOWN.install);
  if (isObj(m.install) && isObj(m.install.surface)) unknownScan(m.install.surface, KNOWN.surface);
  if (isObj(m.install) && isObj(m.install.server)) {
    unknownScan(m.install.server, KNOWN.server);
    if (isObj(m.install.server.port)) unknownScan(m.install.server.port, KNOWN.port);
  }
  if (Array.isArray(m.verbs)) for (const v of m.verbs) if (isObj(v)) unknownScan(v, KNOWN.verb);

  // manifest_version — known value only (v1 = 1).
  if (!isInt(m.manifest_version)) fail("manifest_version must be an integer");
  if (m.manifest_version !== 1) fail(`unknown manifest_version ${m.manifest_version}`);

  // Simple required strings.
  for (const k of ["name", "summary", "category"]) if (!isStr(m[k])) fail(`${k} must be a string`);
  if (!CATEGORIES.includes(m.category)) fail(`category not in {${CATEGORIES.join(",")}}`);

  // maker { name, url } both required.
  if (!isObj(m.maker)) fail("maker must be an object");
  if (!isStr(m.maker.name) || !isStr(m.maker.url)) fail("maker requires name + url");

  // media object required; screenshots required array (may be []); demo optional.
  if (!isObj(m.media)) fail("media object is required");
  if (!Array.isArray(m.media.screenshots)) fail("media.screenshots must be an array (may be [])");
  for (const s of m.media.screenshots) {
    if (!isObj(s) || !isStr(s.src) || !isStr(s.alt)) fail("each screenshot needs src + alt");
    checkRelFileInside("media.screenshots[].src", s.src, appDirReal);
  }
  if ("demo" in m.media) {
    const d = m.media.demo;
    if (!isStr(d)) fail("media.demo must be a string");
    const scheme = d.match(/^([a-z][a-z0-9+.-]*):/i);
    if (scheme) { if (!d.startsWith("https://")) fail("demo must be relative or https"); }
    else checkRelFileInside("media.demo", d, appDirReal);
  }

  // install
  if (!isObj(m.install)) fail("install must be an object");
  if (!isStr(m.install.destination)) fail("install.destination must be a string");
  if (m.install.destination !== `~/studio/apps/${m.id}`) fail("destination must be ~/studio/apps/<id>");

  if (!isObj(m.install.surface)) fail("install.surface must be an object");
  const surf = m.install.surface;
  if (!isStr(surf.entry)) fail("install.surface.entry must be a string");
  if (!/\.html?$/i.test(surf.entry)) fail("install.surface.entry must be an .html file");
  checkRelFileInside("install.surface.entry", surf.entry, appDirReal);
  checkSurfacePath(surf.path);
  if (!isStr(surf.glyph)) fail("install.surface.glyph must be a string");
  if ("hint" in surf && !isStr(surf.hint)) fail("install.surface.hint must be a string");
  // hint defaults to summary when absent (documented; not a failure).

  if ("server" in m.install) {
    const sv = m.install.server;
    if (!isObj(sv)) fail("install.server must be an object");
    if (!isStr(sv.command)) fail("install.server.command must be a string");
    if (!isObj(sv.port) || !isStr(sv.port.env) || !isInt(sv.port.preferred))
      fail("install.server.port requires { env, preferred:int }");
  }

  if (!Array.isArray(m.install.verify) || m.install.verify.length === 0)
    fail("install.verify must be a non-empty array");
  for (const v of m.install.verify) if (!isStr(v)) fail("install.verify entries must be strings");

  // verbs
  if (!Array.isArray(m.verbs)) fail("verbs must be an array");
  for (const v of m.verbs) {
    if (!isObj(v)) fail("each verb must be an object");
    if (!METHODS.includes(v.method)) fail(`verb method not in {${METHODS.join(",")}}`);
    if (!isStr(v.path) || !isStr(v.purpose)) fail("each verb needs path + purpose");
  }

  // Fixed README convention — never named in the manifest; the dir must carry a
  // README.md that is a REGULAR FILE (a directory named README.md is not it).
  const readmePath = path.join(appDirReal, "README.md");
  if (!fs.existsSync(readmePath)) fail("missing README.md");
  if (!fs.statSync(readmePath).isFile()) fail("README.md must be a regular file");

  return m.id;
}

// --- rig-bundle descriptor validation ------------------------------------
//
// A rig-bundle listing is a SMALL presentation descriptor at
// bundles/<id>/rig.json. It never restates runtime truth: pods, members,
// edges, agents and files are DERIVED at import from the author's real spec
// (OpenRig's own parser + `rig bundle inspect`), so any key naming them is
// unknown here and fails. Same discipline as app.json: fail-first, unknown
// keys at every level, field-scoped path safety.

const RIG_KNOWN = {
  root: ["descriptor_version", "kind", "id", "title", "summary", "tags", "author", "license", "source", "media"],
  author: ["name", "url"],
  source: ["repo", "ref", "spec", "bundle"],
  media: ["screenshots"],
  screenshot: ["src", "alt"],
};
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const LICENSE = /^[A-Za-z0-9.+-]{1,64}$/; // an SPDX id, or NOASSERTION
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOTS = 6;
const MAX_TAGS = 8;

// source.spec lives in the AUTHOR'S repo, so only its lexical shape is
// checkable here; the importer re-checks it against the fetched checkout
// with realpath containment.
function checkRepoRelative(field, rel, ext = /\.ya?ml$/, what = "a .yaml rig spec") {
  if (!isStr(rel) || rel === "") fail(`${field} must be a non-empty string`);
  if (rel.length > 300) fail(`${field} is too long`);
  const segs = rel.split("/");
  if (path.isAbsolute(rel) || rel.includes("\\") || segs.includes("..") || segs.includes(".")) {
    fail(`path escapes source repo: ${field}`);
  }
  if (!ext.test(rel)) fail(`${field} must name ${what}`);
}

function validateRigDescriptor(descriptorPath, { requireSnapshot = false } = {}) {
  let stat;
  try { stat = fs.statSync(descriptorPath); } catch { fail(`cannot read descriptor: ${descriptorPath}`); }
  if (stat.size > MAX_DESCRIPTOR_BYTES) fail(`descriptor too large (${stat.size} > ${MAX_DESCRIPTOR_BYTES} bytes)`);
  let d;
  try { d = JSON.parse(fs.readFileSync(descriptorPath, "utf8")); }
  catch (e) { fail(`invalid JSON: ${String(e.message)}`); }

  guardProto(d);
  if (!isObj(d)) fail("descriptor must be a JSON object");

  const dirReal = fs.realpathSync(path.dirname(path.resolve(descriptorPath)));
  const dirName = path.basename(dirReal);
  if (!isStr(d.id)) fail("id must be a string");
  if (!kebab(d.id)) fail("id must be lowercase-kebab");
  if (d.id !== dirName) fail(`id must equal the bundle directory name ('${dirName}')`);

  unknownScan(d, RIG_KNOWN.root);
  if (isObj(d.author)) unknownScan(d.author, RIG_KNOWN.author);
  if (isObj(d.source)) unknownScan(d.source, RIG_KNOWN.source);
  if (isObj(d.media)) unknownScan(d.media, RIG_KNOWN.media);
  if (isObj(d.media) && Array.isArray(d.media.screenshots))
    for (const s of d.media.screenshots) if (isObj(s)) unknownScan(s, RIG_KNOWN.screenshot);

  if (!isInt(d.descriptor_version)) fail("descriptor_version must be an integer");
  if (d.descriptor_version !== 1) fail(`unknown descriptor_version ${d.descriptor_version}`);
  if (d.kind !== "rig-bundle") fail("kind must be \"rig-bundle\"");

  if (!isStr(d.title) || d.title.trim() === "" || d.title.length > 80) fail("title must be a non-empty string of at most 80 chars");
  if (!isStr(d.summary) || d.summary.trim() === "" || d.summary.length > 240) fail("summary must be a non-empty string of at most 240 chars");

  if (!Array.isArray(d.tags)) fail("tags must be an array (may be [])");
  if (d.tags.length > MAX_TAGS) fail(`at most ${MAX_TAGS} tags`);
  for (const t of d.tags) if (!isStr(t) || !kebab(t)) fail("each tag must be lowercase-kebab");
  if (new Set(d.tags).size !== d.tags.length) fail("duplicate tag");

  if (!isObj(d.author)) fail("author must be an object");
  if (!isStr(d.author.name) || d.author.name.trim() === "") fail("author requires name + url");
  if (!isStr(d.author.url) || !d.author.url.startsWith("https://")) fail("author.url must be an https URL");

  if (!isStr(d.license) || !LICENSE.test(d.license)) fail("license must be an SPDX identifier (or NOASSERTION)");

  if (!isObj(d.source)) fail("source must be an object");
  if (!isStr(d.source.repo) || !GITHUB_REPO.test(d.source.repo) || d.source.repo.endsWith(".git"))
    fail("source.repo must be a public https://github.com/<owner>/<repo> URL");
  if (!isStr(d.source.ref) || !FULL_SHA.test(d.source.ref))
    fail("source.ref must be a full 40-character commit SHA (branches and tags move; a listing pins)");
  // spec is the primary route (a pinned rig.yaml entrypoint); bundle is an
  // OPTIONAL prebuilt .rigbundle in the same repo at the same pin.
  checkRepoRelative("source.spec", d.source.spec);
  if ("bundle" in d.source) checkRepoRelative("source.bundle", d.source.bundle, /\.rigbundle$/, "a .rigbundle file");

  if (!isObj(d.media)) fail("media object is required");
  if (!Array.isArray(d.media.screenshots)) fail("media.screenshots must be an array (may be [])");
  if (d.media.screenshots.length > MAX_SCREENSHOTS) fail(`at most ${MAX_SCREENSHOTS} screenshots`);
  for (const s of d.media.screenshots) {
    if (!isObj(s) || !isStr(s.src) || !isStr(s.alt) || s.alt.trim() === "") fail("each screenshot needs src + alt");
    if (!IMAGE_EXT.test(s.src)) fail("media.screenshots[].src must be a png/jpg/webp/gif image");
    checkRelFileInside("media.screenshots[].src", s.src, dirReal);
    if (fs.statSync(path.resolve(dirReal, s.src)).size > MAX_SCREENSHOT_BYTES)
      fail(`screenshot too large (> ${MAX_SCREENSHOT_BYTES} bytes): ${s.src}`);
  }

  // A LISTED bundle must have a successful import beside it — the site renders
  // the snapshot, never the descriptor alone. A snapshot at an OLDER ref than
  // the descriptor is allowed: that is a pending refresh, and the page shows
  // the last good import with its own pinned ref.
  if (requireSnapshot) {
    const snap = path.join(dirReal, "snapshot.json");
    if (!fs.existsSync(snap) || !fs.statSync(snap).isFile()) fail(`no snapshot.json for '${d.id}' — run tools/import-bundle.mjs`);
    let s;
    try { s = JSON.parse(fs.readFileSync(snap, "utf8")); } catch (e) { fail(`snapshot.json for '${d.id}' is invalid JSON: ${String(e.message)}`); }
    guardProto(s);
    if (!isObj(s) || s.id !== d.id) fail(`snapshot.json id does not match descriptor '${d.id}'`);
  }
  return d.id;
}

// Which kind a registry entry is, by its fixed filename. Only these two.
function kindOf(entry) {
  const base = entry.split(/[\\/]/).pop();
  if (base === "app.json") return "app";
  if (base === "rig.json") return "rig-bundle";
  fail(`registry entry must name an app.json or rig.json: ${entry}`);
}

// --- registry validation -------------------------------------------------

function validateRegistry(registryPath) {
  const REGISTRY_ROOT = fs.realpathSync(
    process.env.REGISTRY_ROOT ? path.resolve(process.env.REGISTRY_ROOT) : process.cwd(),
  );
  let list;
  try { list = JSON.parse(fs.readFileSync(registryPath, "utf8")); }
  catch (e) { fail(`invalid JSON: ${String(e.message)}`); }
  if (!Array.isArray(list)) fail("registry must be a bare list of manifest paths");
  for (const entry of list) {
    if (!isStr(entry)) fail("registry must be a bare list of manifest paths");
    if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
      fail("registry path escapes root (absolute or ..)");
    }
  }
  // Every entry passed the bare-path gate; now validate each referenced manifest
  // and enforce app-id UNIQUENESS across the list (the id is the app's identity,
  // so two entries resolving to the same id — same path or distinct paths with
  // the same leaf dir — is a collision).
  const seenIds = new Set();
  for (const entry of list) {
    const mp = path.resolve(REGISTRY_ROOT, entry);
    const real = fs.existsSync(mp) ? fs.realpathSync(mp) : null;
    if (!real || (real !== REGISTRY_ROOT && !real.startsWith(REGISTRY_ROOT + path.sep))) {
      fail("registry path escapes root (absolute or ..)");
    }
    // Ids are unique WITHIN a kind. An app and a rig may share one (the same
    // project can be both a Studio app and a rig): their pages live at
    // apps/<id>/ and rigs/<id>/, and the site links the pair.
    const kind = kindOf(entry);
    const id = kind === "rig-bundle" ? validateRigDescriptor(mp, { requireSnapshot: true }) : validateManifest(mp);
    const key = `${kind}:${id}`;
    if (seenIds.has(key)) fail(`duplicate ${kind === "app" ? "app" : "rig"} id '${id}'`);
    seenIds.add(key);
  }
  const n = list.length;
  return `registry (${n} manifest${n === 1 ? "" : "s"})`;
}

// --- CLI -----------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--registry") {
    const p = args[1];
    if (!p) fail("usage: validate.mjs --registry <list.json>");
    return `OK ${validateRegistry(p)}`;
  }
  const p = args[0];
  if (!p) fail("usage: validate.mjs <app.json|rig.json> | --registry <list.json>");
  return `OK ${kindOf(p) === "rig-bundle" ? validateRigDescriptor(p) : validateManifest(p)}`;
}

try {
  console.log(main());
  process.exit(0);
} catch (e) {
  if (e instanceof Fail) { console.log(`FAIL: ${e.message}`); process.exit(1); }
  console.log(`FAIL: ${String(e && e.message || e)}`);
  process.exit(1);
}
