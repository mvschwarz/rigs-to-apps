#!/usr/bin/env node
// rig listing importer — an author-owned GitHub repo at a pinned commit ->
// bundles/<id>/snapshot.json, the ONLY thing the site renders for a rig.
//
//   node tools/import-bundle.mjs bundles/<id>/rig.json --cache <dir>
//
// On success prints `OK <id> <ref>` and exits 0. On ANY failure prints
// `FAIL: <reason>`, exits 1, and leaves the existing snapshot.json byte-for-byte
// untouched — a failed refresh never damages the last good listing.
//
// NOTHING FROM THE AUTHOR'S REPO IS EXECUTED, AND NOTHING IS PACKED OR
// LAUNCHED. The source is fetched with git (hooks disabled, no submodules, no
// LFS smudge, no prompt); rig.yaml and the AgentSpecs it references are READ
// (bounded) and parsed by OpenRig's OWN parsers. No `rig bundle create` runs, so
// no host/session provenance is ever stamped, and no daemon is needed.
//
// THE PARSERS ARE AN INTERNAL, VERSION-COUPLED PATH, NOT A PUBLIC EXPORT.
// OpenRig ships no verb that emits a parsed RigSpec (`rig bundle inspect --json`
// names the spec file only), so this imports RigSpecCodec/RigSpecSchema and the
// AgentSpec parser from daemon/dist/domain/ of the ACTIVE install and FAILS
// LOUDLY if they are missing or not the version pinned below. Bumping
// PARSER_CLI_VERSION is deliberate: re-import every listing and diff the
// snapshots. The supported replacement (a parsed-spec field on inspect, or an
// exported parser) is a named core gap for Build.
//
// Deterministic: no timestamps, sorted collections, fixed key order — two
// imports at one pin with one parser version are byte-identical.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PARSER_CLI_VERSION = "0.5.14";
const SNAPSHOT_VERSION = 1;

// The install PROCEDURE's exercised version — the clone/checkout/init/up
// sequence was run end to end by QA on a clean instance. Distinct from any
// one listing being launch-tested (that is verified.json, per id + commit).
export const TESTED_PROCEDURE = { openrig: "0.6.1", against: "the first-project rig on a clean VPS instance" };

// QA-tested (OpenRig 0.6.1 + Codex 0.159) project-local rule letting Codex
// members run `rig` commands outside the sandbox. Only `rig` is excepted:
// everything else stays sandboxed with network off. Not a network rule.
export const CODEX_RULE = {
  tested_on: { openrig: "0.6.1", codex: "0.159" },
  path: ".codex/rules/openrig.rules",
  text: 'prefix_rule(\n    pattern = ["rig"],\n    decision = "allow",\n    justification = "Allow OpenRig coordination commands",\n)\n',
  effect: "Commands that start with `rig` run outside the Codex sandbox without a prompt. Everything else stays sandboxed with the network off — a plain curl to the daemon still fails. It is a command exception, not a network rule.",
  trust: "Codex loads rules only from a trusted project, at startup: add the file, then restart the rig. A rules file in an untrusted project does nothing.",
};

