#!/usr/bin/env node
// launch.mjs — set up and launch this factory package. Readable on purpose:
// every step below is a plain OpenRig command or a file check you can read.
//
//   node launch.mjs --project <dir> [--profile test] [--apply-permissions] [--plan-only]
//
// Order: verify every file -> check tools -> copy starter files into your
// project -> install and read back the context packs -> (optionally) apply the
// declared permission files -> for each rig, `rig up <bundle> --cwd <project>
// --plan`, then `--yes` -> verify every member is running, its startup files
// delivered and every declared skill arrived intact. Anything missing or wrong
// STOPS with the reason. Nothing is downloaded and no remote instruction is
// followed: this script only reads files that are inside this package.
//
// Requires Node >= 22 and OpenRig (`rig`) >= the version in FACTORY.json, with
// its daemon running, plus the runtimes and tools FACTORY.json lists.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const say = (m) => console.log(m);
const stop = (m) => { console.error(`\nSTOPPED: ${m}`); process.exit(1); };
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const verCmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

function args() {
  const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const o = { project: get("--project"), profile: get("--profile") || "recommended",
    applyPermissions: a.includes("--apply-permissions"), planOnly: a.includes("--plan-only") };
  if (!o.project) stop("usage: node launch.mjs --project <dir> [--profile test] [--apply-permissions] [--plan-only]");
  if (!["recommended", "test"].includes(o.profile)) stop(`--profile must be "recommended" or "test", not "${o.profile}"`);
  return o;
}

const o = args();
const F = JSON.parse(fs.readFileSync(path.join(PKG, "FACTORY.json"), "utf8"));
say(`${F.title} ${F.version} — ${F.summary}`);
say(`Built by ${F.built_by}.${o.profile === "test" ? `  PROFILE: ${F.models.test._label}` : ""}`);

// 1. Every file is exactly what FACTORY.json lists.
say("\n1. Verifying files");
for (const f of F.files) {
  const p = path.join(PKG, f.path);
  if (!fs.existsSync(p)) stop(`missing from the package: ${f.path}`);
  if (sha256(p) !== f.sha256) stop(`hash mismatch: ${f.path} — the package was altered or damaged`);
}
say(`   ${F.files.length} files match FACTORY.json`);

