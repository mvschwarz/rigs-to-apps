#!/usr/bin/env node
// Hermetic probe over fixtures/ — the standing gate. Runs validate over every
// fixture, asserts each PASS/FAIL with an expected reason substring, checks the
// registry cases + the empty root registry.json, and the formatter's contents
// AND its forbidden-network cleanliness. Prints PROBE PASS / PROBE FAIL and
// exits nonzero on any miss. Must be green TWICE consecutively (the second run
// is the real test). Reads only; WRITES NOWHERE — pure projection over fixtures.
//
// Hermeticity (studio-surfaces probe craft): every derived root is a REAL
// env-overridable INPUT that actually drives the probe, so a parent-relative
// default can never silently escape the scaffold and an override provably
// relocates the whole run:
//   REGISTRY_ROOT (default: repo root) — the root registry entries resolve
//     against; passed through to validate and used to locate the root
//     registry.json. A caller-supplied value is honored, never clobbered.
//   FIXTURES_DIR  (default: <repo>/fixtures) — the base for EVERY fixture path
//     (valid / invalid / registry) this probe validates.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// Both roots are real inputs: honor a caller-supplied value, else default.
// realpath them so containment comparisons are symlink-stable (e.g. macOS
// resolves a /var/... TMPDIR to /private/var/...); validate realpaths its own
// roots too, so passing the resolved value through is idempotent.
const REGISTRY_ROOT = fs.realpathSync(process.env.REGISTRY_ROOT ? path.resolve(process.env.REGISTRY_ROOT) : ROOT);
const FIXTURES = fs.realpathSync(process.env.FIXTURES_DIR ? path.resolve(process.env.FIXTURES_DIR) : path.join(ROOT, "fixtures"));
const VALIDATE = path.join(HERE, "validate.mjs");
const FORMATTER = path.join(HERE, "format-install-request.mjs");
// Pass the CHOSEN REGISTRY_ROOT through to validate (does not clobber the
// caller's — it IS the caller's when set).
const ENV = { ...process.env, REGISTRY_ROOT };
const fx = (...p) => path.join(FIXTURES, ...p);

const results = [];
const ok = (name) => results.push({ name, pass: true });
const bad = (name, detail) => results.push({ name, pass: false, detail });

// Run validate; return { code, out }. cwd=ROOT so validate's own defaults are
// stable; fixture args are absolute (built from FIXTURES) so cwd is irrelevant.
function validate(args) {
  try {
    const out = execFileSync("node", [VALIDATE, ...args], { cwd: ROOT, env: ENV, encoding: "utf8" });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || "").trim() };
  }
}

function expectValid(abs, label, wantOut) {
  const r = validate([abs]);
  if (r.code === 0 && r.out === wantOut) ok(`PASS ${label} (${wantOut})`);
  else bad(`valid ${label}`, `code=${r.code} out=${JSON.stringify(r.out)} want ${JSON.stringify(wantOut)}`);
}

function expectFail(abs, label, reasonSub) {
  const r = validate([abs]);
  if (r.code === 1 && r.out.startsWith("FAIL:") && r.out.includes(reasonSub)) ok(`FAIL ${label} (${reasonSub})`);
  else bad(`invalid ${label}`, `code=${r.code} out=${JSON.stringify(r.out)} want FAIL ~ ${JSON.stringify(reasonSub)}`);
}

function expectRegistry(regFile, label, wantCode, wantSub) {
  const r = validate(["--registry", regFile]);
  const good = wantCode === 0
    ? (r.code === 0 && r.out.includes(wantSub))
    : (r.code === 1 && r.out.startsWith("FAIL:") && r.out.includes(wantSub));
  if (good) ok(`REGISTRY ${label} (${wantSub})`);
  else bad(`registry ${label}`, `code=${r.code} out=${JSON.stringify(r.out)} want ${wantCode}/${JSON.stringify(wantSub)}`);
}

// --- valid manifests (paths from FIXTURES) ---
expectValid(fx("valid/wedding-cutdown/app.json"), "valid/wedding-cutdown", "OK wedding-cutdown");
expectValid(fx("valid/minimal-static/app.json"), "valid/minimal-static", "OK minimal-static");

// --- invalid manifests (each: exactly one intended defect) ---
const INVALID = [
  ["unknown-field", "unknown field 'version'"],
  ["typo-field", "unknown field 'catagory'"],
  ["path-escape", "path escapes app dir"],
  ["absent-entry", "referenced file absent"],
  ["absent-readme", "missing README.md"],
  ["bad-category", "category not in {create,build,grow,system}"],
  ["bad-method", "verb method not in {GET,POST}"],
  ["bad-demo", "demo must be relative or https"],
  ["bad-surface-path", "surface.path must be an absolute route"],
  ["bad-destination", "destination must be ~/studio/apps/<id>"],
  ["hostile", "prototype-pollution key"],
  ["dir-entry", "not a regular file: install.surface.entry"], // guard MUST-FIX 2: directory-as-file
  ["dir-readme", "README.md must be a regular file"],          // guard MUST-FIX 2: README-as-directory
  ["symlink-escape", "path escapes app dir"], // approval addition: rejected AFTER realpath
];
for (const [scenario, sub] of INVALID)
  expectFail(fx("invalid", scenario, "wedding-cutdown/app.json"), `invalid/${scenario}`, sub);

