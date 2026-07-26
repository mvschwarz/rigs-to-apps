#!/usr/bin/env node
// media-manager-smoke.mjs — hermetic package smoke for the Media Manager
// registry content, under owner-ruled OPTION C.
//
//   Option C: the registry package IS the canonical reviewed source of the
//   Media Manager surface; the box's SHARED export-server is the runtime
//   provider (named, never shipped or copied); the app declares no server.
//
// It proves, on DISPOSABLE roots only, that the package contract is present
// (Option-C manifest, README, byte-pinned surface, registry entry, the 12
// mechanically-derived verbs, the four no-rollback drift branches) AND that the
// packaged surface RENDERS through the REAL pinned shared export-server,
// LinkPix-dark, with a populated grid + a real version/lock/tag badge, the
// three named GETs answering, and the run is READ / RENDER ONLY.
//
// SAFETY (hard aborts, exit 3): DISPOSABLE $TMPDIR roots + a disposable
// CUTDOWN_API stub only; ABORT on any founder root, on the shared LIVE Studio
// Box path unless byte-pinned to the APPROVED source, and on a live :8795
// CUTDOWN_API. Non-GET /api requests are INTERCEPTED and ABORTED before they
// reach the server, then reported. Only the browser/server/stub processes IT
// OWNS are terminated (TERM then owned-PID KILL fallback) — never a global
// pkill, never cross-session cleanup. Node standard library only (node:crypto
// for hashing — no shelling out); puppeteer-core (scratch QA install) is
// imported LAZILY so the stdlib CONTRACT phase fails RED for a missing package
// with no browser dependency.
//
//   STUDIO_BOX_ROOT=<pinned studio-box checkout>  (or --studio-box <path>)
//   [REGISTRY_ROOT=<rigs-to-apps checkout>]        (or --registry-root; default: this tool's repo)
//   [MM_SHOT=<explicit screenshot output path>]    (or --shot; default: $TMPDIR)
//   node media-manager-smoke.mjs      # run TWICE — the second run is the test
//
// The ONE deliberate GREEN build invocation passes --shot at the committed
// asset to write it once; later proof runs default to $TMPDIR and NEVER rewrite
// an existing in-repo asset. MM_SMOKE_SELFTEST=boot-fail is a narrow self-test
// proving a boot failure reaches report() and exits nonzero.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHARED_LIVE_STUDIO_BOX = "/Users/wrandom/code/projects/studio-box";
// The approved reviewed source (Studio Box commit 31d56dc): the surface must
// equal THIS sha256 — pins reality so an arbitrary mutually-matching
// source/package pair cannot pass.
const APPROVED_SOURCE_COMMIT = "31d56dcea60ef9bf6b73a31f74059a1b0d1871de";
const APPROVED_SURFACE_SHA256 = "e9f7e1f80b7160e81b61a56521875cd07a12948b547dc97a77b920e569d92d4a";

function opt(flag, env) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[env];
}
const STUDIO_BOX_ROOT = opt("--studio-box", "STUDIO_BOX_ROOT");
const REGISTRY_ROOT = path.resolve(opt("--registry-root", "REGISTRY_ROOT") || path.resolve(HERE, ".."));
const MM_SHOT = opt("--shot", "MM_SHOT") || path.join(os.tmpdir(), `media-manager-smoke-${process.pid}.png`);
const SELFTEST = process.env.MM_SMOKE_SELFTEST || "";

const APP_DIR = path.join(REGISTRY_ROOT, "apps", "media-manager");
const TMPREAL = fs.realpathSync(os.tmpdir());
const HOME = os.homedir();
const FOUNDER_ROOTS = [HOME, path.join(HOME, "studio"), path.join(HOME, "openrig-videos"), SHARED_LIVE_STUDIO_BOX];

// A real, tiny PNG (green 8x8) so the fixture needs no external media.
const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNk+M+ABzAOZ2kAthsM/S2jQ9wAAAAASUVORK5CYII=",
  "base64");

function abort(msg) { console.error(`SMOKE ABORT (safety): ${msg}`); process.exit(3); }
function usage(msg) { console.error(`media-manager-smoke: ${msg}`); process.exit(2); }

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function pngDims(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIG)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// Every server root MUST resolve under the real $TMPDIR and never inside a
// founder/live root.
function assertDisposable(p, label) {
  const abs = path.resolve(p);
  const parentReal = fs.realpathSync(path.dirname(abs));
  if (!(parentReal === TMPREAL || parentReal.startsWith(TMPREAL + path.sep))) abort(`${label} is not under $TMPDIR (${abs})`);
  for (const f of FOUNDER_ROOTS) if (abs === f || abs.startsWith(f + path.sep)) abort(`${label} resolves inside a founder/live root ${f} (${abs})`);
}

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); return ok; };