// 2. OpenRig and the declared tools are present at usable versions.
say("\n2. Checking prerequisites");
const rv = run("rig", ["--version"]);
if (rv.status !== 0) stop("`rig` (OpenRig) is not on PATH — install OpenRig first");
const rigVer = rv.stdout.trim().split(/\s+/)[0];
if (verCmp(rigVer, F.openrig.min) < 0) stop(`OpenRig ${rigVer} is older than the required ${F.openrig.min}`);
// A SEPARATE OpenRig home (a test instance: OPENRIG_HOME set to anything but ~/.openrig)
// must also set OPENRIG_SHARED_DOCS_ROOT outside the default home. OpenRig gives each
// Codex seat write access to <shared-docs root>/rigs/<rig>/state/<pod>, and that root
// comes from OPENRIG_SHARED_DOCS_ROOT, else ~/.openrig/shared-docs, never from
// OPENRIG_HOME, so without it a test instance's seats can write inside your real
// OpenRig. (This reads the shell you launch from; TESTING.md sets both variables in one
// env file sourced before the daemon starts.) A normal install sets neither: unaffected.
{
  const defHome = path.join(os.homedir(), ".openrig");
  const home = process.env.OPENRIG_HOME ? path.resolve(process.env.OPENRIG_HOME) : null;
  if (home && home !== defHome) {
    const root = process.env.OPENRIG_SHARED_DOCS_ROOT ? path.resolve(process.env.OPENRIG_SHARED_DOCS_ROOT) : null;
    const defRoot = path.join(defHome, "shared-docs");
    if (!root || root === defRoot || root.startsWith(`${defRoot}${path.sep}`)) {
      stop(`OPENRIG_HOME is a separate OpenRig home (${home}), but OPENRIG_SHARED_DOCS_ROOT ${root ? `(${root}) is inside` : "is not set, so it resolves to"} the default ${defRoot}: Codex seats would get write access there. Set OPENRIG_SHARED_DOCS_ROOT inside the test home before starting its daemon (TESTING.md).`);
    }
    say(`   separate OpenRig home; Codex seats' state root is ${root} (outside your default home)`);
  }
}
// An archive cannot record tests run after its bytes were fixed, so a null "tested"
// means "not stated here", not "untested": proofs of this exact archive are
// published beside it (its release notes and listing).
say(`   OpenRig ${rigVer} (needs >= ${F.openrig.min}${F.openrig.tested ? `; launch-tested on ${F.openrig.tested}` : "; launch tests of this exact archive are recorded in its release notes"})`);
// The factory is ADDED to your OpenRig: your other rigs, and OpenRig's own kernel,
// are left exactly as they are. The one thing it refuses is a name clash: if a rig
// with a factory rig's name already exists, launching would clobber or duplicate it.
const rps = run("rig", ["ps", "--json"]);
let existing; try { existing = JSON.parse(rps.stdout); } catch { stop(`could not list your rigs (\`rig ps --json\`): ${(rps.stderr || rps.stdout).trim()}`); }
if (!Array.isArray(existing)) stop("`rig ps --json` did not return a list of rigs");
const clash = existing.filter((x) => !x.isArchived && F.rigs.some((r) => r.name === (x.name ?? x.rigName)));
if (clash.length) stop(`this OpenRig already has ${clash.length === 1 ? "a rig" : "rigs"} named ${clash.map((x) => `${x.name ?? x.rigName} (id ${x.rigId}, ${x.status})`).join(", ")}. The factory will not overwrite or duplicate it. Remove or rename that rig first, or run the factory in another OpenRig home.`);
say(`   ${existing.length} existing rig(s) in this OpenRig, none named like this factory's rigs; they are left untouched`);
for (const t of F.prerequisites) {
  const [cmd, ...cargs] = t.check;
  const r = run(cmd, cargs);
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.error || r.status !== 0) stop(`${t.name} not found (\`${t.check.join(" ")}\` failed) — ${t.why}`);
  const m = t.version_pattern ? out.match(new RegExp(t.version_pattern)) : null;
  if (t.min && (!m || verCmp(m[1], t.min) < 0)) stop(`${t.name} ${m ? m[1] : "(unknown version)"} is older than ${t.min} — ${t.why}`);
  say(`   ${t.name}${m ? ` ${m[1]}` : ""} ok`);
}

// 3. Starter files into the project directory (never over existing files).
const project = path.resolve(o.project);
fs.mkdirSync(project, { recursive: true });
say(`\n3. Project directory: ${project}`);
const permissionFiles = new Set(F.permissions.flatMap((p) => p.files));
for (const s of F.starter) {
  if (permissionFiles.has(s.to)) continue; // step 4 decides these
  const dst = path.join(project, s.to);
  if (fs.existsSync(dst)) { if (sha256(dst) !== sha256(path.join(PKG, s.from))) stop(`${s.to} already exists in the project with different content — move it aside first`); continue; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(PKG, s.from), dst);
  say(`   + ${s.to}`);
}