// Bounds. Every one is a refusal with a named reason, never a silent truncation.
export const LIMITS = {
  checkoutFiles: 20000,
  checkoutBytes: 200 * 1024 * 1024,
  specBytes: 256 * 1024,
  listedFiles: 2000,
  listedBytes: 20 * 1024 * 1024,
  agents: 64,
  importDepth: 8,
  fetchTimeoutMs: 120000,
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const toPosix = (p) => p.split(path.sep).join("/");

// --- real collaborators (the CLI wires these; tests inject doubles) -------

// Fetch exactly one commit. git runs nothing from the fetched repo: hooks point
// at /dev/null, submodules are never initialised, LFS smudge is skipped and
// credential prompts are disabled.
//
// `mirror` (CLI --mirror <local repo>) fetches the SAME commit from a local
// clone instead of GitHub — for a pin that is committed but not yet pushed. A
// commit id is content-addressed, so the files (and the snapshot) are
// identical; the snapshot still records the public repo URL, and the pin is
// re-verified after checkout either way.
export function gitFetchSource({ repo, ref, dest, mirror = null }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_CONFIG_NOSYSTEM: "1" };
  const from = mirror ? path.resolve(mirror) : repo;
  const git = (args, cwd) => spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", `protocol.file.allow=${mirror ? "always" : "never"}`, ...args],
    { cwd, env, encoding: "utf8", timeout: LIMITS.fetchTimeoutMs });
  const head = fs.existsSync(path.join(dest, ".git")) ? git(["rev-parse", "HEAD"], dest) : null;
  if (head && head.status === 0 && head.stdout.trim() === ref) return; // cached at the exact pin
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const args of [["init", "-q"], ["fetch", "-q", "--depth", "1", "--no-tags", from, ref], ["checkout", "-q", "--detach", "FETCH_HEAD"]]) {
    const r = git(args, dest);
    if (r.error || r.status !== 0) {
      fail(`fetch failed for ${repo} at ${ref}: ${(r.stderr || String(r.error || "")).trim().split("\n").pop() || `git ${args[0]} exited ${r.status}`}`);
    }
  }
  const got = git(["rev-parse", "HEAD"], dest).stdout.trim();
  if (got !== ref) fail(`fetch resolved ${got || "nothing"}, not the pinned ${ref}`);
}

export function runRig(args) {
  const r = spawnSync("rig", args, { encoding: "utf8", timeout: 30000 });
  return { status: r.error ? -1 : r.status, stdout: r.stdout || "", stderr: r.stderr || String(r.error || "") };
}

// The ACTIVE OpenRig install: ~/.openrig/bin/rig is a shim that execs
// <cli>/dist/bin-wrapper.js. Resolve it, confirm the pinned version, and load its
// parsers. Any mismatch is a loud failure — never a fallback.
export async function loadOpenRigParser({ rig = runRig, expected = PARSER_CLI_VERSION } = {}) {
  const which = spawnSync("sh", ["-c", "command -v rig"], { encoding: "utf8" }).stdout.trim();
  if (!which) fail("OpenRig parser unavailable: no `rig` on PATH");
  let shim;
  try { shim = fs.readFileSync(fs.realpathSync(which), "utf8"); } catch { fail(`OpenRig parser unavailable: cannot read ${which}`); }
  const m = shim.match(/"([^"]*\/@openrig\/cli\/dist\/bin-wrapper\.js)"/);
  if (!m) fail(`OpenRig parser unavailable: ${which} does not exec an @openrig/cli bin-wrapper`);
  const cliRoot = path.dirname(path.dirname(m[1]));
  const domain = path.join(cliRoot, "daemon", "dist", "domain");
  let pkgVersion;
  try { pkgVersion = JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json"), "utf8")).version; }
  catch { fail(`OpenRig parser unavailable: no package.json at ${cliRoot}`); }
  const running = (rig(["--version"]).stdout.trim().split(/\s+/)[0]) || null;
  if (pkgVersion !== expected || running !== expected) {
    fail(`OpenRig parser version mismatch: this importer is pinned to ${expected}, the active install is ` +
      `${pkgVersion} and \`rig --version\` reports ${running}. Re-pin PARSER_CLI_VERSION deliberately and re-import every listing.`);
  }
  let codec, schema, agent;
  try {
    codec = await import(pathToFileURL(path.join(domain, "rigspec-codec.js")).href);
    schema = await import(pathToFileURL(path.join(domain, "rigspec-schema.js")).href);
    agent = await import(pathToFileURL(path.join(domain, "agent-manifest.js")).href);
  } catch (e) { fail(`OpenRig parser unavailable at ${domain}: ${String(e && e.message || e)}`); }
  if (typeof codec.RigSpecCodec?.parse !== "function" || typeof schema.RigSpecSchema?.validate !== "function" ||
      typeof schema.RigSpecSchema?.normalize !== "function" || !(schema.VALID_EDGE_KINDS instanceof Set) ||
      typeof agent.parseAgentSpec !== "function" || typeof agent.validateAgentSpec !== "function" ||
      typeof agent.normalizeAgentSpec !== "function") {
    fail(`OpenRig parser at ${domain} no longer exports RigSpecCodec/RigSpecSchema/VALID_EDGE_KINDS/parse+validate+normalizeAgentSpec`);
  }
  return {
    version: expected,
    rig: { parse: (y) => codec.RigSpecCodec.parse(y), validate: (r) => schema.RigSpecSchema.validate(r), normalize: (r) => schema.RigSpecSchema.normalize(r) },
    agent: { parse: (y) => agent.parseAgentSpec(y), validate: (r) => agent.validateAgentSpec(r), normalize: (r) => agent.normalizeAgentSpec(r) },
    edgeKinds: schema.VALID_EDGE_KINDS,
  };
}