async function poll(fn, timeoutMs = 15000, everyMs = 250) {
  const until = Date.now() + timeoutMs; let last;
  while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, everyMs)); }
  return null;
}

// ---- preconditions (usage / safety) ----
if (!STUDIO_BOX_ROOT) usage("STUDIO_BOX_ROOT (or --studio-box) is required — pin the Studio Box checkout that provides the shared export-server");
const SB = path.resolve(STUDIO_BOX_ROOT);
const EXPORT_SERVER = path.join(SB, "app", "tools", "timeline-export", "export-server.mjs");
if (!fs.existsSync(EXPORT_SERVER)) abort(`no shared export-server at ${EXPORT_SERVER} — STUDIO_BOX_ROOT must be a real Studio Box checkout`);
// Reject the shared LIVE Studio Box working tree unless it is byte-pinned to
// the APPROVED reviewed source.
if (fs.existsSync(SHARED_LIVE_STUDIO_BOX) && fs.realpathSync(SB) === fs.realpathSync(SHARED_LIVE_STUDIO_BOX)) {
  const boxSurface = path.join(SB, "app", "media-manager.html");
  if (!(fs.existsSync(boxSurface) && sha256(boxSurface) === APPROVED_SURFACE_SHA256))
    abort("STUDIO_BOX_ROOT is the shared live checkout and is NOT byte-pinned to the APPROVED source — use a detached pinned worktree");
}

const WANT_VERBS = ["GET /api/project-assets","GET /api/curation","GET /api/tags","POST /api/tags","POST /api/selections","GET /api/library","GET /api/library/media","GET /api/media","GET /api/exports","POST /api/focus","POST /api/library/route","GET /api/patch"];
const FORBIDDEN_FIELDS = ["source","version","pricing","deps","dependencies","review","fork","forked_from","stats","installs","forks","stars","readme"];

function report() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? "SMOKE FAIL" : "SMOKE PASS"}: ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

// Terminate ONLY the processes we own (browser, server, stub). TERM first, then
// an owned-PID KILL fallback; await each. No global pkill, no cross-session act.
async function shutdownOwned(server, browser, stub) {
  if (browser) { try { await browser.close(); } catch { /* own browser */ } }
  if (server) {
    await new Promise((resolve) => {
      let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
      server.once("exit", fin);
      try { server.kill("SIGTERM"); } catch { fin(); }
      setTimeout(() => { try { server.kill("SIGKILL"); } catch { /* already gone */ } fin(); }, 3000);
    });
  }
  if (stub) { await new Promise((resolve) => { try { stub.close(() => resolve()); } catch { resolve(); } }); }
}