// Guard MUST-FIX 3: prove the symlink-escape fixture is PORTABLE + self-contained
// (not a leak to the original checkout): its stored target is RELATIVE, and it
// realpath-resolves INSIDE the active scaffold (under REGISTRY_ROOT) yet OUTSIDE
// the app dir — so the 'path escapes app dir' above is genuinely
// realpath-before-containment, provable in any relocated copy.
(function symlinkHermetic() {
  const link = fx("invalid/symlink-escape/wedding-cutdown/app/cutdown.html");
  const appDir = fx("invalid/symlink-escape/wedding-cutdown/app");
  let stored, real;
  try { stored = fs.readlinkSync(link); real = fs.realpathSync(link); }
  catch (e) { return bad("symlink hermeticity", `readlink/realpath threw: ${String(e.message)}`); }
  const appReal = fs.realpathSync(appDir);
  const relative = !path.isAbsolute(stored);
  const insideRoot = real === REGISTRY_ROOT || real.startsWith(REGISTRY_ROOT + path.sep);
  const outsideApp = real !== appReal && !real.startsWith(appReal + path.sep);
  if (relative && insideRoot && outsideApp) ok(`SYMLINK portable+self-contained (target '${stored}' -> inside REGISTRY_ROOT, outside app)`);
  else bad("symlink hermeticity", `stored=${JSON.stringify(stored)} relative=${relative} insideRoot=${insideRoot} outsideApp=${outsideApp}`);
})();

// --- registry cases (root registry.json under REGISTRY_ROOT; fixtures under FIXTURES) ---
// The root registry may be empty (canonical base) or hold packaged apps; expect
// the ACTUAL bare-list length (correct singular/plural). The validator still
// enforces the bare-list / relative-path / manifest-identity rules — this only
// generalizes the SUCCESS string so a populated real registry passes too.
{
  const rootReg = path.join(REGISTRY_ROOT, "registry.json");
  const n = JSON.parse(fs.readFileSync(rootReg, "utf8")).length;
  expectRegistry(rootReg, "root registry.json", 0, `OK registry (${n} manifest${n === 1 ? "" : "s"})`);
}
expectRegistry(fx("registry/bare-ok.json"), "registry/bare-ok", 0, "OK registry (1 manifest)");
expectRegistry(fx("registry/metadata-bad.json"), "registry/metadata-bad", 1, "registry must be a bare list of manifest paths");
expectRegistry(fx("registry/path-escape.json"), "registry/path-escape", 1, "registry path escapes root (absolute or ..)");
expectRegistry(fx("registry/dup-id.json"), "registry/dup-id", 1, "duplicate app id 'wedding-cutdown'"); // guard MUST-FIX 1

// --- formatter: contents + forbidden-network cleanliness ---
(function formatterCheck() {
  const manifest = fx("valid/wedding-cutdown/app.json");
  let out;
  try {
    out = execFileSync("node", [FORMATTER, "--repo", "mvschwarz/rigs-to-apps", "--manifest", manifest],
      { cwd: ROOT, env: ENV, encoding: "utf8" });
  } catch (e) { return bad("formatter", `threw: ${String(e.message)}`); }
  const mustHave = ["wedding-cutdown", "mvschwarz/rigs-to-apps", manifest];
  const missing = mustHave.filter((s) => !out.includes(s));
  const forbidden = /token|bearer|authorization|https?:\/\/\S*callback|\bPOST\b|fetch\(|curl /i;
  const hit = out.match(forbidden);
  if (missing.length) bad("formatter contents", `missing ${JSON.stringify(missing)}`);
  else if (hit) bad("formatter forbidden-network", `matched ${JSON.stringify(hit[0])}`);
  else ok("FORMATTER includes id+repo+path, no token/callback/direct-network");
  // Founder naming rule (2026-07-26): the emitted request must use lead-agent
  // language and must NEVER use the banned third-party name (GitHub/Windows own
  // it). The detector is assembled from fragments so the token's literal never
  // appears in this product repo — the zero-hit naming scan stays zero even in
  // the enforcement code.
  const BANNED = new RegExp(["co", "pilot"].join(""), "i");
  if (BANNED.test(out)) bad("formatter naming", "output contains the banned third-party name");
  else if (!/lead agent/i.test(out)) bad("formatter naming", "output does not use lead-agent language");
  else ok("FORMATTER uses lead-agent language; no banned vendor term");
})();

// --- report ---
console.log(`roots: REGISTRY_ROOT=${REGISTRY_ROOT}  FIXTURES=${FIXTURES}`);
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? "  ok" : "MISS"}  ${r.name}${r.pass ? "" : "  <<< " + r.detail}`);
if (failed.length) {
  console.log(`\nPROBE FAIL (${failed.length}/${results.length} checks missed)`);
  process.exit(1);
}
console.log(`\nPROBE PASS (${results.length} checks)`);
process.exit(0);
