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
// An SPDX license EXPRESSION, for factories that combine licences (e.g. an adaptation:
// "Apache-2.0 AND MIT"): ids joined by AND / OR (an id may carry "WITH <exception>"),
// with balanced parentheses. At most 200 chars.
function isSpdxExpression(x) {
  if (!isStr(x) || x.length > 200) return false;
  const toks = x.replace(/[()]/g, " $& ").trim().split(/\s+/);
  let i = 0;
  const id = () => (LICENSE.test(toks[i] ?? "") && !["AND", "OR", "WITH"].includes(toks[i]) ? (i++, true) : false);
  const term = () => {
    if (toks[i] === "(") { i++; if (!expr() || toks[i] !== ")") return false; i++; return true; }
    if (!id()) return false;
    if (toks[i] === "WITH") { i++; return id(); }
    return true;
  };
  const expr = () => { if (!term()) return false; while (toks[i] === "AND" || toks[i] === "OR") { i++; if (!term()) return false; } return true; };
  return expr() && i === toks.length;
}
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

// --- factory listing validation -----------------------------------------
//
// A factory listing is a SMALL descriptor at factories/<id>/listing.json naming
// ONE released archive by tag, asset name and sha256. Everything shown about the
// factory is derived from that exact archive by tools/import-factory.mjs into
// snapshot.json. source.ref stays null until the Release Manager records the
// source commit; the tested archive is never repacked to carry it.

const FACTORY_KNOWN = {
  root: ["descriptor_version", "kind", "id", "title", "summary", "tags", "author", "license", "source", "release", "media"],
  author: ["name", "url"],
  source: ["repo", "path", "ref"],
  release: ["tag", "asset", "sha256"],
  media: ["showcase"],
  showcase: ["src", "poster", "caption", "version"],
};
const MAX_SHOWCASE_BYTES = 8 * 1024 * 1024;
const MAX_POSTER_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