async function runtime({ forceBootFail = false } = {}) {
  const sliceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-smoke-slice-"));
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-smoke-lib-"));
  assertDisposable(sliceRoot, "slice-root");
  assertDisposable(mediaRoot, "media-root");
  const canvasRoot = path.join(sliceRoot, "canvases");
  assertDisposable(canvasRoot, "canvas-root");
  fs.mkdirSync(path.join(sliceRoot, "media", "images"), { recursive: true });
  fs.writeFileSync(path.join(sliceRoot, "media", "images", "sample-1.png"), SAMPLE_PNG);
  fs.writeFileSync(path.join(sliceRoot, "media", "images", "sample-2.png"), SAMPLE_PNG);
  fs.writeFileSync(path.join(sliceRoot, "timeline.json"), JSON.stringify({ audio_master: null, sequence: [], _note: "disposable mm-smoke fixture" }, null, 2));
  fs.mkdirSync(path.join(mediaRoot, "library"), { recursive: true });

  // disposable CUTDOWN_API stub — NEVER the live :8795. Returns a cut whose
  // locked version file matches a fixture asset so a version+lock BADGE renders.
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ cuts: [{ file: "cut-1", pick: "smooth", note: "smoke", versions: [{ key: "smooth", file: "sample-1.png" }] }], cutting: [], failed: [] }));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = stub.address().port;
  const CUTDOWN_API = `http://127.0.0.1:${stubPort}`;
  if (stubPort === 8795) abort("CUTDOWN_API stub bound the live :8795 — refusing");

  const srvPort = 8930 + (process.pid % 50);
  const base = `http://127.0.0.1:${srvPort}`;
  let server = null, browser = null;
  try {
    if (!forceBootFail) {
      server = spawn(process.execPath, [EXPORT_SERVER,
        "--port", String(srvPort), "--host", "127.0.0.1",
        "--slice-root", sliceRoot, "--media-root", mediaRoot, "--canvas-root", canvasRoot,
      ], { env: { ...process.env, CUTDOWN_API }, stdio: "ignore" });
    }
    const up = await poll(async () => { try { const r = await fetch(`${base}/api/project-assets`); return r.status === 200 ? r : null; } catch { return null; } }, forceBootFail ? 2500 : 15000);
    if (check("runtime: shared export-server boots on disposable roots (GET /api/project-assets 200)", Boolean(up))) {
      const pa = await (await fetch(`${base}/api/project-assets`)).json();
      const tags = await fetch(`${base}/api/tags`);
      const cur = await fetch(`${base}/api/curation`);
      check("runtime: GET /api/project-assets, /api/tags, /api/curation answer via the shared provider",
        Array.isArray(pa?.assets) && tags.status === 200 && cur.status === 200, `assets=${pa?.assets?.length} tags=${tags.status} curation=${cur.status}`);

      const puppeteer = (await import("puppeteer-core")).default; // scratch QA install, lazy
      browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--no-first-run", "--disable-gpu"] });
      const page = await browser.newPage();
      await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: 1 });
      // INTERCEPT non-GET /api and ABORT before it reaches the server, then report.
      await page.setRequestInterception(true);
      const violations = [];
      page.on("request", (r) => {
        if (/\/api\//.test(r.url()) && r.method() !== "GET") { violations.push(`${r.method()} ${r.url().replace(base, "")}`); return r.abort(); }
        return r.continue();
      });
      await page.goto(`${base}/media-manager.html`, { waitUntil: "networkidle0" });

      const style = await page.evaluate(() => { const b = getComputedStyle(document.body); return { bg: b.backgroundColor, font: b.fontFamily }; });
      check("runtime: LinkPix computed styles (body #121214 ground, Helvetica)", style.bg === "rgb(18, 18, 20)" && /helvetica/i.test(style.font), `bg=${style.bg} font=${style.font}`);

      const tiles = await poll(async () => { const n = await page.$eval("#grid", (el) => el.childElementCount).catch(() => 0); return n > 0 ? n : null; }, 12000);
      check("runtime: library grid renders a populated tile grid", Boolean(tiles), `#grid children=${tiles || 0}`);

      const badges = await poll(async () => { const n = await page.$$eval("#grid .tile .badge.ver, #grid .tile .badge.lk, #grid .tile .badge.tag", (els) => els.length).catch(() => 0); return n > 0 ? n : null; }, 12000);
      check("runtime: at least one visible version/lock/tag badge renders (not only grid children)", Boolean(badges), `badges=${badges || 0}`);

      check("runtime: browser flow is read/render-only (non-GET /api intercepted+aborted; zero occurred)", violations.length === 0, violations.slice(0, 4).join(", ") || "none");

      // Screenshot: the ONE deliberate GREEN build invocation writes the committed
      // asset (via --shot); later proof runs default to $TMPDIR and NEVER rewrite
      // an already-committed in-repo asset.
      const shotAbs = path.resolve(MM_SHOT);
      const inRepo = shotAbs === REGISTRY_ROOT || shotAbs.startsWith(REGISTRY_ROOT + path.sep);
      if (inRepo && fs.existsSync(shotAbs)) {
        const d = pngDims(fs.readFileSync(shotAbs));
        check(`runtime: committed proof asset preserved, valid PNG (not rewritten): ${MM_SHOT}`, Boolean(d) && d.w > 0 && d.h > 0, d ? `${d.w}x${d.h}` : "not a valid PNG");
      } else {
        fs.mkdirSync(path.dirname(shotAbs), { recursive: true });
        await page.screenshot({ path: shotAbs, fullPage: true });
        const d = fs.existsSync(shotAbs) ? pngDims(fs.readFileSync(shotAbs)) : null;
        check(`runtime: populated proof screenshot written, valid PNG (${MM_SHOT})`, Boolean(d) && d.w > 0 && d.h > 0, d ? `${d.w}x${d.h}` : "missing/invalid PNG");
      }

      check("runtime: inert — all server roots disposable $TMPDIR + CUTDOWN_API stub (no founder state targeted)", true, "structural");
    }
    // boot failure: the FAIL above is recorded; flow falls through to cleanup + report.
  } finally {
    await shutdownOwned(server, browser, stub);
    try { fs.rmSync(sliceRoot, { recursive: true, force: true }); } catch { /* disposable */ }
    try { fs.rmSync(mediaRoot, { recursive: true, force: true }); } catch { /* disposable */ }
  }
}