// 4. Context packs: install each into OpenRig's context library, then prove every
//    file in it is retrievable the way seats pull it (`rig context get <pack>/<file>`).
//    A pack already installed under the same name must hold exactly these bytes.
say("\n4. Context packs");
if (!(F.context_packs ?? []).length) say("   none");
for (const c of F.context_packs ?? []) {
  const showJson = () => { const r = run("rig", ["context", "show", c.name, "--json"]); try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
  let shown = showJson();
  if (shown) {
    for (const f of c.files) {
      const inst = shown.files?.find((x) => x.path === f);
      if (!inst?.absolutePath || !fs.existsSync(inst.absolutePath) || sha256(inst.absolutePath) !== sha256(path.join(PKG, c.path, f))) {
        stop(`a different context pack named ${c.name} is already installed in this OpenRig (${shown.sourcePath}). Use a fresh OpenRig home, or remove that pack first.`);
      }
    }
    say(`   ${c.name}: already installed with identical files`);
  } else if (o.planOnly) { say(`   ${c.name}: would install (rig context add ${c.path})`); continue; }
  else {
    const add = run("rig", ["context", "add", path.join(PKG, c.path), "--json"]);
    if (add.status !== 0) stop(`rig context add ${c.path} failed:\n${(add.stdout + add.stderr).trim()}`);
    shown = showJson();
    if (!shown) stop(`${c.name} was added but \`rig context show ${c.name}\` cannot find it`);
    say(`   ${c.name}: installed`);
  }
  for (const f of c.files) {
    const g = run("rig", ["context", "get", `${c.name}/${f}`]);
    if (g.status !== 0 || !g.stdout.trim()) stop(`context ${c.name}/${f} is not retrievable (\`rig context get ${c.name}/${f}\` failed)`);
  }
  say(`   ${c.name}: ${c.files.length} file(s) retrievable with rig context get`);
}

// 5. Declared permission changes: shown always, applied only on request.
say("\n5. Permission changes this factory declares");
for (const p of F.permissions) {
  say(`   [${p.runtime}] ${p.files.join(", ")}`);
  say(`     effect: ${p.effect}`);
  say(`     status: ${p.tested ? `tested (${p.tested})` : "declared by the author, not yet tested"}`);
}
if (F.permissions.length && !o.applyPermissions) say("   NOT applied. Re-run with --apply-permissions to place them (they take effect when the rig starts).");
if (o.applyPermissions) for (const p of F.permissions) for (const rel of p.files) {
  const s = F.starter.find((x) => x.to === rel);
  if (!s) stop(`permission file ${rel} is not in the package`);
  const dst = path.join(project, rel);
  if (fs.existsSync(dst) && sha256(dst) !== sha256(path.join(PKG, s.from))) stop(`${rel} already exists in the project with different content — review it first`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(PKG, s.from), dst);
  say(`   applied ${rel}`);
}

// 6. Launch each rig: plan first (preflight only, launches nothing), then apply and launch.
say(`\n6. Launching (${o.profile} models)`);
// A member's terminal session is named <pod>-<member>@<rig>, and terminal
// sessions are shared by every OpenRig instance of the same OS user. So if this
// factory (or another rig with the same name) is already running, stop here
// with the reason, before OpenRig's own launch fails on the name.
for (const rig of F.rigs) for (const m of rig.members) {
  const [pod, member] = m.split(".");
  const session = `${pod}-${member}@${rig.name}`;
  if (run("tmux", ["has-session", "-t", `=${session}`]).status === 0) {
    stop(`a terminal session named ${session} already exists, so ${rig.name} (or another rig with that name) is already running for this user. Stop it first (\`rig down ${rig.name}\` in the OpenRig that owns it), or run this factory as another user.`);
  }
}
// Several rigs launch in FACTORY.json order into the same project. If one fails, the
// rigs before it are left running and named, so you can stop them (`rig down <name>`).
const started = [];
const stopLaunch = (m) => stop(started.length ? `${m}\nAlready running from this launch: ${started.join(", ")}` : m);
for (const rig of F.rigs) {
  const b = rig.bundles[o.profile];
  if (!b) stopLaunch(`rig ${rig.id} has no ${o.profile} bundle`);
  const abs = path.join(PKG, b.path);
  const ins = run("rig", ["bundle", "inspect", abs, "--json"]);
  let d; try { d = JSON.parse(ins.stdout); } catch { stopLaunch(`rig bundle inspect failed for ${b.path}: ${ins.stderr.trim()}`); }
  if (d.digestValid !== true || d.integrityResult?.passed !== true) stopLaunch(`${b.path} failed OpenRig's integrity check`);
  const plan = run("rig", ["up", abs, "--cwd", project, "--plan"]);
  if (plan.status !== 0) stopLaunch(`preflight for ${rig.id} failed:\n${(plan.stdout + plan.stderr).trim()}`);
  say(`   ${rig.id}: preflight ok`);
  if (o.planOnly) continue;
  const up = run("rig", ["up", abs, "--cwd", project, "--yes", "--json"]);
  let u; try { u = JSON.parse(up.stdout); } catch { u = null; }
  if (up.status !== 0 || !u || u.status !== "completed") stopLaunch(`launching ${rig.id} failed:\n${(up.stdout + up.stderr).trim().slice(0, 2000)}`);
  started.push(rig.name);
  say(`   ${rig.id}: launched`);
}
if (o.planOnly) { say("\nPlan only: nothing was launched."); process.exit(0); }

// 7. Verify the running factory the way it will be used, per member:
//    - running, with its startup files delivered (OpenRig reports startup "ready");
//    - on the model the chosen profile declares;
//    - working in the project directory (the install path persists; not a temp dir);
//    - its skills projected where ITS runtime reads them (Codex: .agents/skills,
//      Claude Code: .claude/skills), every file byte-identical to the package's
//      copy — OpenRig 0.6.1 can silently skip a Codex seat's skill;
//    and for the rig: its culture file projected into the project's instruction
//    files, and every starter file present and unchanged.
say("\n7. Verifying the running factory");
const walkFiles = (root) => fs.readdirSync(root, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkFiles(path.join(root, e.name)).map((p) => path.join(e.name, p)) : [e.name]);
const SKILL_DIR = { codex: ".agents/skills", "claude-code": ".claude/skills" };
const panes = run("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}"]).stdout.split("\n")
  .filter(Boolean).map((l) => l.split("\t"));
