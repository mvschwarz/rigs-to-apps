#!/usr/bin/env node
// Install-request FORMATTER — emits a plain-text request the box owner pastes
// to their OWN box's lead agent. Slice 14 emits the STRING only; it never
// contacts a box, mints no qitem, holds no secret. The trusted lead agent inside
// the box's trust boundary acts on it with judgment (concierge is the alt path).
//
//   node tools/format-install-request.mjs --repo <label|url> --manifest <path>
//
// Deliberately contains NO token/secret, NO callback URL, and NO direct
// network call — asserted by the probe's forbidden-network regex. The verb
// list is printed WITHOUT HTTP method words so the request stays a description,
// never an executable instruction.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repo = arg("--repo");
const manifestPath = arg("--manifest");
if (!repo || !manifestPath) {
  console.error("usage: format-install-request.mjs --repo <label|url> --manifest <path>");
  process.exit(1);
}

let m;
try { m = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
catch (e) { console.error(`cannot read manifest: ${String(e.message)}`); process.exit(1); }

const surface = (m.install && m.install.surface) || {};
const hasServer = !!(m.install && m.install.server);
const verify = (m.install && m.install.verify) || [];
const verbs = Array.isArray(m.verbs) ? m.verbs : [];
const destination = (m.install && m.install.destination) || `~/studio/apps/${m.id}`;

const lines = [];
lines.push(`Install request — ${m.name || m.id}`);
lines.push("");
lines.push(`App id:        ${m.id}`);
lines.push(`Registry repo: ${repo}`);
lines.push(`Manifest path: ${manifestPath}`);
lines.push("");
lines.push("Please install this mini-app onto my studio box:");
lines.push(`  1. Retrieve ${m.id}'s app.json from the registry repo (${repo}) at ${manifestPath},`);
lines.push("     then resolve and record its current commit SHA for provenance.");
lines.push("  2. Apply judgment: check for name and port collisions with what's already");
lines.push(`     installed, and place it in a sensible sidebar group (category default: ${m.category}).`);
lines.push(`  3. Install the app directory to ${destination}.`);
lines.push(`  4. Register its surfaces door: route ${surface.path || "(none)"} with the`);
lines.push(`     ${surface.glyph || "•"} glyph, grouped under the ${m.category} default group.`);
if (hasServer) {
  lines.push("  5. Start its server per install.server (bind the preferred port unless taken).");
} else {
  lines.push("  5. No server — this is a pure static surface.");
}
lines.push("  6. Then verify:");
for (const v of verify) lines.push(`       - ${v}`);
if (verbs.length) {
  lines.push("");
  lines.push("Verbs this app exposes (for reference, method omitted):");
  for (const v of verbs) lines.push(`  ${v.path} — ${v.purpose}`);
}
lines.push("");
lines.push("(You are my trusted box lead agent; act inside the box. Nothing here calls out.)");

console.log(lines.join("\n"));