// --- bounded filesystem reads inside the checkout --------------------------

function measureTree(root) {
  let files = 0, bytes = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        if (e.isFile()) bytes += fs.statSync(p).size;
        if (files > LIMITS.checkoutFiles) fail(`source too large: more than ${LIMITS.checkoutFiles} files at the pinned ref`);
        if (bytes > LIMITS.checkoutBytes) fail(`source too large: more than ${LIMITS.checkoutBytes} bytes at the pinned ref`);
      }
    }
  };
  walk(root);
}

// Resolve `rel` from `baseReal` and require the REAL path to stay inside the
// checkout: an in-repo symlink pointing out is refused, not followed.
function containedReal(rootReal, baseReal, rel, field) {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0") || rel.includes("\\") || path.isAbsolute(rel)) {
    fail(`path escapes source repo: ${field}`);
  }
  const candidate = path.resolve(baseReal, rel);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) fail(`path escapes source repo: ${field}`);
  if (!fs.existsSync(candidate)) fail(`${field} not found at the pinned ref: ${toPosix(path.relative(rootReal, candidate))}`);
  const real = fs.realpathSync(candidate);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) fail(`path escapes source repo (symlink): ${field}`);
  return real;
}

function readBounded(real, field) {
  const st = fs.statSync(real);
  if (!st.isFile()) fail(`${field} is not a regular file`);
  if (st.size > LIMITS.specBytes) fail(`${field} too large (${st.size} > ${LIMITS.specBytes} bytes)`);
  return fs.readFileSync(real, "utf8");
}

// --- the listing's files: spec dir + everything the specs reference -------

function collectFiles(rootReal, starts) {
  const seen = new Map(); // repo-relative posix path -> { bytes, sha256 }
  let total = 0;
  const add = (real) => {
    const rel = toPosix(path.relative(rootReal, real));
    if (seen.has(rel)) return;
    const st = fs.lstatSync(real);
    if (st.isSymbolicLink()) {
      const target = fs.realpathSync(real);
      if (target !== rootReal && !target.startsWith(rootReal + path.sep)) fail(`listed file escapes source repo (symlink): ${rel}`);
    }
    const s = fs.statSync(real);
    if (!s.isFile()) return;
    total += s.size;
    if (seen.size + 1 > LIMITS.listedFiles) fail(`listing references too many files (> ${LIMITS.listedFiles})`);
    if (total > LIMITS.listedBytes) fail(`listing references too many bytes (> ${LIMITS.listedBytes})`);
    seen.set(rel, { bytes: s.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(real)).digest("hex") });
  };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byStr(a.name, b.name))) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else add(p);
    }
  };
  for (const { real, recursive } of starts) {
    if (fs.statSync(real).isDirectory()) {
      if (recursive) walk(real);
      else for (const e of fs.readdirSync(real, { withFileTypes: true })) if (!e.isDirectory() && e.name !== ".git") add(path.join(real, e.name));
    } else add(real);
  }
  return [...seen.entries()].sort((a, b) => byStr(a[0], b[0])).map(([p, v]) => ({ path: p, bytes: v.bytes, sha256: v.sha256 }));
}

// --- parse with OpenRig's own parsers --------------------------------------