async function run() {
  // Narrow self-test: prove a runtime boot failure reaches report() and exits
  // nonzero (guards against the false-green early-return).
  if (SELFTEST === "boot-fail") { await runtime({ forceBootFail: true }); return report(); }

  // ================= CONTRACT phase (pure stdlib; RED lives here) =================
  const appJsonPath = path.join(APP_DIR, "app.json");
  const readmePath = path.join(APP_DIR, "README.md");
  const surfacePath = path.join(APP_DIR, "app", "media-manager.html");
  const registryPath = path.join(REGISTRY_ROOT, "registry.json");

  const present = fs.existsSync(appJsonPath) && fs.existsSync(readmePath) && fs.existsSync(surfacePath);
  if (!check("contract: apps/media-manager/{app.json,README.md,app/media-manager.html} present", present,
      `app.json=${fs.existsSync(appJsonPath)} README.md=${fs.existsSync(readmePath)} surface=${fs.existsSync(surfacePath)}`)) {
    return report(); // RED before the package exists — stop before spawning anything
  }

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(appJsonPath, "utf8")); }
  catch (e) { check("contract: app.json parses", false, String(e.message)); return report(); }

  check("contract: Option-C manifest (id media-manager, NO install.server, destination ~/studio/apps/media-manager, surface app/media-manager.html)",
    manifest.id === "media-manager" && !(manifest.install && manifest.install.server)
      && manifest.install?.destination === "~/studio/apps/media-manager"
      && manifest.install?.surface?.entry === "app/media-manager.html",
    `id=${manifest.id} hasServer=${Boolean(manifest.install?.server)} dest=${manifest.install?.destination}`);

  const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, "utf8")) : [];
  check("contract: registry.json lists apps/media-manager/app.json", Array.isArray(registry) && registry.includes("apps/media-manager/app.json"), JSON.stringify(registry));

  // Pin reality: BOTH the pinned source and the packaged surface must equal the
  // APPROVED reviewed sha256 — an arbitrary mutually-matching pair cannot pass.
  const srcSurface = path.join(SB, "app", "media-manager.html");
  const srcSha = fs.existsSync(srcSurface) ? sha256(srcSurface) : "(absent)";
  const pkgSha = sha256(surfacePath);
  check(`contract: source + packaged media-manager.html both equal the APPROVED sha256 (source commit ${APPROVED_SOURCE_COMMIT.slice(0, 12)})`,
    srcSha === APPROVED_SURFACE_SHA256 && pkgSha === APPROVED_SURFACE_SHA256, `pkg=${pkgSha.slice(0, 12)} src=${srcSha.slice(0, 12)} approved=${APPROVED_SURFACE_SHA256.slice(0, 12)}`);

  const driftText = fs.readFileSync(readmePath, "utf8") + "\n" + JSON.stringify(manifest.install?.verify || []);
  const branches = [
    ["compare", [/\bcompare\b/i]],
    ["missing/broken/older -> repair", [/(missing|broken|older)/i, /\brepair\b/i]],
    ["newer/forward drift -> leave + report", [/(newer|forward drift)/i, /(leave|untouched)/i, /\breport\b/i]],
    ["ambiguous -> leave + report", [/ambiguou/i, /(leave|untouched|report)/i]],
  ];
  const missingBranches = branches.filter(([, res]) => !res.every((re) => re.test(driftText))).map(([n]) => n);
  check("contract: README + install.verify carry the four drift branches (compare / repair-if-older / never-overwrite-newer / ambiguous-report)", missingBranches.length === 0, missingBranches.join("; ") || "all present");

  const verbList = Array.isArray(manifest.verbs) ? manifest.verbs : [];
  const verbSet = new Set(verbList.map((v) => `${v.method} ${v.path}`));
  check("contract: exactly the 12 mechanically-derived verbs (length AND set)", verbList.length === 12 && verbSet.size === 12 && WANT_VERBS.every((v) => verbSet.has(v)),
    `length=${verbList.length} set=${verbSet.size}; missing ${WANT_VERBS.filter((v) => !verbSet.has(v)).join(",") || "none"}`);
  check("contract: no forbidden schema fields", !FORBIDDEN_FIELDS.some((k) => k in manifest), FORBIDDEN_FIELDS.filter((k) => k in manifest).join(",") || "clean");

  // ================= RUNTIME phase =================
  await runtime({});
  return report();
}

run().catch((e) => { console.error(`smoke crashed: ${e && e.stack || e}`); process.exit(1); });