function validateFactoryListing(listingPath, { requireSnapshot = false } = {}) {
  let stat;
  try { stat = fs.statSync(listingPath); } catch { fail(`cannot read listing: ${listingPath}`); }
  if (stat.size > MAX_DESCRIPTOR_BYTES) fail(`listing too large (${stat.size} > ${MAX_DESCRIPTOR_BYTES} bytes)`);
  let d;
  try { d = JSON.parse(fs.readFileSync(listingPath, "utf8")); } catch (e) { fail(`invalid JSON: ${String(e.message)}`); }
  guardProto(d);
  if (!isObj(d)) fail("listing must be a JSON object");
  const dirReal = fs.realpathSync(path.dirname(path.resolve(listingPath)));
  if (!isStr(d.id) || !kebab(d.id)) fail("id must be lowercase-kebab");
  if (d.id !== path.basename(dirReal)) fail(`id must equal the factory directory name ('${path.basename(dirReal)}')`);
  unknownScan(d, FACTORY_KNOWN.root);
  for (const k of ["author", "source", "release"]) { if (!isObj(d[k])) fail(`${k} must be an object`); unknownScan(d[k], FACTORY_KNOWN[k]); }
  if (d.descriptor_version !== 1) fail(`unknown descriptor_version ${d.descriptor_version}`);
  if (d.kind !== "factory") fail("kind must be \"factory\"");
  if (!isStr(d.title) || d.title.trim() === "" || d.title.length > 80) fail("title must be a non-empty string of at most 80 chars");
  if (!isStr(d.summary) || d.summary.trim() === "" || d.summary.length > 240) fail("summary must be a non-empty string of at most 240 chars");
  if (!Array.isArray(d.tags) || d.tags.length > MAX_TAGS) fail(`tags must be an array of at most ${MAX_TAGS}`);
  for (const t of d.tags) if (!isStr(t) || !kebab(t)) fail("each tag must be lowercase-kebab");
  if (new Set(d.tags).size !== d.tags.length) fail("duplicate tag");
  if (!isStr(d.author.name) || d.author.name.trim() === "") fail("author requires name + url");
  if (!isStr(d.author.url) || !d.author.url.startsWith("https://")) fail("author.url must be an https URL");
  if (!isSpdxExpression(d.license)) fail("license must be an SPDX identifier or expression (e.g. \"Apache-2.0 AND MIT\")");
  if (!isStr(d.source.repo) || !GITHUB_REPO.test(d.source.repo)) fail("source.repo must be a public https://github.com/<owner>/<repo> URL");
  if (d.source.path !== `factories/${d.id}/`) fail(`source.path must be "factories/${d.id}/"`);
  if (d.source.ref !== null && !(isStr(d.source.ref) && FULL_SHA.test(d.source.ref))) fail("source.ref must be null (until publication) or a full 40-character commit SHA");
  const m = isStr(d.release.tag) ? d.release.tag.match(/^(.+)-v(\d+\.\d+\.\d+)$/) : null;
  if (!m || m[1] !== d.id || !SEMVER.test(m[2])) fail(`release.tag must be "${d.id}-v<major.minor.patch>"`);
  if (d.release.asset !== `${d.id}-${m[2]}.tar.gz`) fail(`release.asset must be "${d.id}-${m[2]}.tar.gz"`);
  if (!isStr(d.release.sha256) || !SHA256.test(d.release.sha256)) fail("release.sha256 must be a 64-character lowercase hex sha256");
  // Optional showcase: output the factory's OWN agents made in a verified run, stored beside the listing.
  if ("media" in d) {
    if (!isObj(d.media)) fail("media must be an object");
    unknownScan(d.media, FACTORY_KNOWN.media);
    const sc = d.media.showcase;
    if (sc !== undefined) {
      if (!isObj(sc)) fail("media.showcase must be an object");
      unknownScan(sc, FACTORY_KNOWN.showcase);
      if (!isStr(sc.src) || !/\.mp4$/i.test(sc.src)) fail("media.showcase.src must be an .mp4 file beside the listing");
      if (!isStr(sc.poster) || !/\.(png|jpe?g|webp)$/i.test(sc.poster)) fail("media.showcase.poster must be a png/jpg/webp image beside the listing");
      checkRelFileInside("media.showcase.src", sc.src, dirReal);
      checkRelFileInside("media.showcase.poster", sc.poster, dirReal);
      if (fs.statSync(path.resolve(dirReal, sc.src)).size > MAX_SHOWCASE_BYTES) fail(`media.showcase.src is larger than ${MAX_SHOWCASE_BYTES} bytes`);
      if (fs.statSync(path.resolve(dirReal, sc.poster)).size > MAX_POSTER_BYTES) fail(`media.showcase.poster is larger than ${MAX_POSTER_BYTES} bytes`);
      if (!isStr(sc.caption) || sc.caption.trim() === "" || sc.caption.length > 240) fail("media.showcase.caption must be a non-empty string of at most 240 chars");
      if (!isStr(sc.version) || !SEMVER.test(sc.version)) fail("media.showcase.version must name the factory version whose agents made it");
    }
  }
  if (requireSnapshot) {
    const snap = path.join(dirReal, "snapshot.json");
    if (!fs.existsSync(snap)) fail(`no snapshot.json for '${d.id}' — run tools/import-factory.mjs`);
    let s;
    try { s = JSON.parse(fs.readFileSync(snap, "utf8")); } catch (e) { fail(`snapshot.json for '${d.id}' is invalid JSON: ${String(e.message)}`); }
    guardProto(s);
    if (!isObj(s) || s.id !== d.id) fail(`snapshot.json id does not match listing '${d.id}'`);
    if (s.version !== m[2]) fail(`snapshot.json is version ${s.version}, but the listing's release is ${m[2]}`);
    if (!isObj(s.archive) || s.archive.sha256 !== d.release.sha256 || s.archive.asset !== d.release.asset || s.archive.tag !== d.release.tag)
      fail(`snapshot.json for '${d.id}' was imported from a different archive than the listing names — re-run tools/import-factory.mjs`);
  }
  return d.id;
}