function parseRigSpec(text, parser) {
  let raw;
  try { raw = parser.rig.parse(text); }
  catch (e) { fail(`OpenRig's RigSpecCodec could not parse the spec: ${String(e && e.message || e)}`); }
  const v = parser.rig.validate(raw);
  if (!v || v.valid !== true) fail(`OpenRig's RigSpecSchema rejected the spec: ${(v?.errors ?? ["unknown"]).join("; ")}`);
  const spec = parser.rig.normalize(raw);
  if (!isObj(spec) || !Array.isArray(spec.pods)) fail("parsed spec has no pods[] — not a pod-aware RigSpec");
  return spec;
}

function parseAgent(text, parser, where) {
  let raw;
  try { raw = parser.agent.parse(text); }
  catch (e) { fail(`OpenRig's AgentSpec parser could not parse ${where}: ${String(e && e.message || e)}`); }
  const v = parser.agent.validate(raw);
  if (!v || v.valid !== true) fail(`OpenRig rejected the AgentSpec ${where}: ${(v?.errors ?? ["unknown"]).join("; ")}`);
  return parser.agent.normalize(raw);
}

// verified.json (registry root, maintainer-owned): [{ id, ref, openrig,
// runtimes: { <runtime>: <version> } }]. Absent file = nothing verified.
function readVerified(registryRoot) {
  const p = path.join(registryRoot, "verified.json");
  if (!fs.existsSync(p)) return [];
  let list;
  try { list = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { fail(`verified.json is invalid JSON: ${String(e.message)}`); }
  if (!Array.isArray(list)) fail("verified.json must be a list");
  for (const v of list) {
    if (!isObj(v) || typeof v.id !== "string" || !/^[0-9a-f]{40}$/.test(v.ref ?? "") || typeof v.openrig !== "string" || !isObj(v.runtimes)) {
      fail("verified.json entries need { id, ref (full sha), openrig, runtimes{} }");
    }
  }
  return list;
}

// `local:<path>` refs are resolved inside the checkout; anything else (builtin:,
// library refs) is recorded as-is and never resolved here.
const localRef = (ref) => (typeof ref === "string" && ref.startsWith("local:") ? ref.slice("local:".length) : null);

// --- the import -------------------------------------------------------------

export function validateWithRegistryValidator(descriptorPath) {
  const r = spawnSync(process.execPath, [path.join(HERE, "validate.mjs"), descriptorPath], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

export async function importBundle({
  descriptorPath,
  cacheDir,
  fetchSource = gitFetchSource,
  parser,
  rig = runRig,
  validate = validateWithRegistryValidator,
  leakTerms = defaultLeakTerms(),
  registryRoot,
}) {
  if (!cacheDir) fail("usage: import-bundle.mjs <bundles/<id>/rig.json> --cache <dir>");
  const v = validate(descriptorPath);
  if (v.status !== 0) fail(`descriptor invalid — ${(v.stdout + v.stderr).trim().replace(/^FAIL:\s*/, "")}`);
  const d = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  const snapshotPath = path.join(path.dirname(path.resolve(descriptorPath)), "snapshot.json");
  // bundles/<id>/rig.json -> the registry root two levels up
  if (!registryRoot) registryRoot = path.resolve(path.dirname(path.resolve(descriptorPath)), "..", "..");
  const cache = path.resolve(cacheDir);
  fs.mkdirSync(cache, { recursive: true });
  const cacheReal = fs.realpathSync(cache);

  if (!parser) parser = await loadOpenRigParser({ rig });

  // 1. the author's source, at exactly the pin
  const src = path.join(cacheReal, "src", `${d.id}-${d.source.ref}`);
  await fetchSource({ repo: d.source.repo, ref: d.source.ref, dest: src });
  const root = fs.realpathSync(src);
  measureTree(root);

  // 2. the rig spec, read (bounded) and parsed by OpenRig
  const specReal = containedReal(root, root, d.source.spec, "source.spec");
  const spec = parseRigSpec(readBounded(specReal, "source.spec"), parser);
  const specDir = path.dirname(specReal);

  // Optional prebuilt .rigbundle at the same pin: RECORDED (bounded, hashed,
  // linked), never inspected, installed or launched — and its provenance is
  // never read. It is a download the author chose to ship.
  let bundle = null;
  if (typeof d.source.bundle === "string") {
    const bReal = containedReal(root, root, d.source.bundle, "source.bundle");
    const st = fs.statSync(bReal);
    if (!st.isFile()) fail("source.bundle is not a regular file");
    if (st.size > LIMITS.listedBytes) fail(`source.bundle too large (> ${LIMITS.listedBytes} bytes)`);
    bundle = { path: d.source.bundle, bytes: st.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(bReal)).digest("hex") };
  }

  // 3. every AgentSpec the members reference, and everything THEY import
  const starts = [{ real: specDir, recursive: false }];
  if (typeof spec.cultureFile === "string") starts.push({ real: containedReal(root, specDir, spec.cultureFile, "culture_file"), recursive: false });
  for (const doc of Array.isArray(spec.docs) ? spec.docs : []) {
    const p = typeof doc === "string" ? doc : doc?.path;
    if (typeof p === "string") starts.push({ real: containedReal(root, specDir, p, "docs[]"), recursive: false });
  }
  const agents = new Map(); // repo-relative dir -> summary
  const unresolved = new Set();
  const visitAgent = (dirReal, depth, via) => {
    const rel = toPosix(path.relative(root, dirReal));
    if (agents.has(rel)) return;
    if (depth > LIMITS.importDepth) fail(`AgentSpec imports nest deeper than ${LIMITS.importDepth} (via ${via})`);
    if (agents.size + 1 > LIMITS.agents) fail(`listing references too many AgentSpecs (> ${LIMITS.agents})`);
    const yamlReal = containedReal(root, dirReal, "agent.yaml", `agent.yaml in ${rel}`);
    const a = parseAgent(readBounded(yamlReal, `${rel}/agent.yaml`), parser, `${rel}/agent.yaml`);
    const plugins = [...new Set([...(a.plugins ?? []), ...Object.values(a.profiles ?? {}).flatMap((p) => p?.uses?.plugins ?? [])]
      .filter((x) => typeof x === "string"))].sort(byStr);
    const skills = [...new Set(Object.values(a.profiles ?? {}).flatMap((p) => p?.uses?.skills ?? []).filter((x) => typeof x === "string"))].sort(byStr);
    const imports = [];
    agents.set(rel, { path: rel, name: String(a.name ?? path.basename(rel)), version: a.version != null ? String(a.version) : null,
      runtime: typeof a.defaults?.runtime === "string" ? a.defaults.runtime : null,
      model: typeof a.defaults?.model === "string" ? a.defaults.model : null, imports, plugins, skills });
    starts.push({ real: dirReal, recursive: true });
    for (const imp of a.imports ?? []) {
      const r = localRef(imp?.ref);
      if (r === null) { unresolved.add(String(imp?.ref)); continue; }
      const impReal = containedReal(root, dirReal, r, `import ${imp.ref} in ${rel}`);
      imports.push(toPosix(path.relative(root, impReal)));
      visitAgent(impReal, depth + 1, rel);
    }
    imports.sort(byStr);
  };

  const pods = spec.pods.map((p) => ({
    id: String(p.id),
    label: typeof p.label === "string" ? p.label : null,
    members: (p.members ?? []).map((m) => {
      const r = localRef(m.agentRef);
      let agent = null;
      if (r !== null) {
        const dirReal = containedReal(root, specDir, r, `agent_ref of ${p.id}.${m.id}`);
        visitAgent(dirReal, 0, `${p.id}.${m.id}`);
        agent = toPosix(path.relative(root, dirReal));
      } else if (m.agentRef) unresolved.add(String(m.agentRef));
      return {
        id: String(m.id),
        label: typeof m.label === "string" ? m.label : null,
        runtime: typeof m.runtime === "string" ? m.runtime : null,
        model: typeof m.model === "string" ? m.model : null,
        agent,
        agent_ref: typeof m.agentRef === "string" ? m.agentRef : null,
        cwd: typeof m.cwd === "string" ? m.cwd : null,
        // Effective launch posture: the member's own permission_policy, else
        // the rig's, else OpenRig's explicit "floor". Declared refs verbatim.
        permission_policy: typeof m.permissionPolicy === "string" ? m.permissionPolicy
          : typeof spec.permissionPolicy === "string" ? spec.permissionPolicy : null,
      };
    }),
  }));

  const agentRuntime = (agentPath) => (agentPath && agents.get(agentPath)?.runtime) || null;
  const memberIds = new Set(pods.flatMap((p) => p.members.map((m) => `${p.id}.${m.id}`)));
  const edges = [];
  const addEdge = (kind, from, to) => {
    if (!parser.edgeKinds.has(kind)) fail(`parsed spec has an edge kind OpenRig does not know: ${kind}`);
    if (!memberIds.has(from) || !memberIds.has(to)) fail(`parsed spec has an edge to an unknown member: ${from} -> ${to}`);
    edges.push({ kind, from, to });
  };
  for (const p of spec.pods) for (const e of p.edges ?? []) addEdge(e.kind, `${p.id}.${e.from}`, `${p.id}.${e.to}`);
  for (const e of spec.edges ?? []) addEdge(e.kind, e.from, e.to);

  // 4. the files — listed and hashed, never executed
  const files = collectFiles(root, starts);
  const agentList = [...agents.values()].sort((a, b) => byStr(a.path, b.path));

  // 5. honest requirements and risks, derived from what the parsers returned
  const runtimes = [...new Set(pods.flatMap((p) => p.members.map((m) => m.runtime)).filter(Boolean))].sort(byStr);
  const plugins = [...new Set(agentList.flatMap((a) => a.plugins))].sort(byStr);
  const models = [...new Set([...pods.flatMap((p) => p.members.map((m) => m.model)), ...agentList.map((a) => a.model)].filter(Boolean))].sort(byStr);
  const absoluteCwds = pods.flatMap((p) => p.members.filter((m) => m.cwd && m.cwd.startsWith("/")).map((m) => `${p.id}.${m.id}`));
  const risks = [];
  if (models.length) risks.push({ id: "model-pins", label: "Model pins are copied verbatim", detail: `This rig pins ${models.join(", ")}. You need a runtime version that supports each pinned model; an older runtime refuses it at launch.` });
  if (plugins.length) risks.push({ id: "host-plugins", label: "Profile plugins resolve on your host", detail: `Plugins (${plugins.join(", ")}) are not vendored; they resolve from your own OpenRig install.` });
  if (absoluteCwds.length) risks.push({ id: "absolute-cwd", label: "Absolute working directories", detail: `Members ${absoluteCwds.join(", ")} name an absolute cwd, which is copied verbatim.` });
  if (spec.services) risks.push({ id: "services", label: "Starts a managed service", detail: "This rig declares a services block (for example Docker Compose) that boots before any seat." });
  if (unresolved.size) risks.push({ id: "non-local-refs", label: "References outside this repo", detail: `Resolved by your OpenRig install, not shown here: ${[...unresolved].sort(byStr).join(", ")}.` });
  // Floor posture matters PER RUNTIME (QA, OpenRig 0.6.1): Claude Code members
  // at floor coordinate out of the box; Codex members at floor run, answer and
  // write files but cannot reach the daemon, so rig queue / rig send fail. Only
  // the latter is a risk, and it is stated as a fact — no fix is suggested.
  const codexAtFloor = pods.flatMap((p) => p.members
    .filter((m) => m.permission_policy === null && (m.runtime ?? agentRuntime(m.agent)) === "codex")
    .map((m) => `${p.id}.${m.id}`));
  // Codex coordination, as QA tested it (OpenRig 0.6.1 + Codex 0.159): a
  // project-local Codex command rule lets `rig` commands run outside the Codex
  // sandbox; everything else stays sandboxed with network off. A manual 0.6.1
  // setup — stated as tested, not as a guarantee of any later version.
  if (codexAtFloor.length) risks.push({ id: "codex-floor", label: "Codex members need a command rule to coordinate",
    detail: `${codexAtFloor.join(", ")} run${codexAtFloor.length === 1 ? "s" : ""} on Codex with no permission_policy. Default posture: members run and answer, but can't reach the rig daemon (Codex sandbox). The tested fix is a project-local Codex command rule — see "Let Codex members coordinate".` });
  risks.push({ id: "no-author-auth", label: "Not an author signature", detail: "rigs.to pins and shows an exact commit. That proves which files you get, not who wrote them." });

  // Each member's EFFECTIVE model pin — the member's own, else its AgentSpec
  // default. Pins are copied verbatim and a runtime too old for the model
  // refuses it, so every pin is surfaced beside the runtime that must support it.
  const agentByPath = new Map(agentList.map((a) => [a.path, a]));
  const memberModels = pods.flatMap((p) => p.members.map((m) => ({
    member: `${p.id}.${m.id}`,
    runtime: m.runtime ?? agentByPath.get(m.agent)?.runtime ?? null,
    model: m.model ?? agentByPath.get(m.agent)?.model ?? null,
  }))).filter((x) => x.model);

  // LAUNCH-TESTED is a QA fact, not something the author or this importer can
  // claim: it comes only from the maintainer-owned verified.json, and only for
  // this exact id AND commit. A new ref loses the stamp until it is re-run.
  const launchTested = readVerified(registryRoot).find((v) => v.id === d.id && v.ref === d.source.ref) ?? null;

  const dir = d.source.repo.split("/").pop();
  const specAbs = `"$PWD/${dir}/${d.source.spec}"`;
  const snapshot = {
    snapshot_version: SNAPSHOT_VERSION,
    id: d.id,
    title: d.title,
    summary: d.summary,
    tags: [...d.tags],
    author: { name: d.author.name, url: d.author.url },
    license: d.license,
    source: {
      repo: d.source.repo,
      ref: d.source.ref,
      spec: d.source.spec,
      spec_dir: toPosix(path.relative(root, specDir)),
      blob_base: `${d.source.repo}/blob/${d.source.ref}/`,
      tree_url: `${d.source.repo}/tree/${d.source.ref}`,
      bundle,
    },
    parsed_by: {
      openrig: parser.version,
      parsers: "RigSpecCodec + RigSpecSchema + AgentSpec (parseAgentSpec)",
      note: "Read from OpenRig's internal, version-coupled modules — not a public OpenRig export.",
    },
    topology: { pods, edges },
    launch_posture: {
      rig_policy: typeof spec.permissionPolicy === "string" ? spec.permissionPolicy : null,
      members: pods.flatMap((p) => p.members.map((m) => ({ member: `${p.id}.${m.id}`,
        runtime: m.runtime ?? agentRuntime(m.agent),
        posture: m.permission_policy === null ? "floor" : "declared", policy: m.permission_policy }))),
    },
    agents: agentList,
    requirements: {
      // the OpenRig version the install PROCEDURE below was exercised on
      openrig: { min: TESTED_PROCEDURE.openrig, daemon: "running" },
      runtimes,
      models: memberModels,
      plugins,
    },
    risks,
    files: { count: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), entries: files },
    install: {
      launch_tested: launchTested
        ? { openrig: launchTested.openrig, runtimes: launchTested.runtimes }
        : null,
      status: launchTested ? `launch tested on OpenRig ${launchTested.openrig}` : "parsed, not launch-tested",
      procedure_note: `This procedure was exercised end to end on OpenRig ${TESTED_PROCEDURE.openrig} with ${TESTED_PROCEDURE.against}.`,
      steps: [
        { label: "Get the source", command: `git clone ${d.source.repo} ${dir}` },
        { label: "Pin the exact reviewed revision", command: `git -C ${dir} checkout ${d.source.ref}` },
        { label: "Make a stable project directory for the rig", command: "mkdir -p my-project" },
        { label: "Preview — runs the version preflight and writes a record; launches nothing", command: `rig up ${specAbs} --cwd "$PWD/my-project" --plan` },
        { label: "Apply and launch — starts the rig's agents in my-project", command: `rig up ${specAbs} --cwd "$PWD/my-project" --yes` },
      ],
      // ROUTE B, only when the author ships a prebuilt bundle at the same pin.
      // Exercised on OpenRig 0.6.1. rigs.to links the AUTHOR's file; it never
      // publishes a .rigbundle of its own.
      bundle_steps: bundle ? [
        { label: "Get the source at the pinned revision (it carries the author's prebuilt bundle)", command: `git clone ${d.source.repo} ${dir} && git -C ${dir} checkout ${d.source.ref}` },
        { label: "Make a stable project directory for the rig", command: "mkdir -p my-project" },
        { label: "Preview — runs the version preflight and writes a record; launches nothing", command: `rig up "$PWD/${dir}/${bundle.path}" --cwd "$PWD/my-project" --plan` },
        { label: "Apply and launch — starts the rig's agents in my-project", command: `rig up "$PWD/${dir}/${bundle.path}" --cwd "$PWD/my-project" --yes` },
      ] : null,
      // Tested (OpenRig 0.6.1) as RESTART / RECOVERY of the same rig — it keeps
      // the rig's agents, files and workspace. NOT a way to apply a config
      // change or move to a newer source commit.
      restart: {
        tested_on: TESTED_PROCEDURE.openrig,
        label: "Restart the rig (keeps its agents, files and workspace)",
        steps: [
          { label: "Stop the rig and keep a snapshot", command: `rig down ${spec.name} --snapshot` },
          { label: "Start it again from that snapshot", command: `rig up ${spec.name} --existing --yes` },
        ],
      },
      // Stated plainly; no workaround recipe is published.
      update: "OpenRig 0.6.1 can't update a running rig to a newer source commit in place. Re-running rig up refuses a name collision while the rig runs, and after a plain down it creates a duplicate rig.",
      codex_coordination: codexAtFloor.length ? CODEX_RULE : null,
    },
  };

  const out = JSON.stringify(snapshot, null, 2) + "\n";
  for (const term of leakTerms) {
    if (term && out.includes(term)) fail(`refusing to write a snapshot that names a private term (${term.length > 24 ? term.slice(0, 12) + "…" : term})`);
  }
  for (const t of [cacheReal, cache]) if (out.includes(t)) fail("refusing to write a snapshot that names the import cache");

  // 6. atomic write — only a fully successful import replaces the last good one
  const tmp = `${snapshotPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, snapshotPath);
  return { id: d.id, ref: d.source.ref, snapshotPath };
}

export function defaultLeakTerms() {
  const terms = [os.hostname(), os.homedir(), process.env.OPENRIG_SESSION_NAME, "/Users/", "/home/", "sourceHost", "source_host", "authorSession", "author_session"];
  const short = os.hostname().split(".")[0];
  if (short && short.length >= 4) terms.push(short);
  return terms.filter((t) => typeof t === "string" && t.length >= 4);
}

// --- CLI -----------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--cache");
  const cacheDir = i >= 0 ? args[i + 1] : process.env.IMPORT_CACHE;
  const mi = args.indexOf("--mirror");
  const mirror = mi >= 0 ? args[mi + 1] : null;
  const descriptorPath = args.find((a, j) => !a.startsWith("--") && args[j - 1] !== "--cache" && args[j - 1] !== "--mirror");
  if (!descriptorPath) fail("usage: import-bundle.mjs <bundles/<id>/rig.json> --cache <dir> [--mirror <local clone>]");
  const r = await importBundle({ descriptorPath, cacheDir, fetchSource: (o) => gitFetchSource({ ...o, mirror }) });
  return `OK ${r.id} ${r.ref}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((m) => { console.log(m); process.exit(0); }, (e) => {
    console.log(`FAIL: ${e instanceof Fail ? e.message : String(e && e.message || e)}`);
    process.exit(1);
  });
}