for (const rig of F.rigs) {
  const ps = run("rig", ["ps", "--nodes", "--rig", rig.name, "--json"]);
  let nodes; try { nodes = JSON.parse(ps.stdout); } catch { stop(`could not read \`rig ps --nodes --rig ${rig.name} --json\`: ${(ps.stderr || ps.stdout).trim()}`); }
  for (const m of rig.member_detail) {
    const n = nodes.find((x) => x.logicalId === m.id);
    if (!n) stop(`member ${m.id} of ${rig.name} is not running`);
    if (n.sessionStatus !== "running") stop(`member ${m.id} is ${n.sessionStatus}, not running`);
    if (n.startupStatus !== "ready") stop(`member ${m.id}'s startup files were not delivered (startup: ${n.startupStatus})`);
    const want = rig.models[o.profile]?.[m.id];
    if (want && want !== "runtime default" && n.model !== want) stop(`member ${m.id} runs ${n.model}, but the ${o.profile} profile declares ${want}`);
    const pane = panes.find(([sess]) => sess === n.canonicalSessionName);
    if (!pane || path.resolve(pane[1]) !== project) stop(`member ${m.id} is not working in ${project} (it is in ${pane ? pane[1] : "no pane"})`);
    for (const sk of m.skills) {
      const dir = SKILL_DIR[m.runtime];
      if (!dir) stop(`member ${m.id}: no known skill location for runtime ${m.runtime}`);
      if (!fs.existsSync(path.join(project, dir, sk, "SKILL.md"))) stop(`skill ${sk} was not projected for ${m.id} (expected ${dir}/${sk}/SKILL.md in the project)`);
      const from = path.join(PKG, m.agent_dir, "skills", sk);
      for (const rel of walkFiles(from)) {
        const got = path.join(project, dir, sk, rel);
        if (!fs.existsSync(got) || sha256(got) !== sha256(path.join(from, rel))) stop(`skill ${sk} for ${m.id}: ${dir}/${sk}/${rel} is missing or differs from the package`);
      }
    }
  }
  if (rig.culture) {
    const culture = path.basename(rig.culture);
    const projected = ["AGENTS.md", "CLAUDE.md"].some((f) => fs.existsSync(path.join(project, f)) &&
      fs.readFileSync(path.join(project, f), "utf8").includes(`MANAGED BLOCK: ${culture}`));
    if (!projected) stop(`${rig.name}'s culture file ${culture} was not projected into AGENTS.md or CLAUDE.md`);
  }
}
for (const s of F.starter) {
  if (permissionFiles.has(s.to) && !o.applyPermissions) continue;
  const p = path.join(project, s.to);
  if (!fs.existsSync(p) || sha256(p) !== sha256(path.join(PKG, s.from))) stop(`starter file ${s.to} is missing or changed in the project`);
}
const nMembers = F.rigs.reduce((n, r) => n + r.member_detail.length, 0);
const nSkills = F.rigs.reduce((n, r) => n + r.member_detail.reduce((k, m) => k + m.skills.length, 0), 0);
say(`   ${nMembers} member(s): running, startup ready, ${o.profile} models, in ${project}`);
say(`   ${nSkills} skill projection(s) present and byte-identical; culture projected; starter files intact`);
say(`   ${(F.context_packs ?? []).length} context pack(s) retrievable`);
say(`\nDone.${F.first_job ? ` Give the factory its first job:\n   ${F.first_job}` : ""}`);
say("See SETUP.md for customising models, harness and context.");