// verified-factories.json (registry root, MAINTAINER-owned, written only after an
// independent QA SHIP): one entry per SHIPPED archive, bound to its exact bytes.
// A factory page shows "QA verified" only when an entry's id, version AND sha256
// all equal its listing's release — a new archive loses the stamp until re-verified.
const VERIFIED_FACTORY_KEYS = ["id", "version", "sha256", "verdict", "qa", "date", "openrig", "runtimes", "models", "path"];
// Optional, and only together: when the agents ran an EARLIER version and this exact archive was verified as a
// delta over that run, the record says so, so the page never implies an agent run of this version.
const VERIFIED_FACTORY_OPTIONAL = ["agent_run_version", "delta_qa"];
function validateVerifiedFactories(root) {
  const p = path.join(root, "verified-factories.json");
  if (!fs.existsSync(p)) return 0;
  let list;
  try { list = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { fail(`verified-factories.json is invalid JSON: ${String(e.message)}`); }
  guardProto(list);
  if (!Array.isArray(list)) fail("verified-factories.json must be a list");
  const seen = new Set();
  for (const v of list) {
    if (!isObj(v)) fail("verified-factories.json entries must be objects");
    unknownScan(v, [...VERIFIED_FACTORY_KEYS, ...VERIFIED_FACTORY_OPTIONAL]);
    for (const k of VERIFIED_FACTORY_KEYS) if (!(k in v)) fail(`verified-factories.json entry is missing "${k}"`);
    if (!isStr(v.id) || !kebab(v.id)) fail("verified-factories.json id must be lowercase-kebab");
    if (!isStr(v.version) || !SEMVER.test(v.version)) fail(`verified-factories.json ${v.id}: version must be major.minor.patch`);
    if (!isStr(v.sha256) || !SHA256.test(v.sha256)) fail(`verified-factories.json ${v.id}: sha256 must be the archive's 64-hex sha256`);
    if (v.verdict !== "SHIP") fail(`verified-factories.json ${v.id}: verdict must be "SHIP" (only shipped archives are recorded)`);
    if (!isStr(v.qa) || v.qa.trim() === "") fail(`verified-factories.json ${v.id}: qa must say what kind of independent pass ran`);
    // This record is PUBLIC (registry + site): it describes the kind of pass, never a seat identity.
    if (/@|-impl\b|-qa\b|\bimpl\b/.test(v.qa)) fail(`verified-factories.json ${v.id}: qa must not name a seat or rig (it is published); describe the pass, e.g. "independent QA (non-author builder seat)"`);
    if (!isStr(v.date) || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) fail(`verified-factories.json ${v.id}: date must be YYYY-MM-DD`);
    if (!isStr(v.openrig) || !SEMVER.test(v.openrig)) fail(`verified-factories.json ${v.id}: openrig must be the tested OpenRig version`);
    if (!isObj(v.runtimes)) fail(`verified-factories.json ${v.id}: runtimes must be an object of runtime -> version`);
    if (!["test", "recommended"].includes(v.models)) fail(`verified-factories.json ${v.id}: models must be "test" or "recommended" (the profile actually run)`);
    if (v.path !== "additive") fail(`verified-factories.json ${v.id}: path must be "additive" (the user default: an existing OpenRig with its kernel)`);
    if ("agent_run_version" in v || "delta_qa" in v) {
      if (!isStr(v.agent_run_version) || !SEMVER.test(v.agent_run_version)) fail(`verified-factories.json ${v.id}: agent_run_version must be the major.minor.patch version whose agents ran`);
      const [a, b] = [v.agent_run_version, v.version].map((x) => x.split(".").map(Number));
      const earlier = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      if (!(earlier < 0)) fail(`verified-factories.json ${v.id}: agent_run_version ${v.agent_run_version} must be strictly earlier than version ${v.version}`);
      if (!isStr(v.delta_qa) || v.delta_qa.trim() === "") fail(`verified-factories.json ${v.id}: agent_run_version needs delta_qa, describing the independent check of this archive's delta over that run`);
      if (/@|-impl\b|-qa\b|\bimpl\b/.test(v.delta_qa)) fail(`verified-factories.json ${v.id}: delta_qa must not name a seat or rig (it is published)`);
    }
    const key = `${v.id}@${v.sha256}`;
    if (seen.has(key)) fail(`verified-factories.json lists ${v.id} ${v.sha256} twice`);
    seen.add(key);
  }
  return list.length;
}

// Which kind a registry entry is, by its fixed filename.
function kindOf(entry) {
  const parts = entry.split(/[\\/]/);
  const base = parts.pop();
  if (base === "app.json") return "app";
  if (base === "rig.json") return "rig-bundle";
  if (base === "listing.json" && parts.includes("factories")) return "factory";
  fail(`registry entry must name an app.json, a rig.json or a factories/<id>/listing.json: ${entry}`);
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
  const seenSources = new Map(); // repo|spec -> rig id
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
    const id = kind === "rig-bundle" ? validateRigDescriptor(mp, { requireSnapshot: true })
      : kind === "factory" ? validateFactoryListing(mp, { requireSnapshot: true }) : validateManifest(mp);
    const key = `${kind}:${id}`;
    if (seenIds.has(key)) fail(`duplicate ${kind === "app" ? "app" : kind === "factory" ? "factory" : "rig"} id '${id}'`);
    seenIds.add(key);
    // One rig, one listing: the same repo + spec under a second id is a
    // duplicate identity even though the ids differ. (A new pin of the same
    // rig is a refresh of the existing listing, not a second one.)
    if (kind === "rig-bundle") {
      const src = JSON.parse(fs.readFileSync(mp, "utf8")).source;
      const sKey = `${src.repo.toLowerCase()}|${src.spec}`;
      if (seenSources.has(sKey)) fail(`'${id}' lists the same source as '${seenSources.get(sKey)}' (${src.repo} ${src.spec}) — refresh that listing instead of adding a second`);
      seenSources.set(sKey, id);
    }
  }
  validateVerifiedFactories(REGISTRY_ROOT);
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
  if (!p) fail("usage: validate.mjs <app.json|rig.json|factories/<id>/listing.json> | --registry <list.json>");
  const k = kindOf(p);
  return `OK ${k === "rig-bundle" ? validateRigDescriptor(p) : k === "factory" ? validateFactoryListing(p) : validateManifest(p)}`;
}

try {
  console.log(main());
  process.exit(0);
} catch (e) {
  if (e instanceof Fail) { console.log(`FAIL: ${e.message}`); process.exit(1); }
  console.log(`FAIL: ${String(e && e.message || e)}`);
  process.exit(1);
}
