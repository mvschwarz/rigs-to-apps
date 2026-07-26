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
    const id = validateManifest(mp);
    if (seenIds.has(id)) fail(`duplicate app id '${id}'`);
    seenIds.add(id);
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
  if (!p) fail("usage: validate.mjs <app.json> | --registry <list.json>");
  return `OK ${validateManifest(p)}`;
}

try {
  console.log(main());
  process.exit(0);
} catch (e) {
  if (e instanceof Fail) { console.log(`FAIL: ${e.message}`); process.exit(1); }
  console.log(`FAIL: ${String(e && e.message || e)}`);
  process.exit(1);
}
