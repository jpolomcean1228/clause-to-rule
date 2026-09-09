#!/usr/bin/env node
/**
 * Intake classification.
 *
 * Eleven questions asked before anyone reads a document. Each answer is known in advance to
 * trigger specific downstream work with a named owner, so the output is not a completed form —
 * it is the set of dependencies that just came into existence, and who has to start on them.
 *
 * Deterministic. No model calls, no network, no API key.
 *
 *   node intake/route.mjs intake/examples/straightforward.json
 *   node intake/route.mjs intake/examples/complex.json
 *   node intake/route.mjs --questions
 *   node intake/route.mjs <answers.json> --json
 *
 * A question earns a place in the questionnaire only if the answer changes what somebody has to
 * do. Everything else is a field on a form, and forms are where onboarding time goes to hide.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const showQuestions = args.includes("--questions");
const inputPath = args.find(a => !a.startsWith("--"));

const q = JSON.parse(fs.readFileSync(path.join(DIR, "questionnaire.json"), "utf8"));

if (showQuestions) {
  console.log("\n  INTAKE QUESTIONS\n");
  for (const question of q.questions) {
    console.log("  " + question.id + " — " + question.prompt);
    for (const o of question.options) {
      console.log("      " + o.value.padEnd(26) + o.label + (o.exception ? "   [exception path]" : ""));
    }
    console.log("");
  }
  process.exit(0);
}

if (!inputPath) {
  console.error("Usage: node intake/route.mjs <answers.json> [--json]\n       node intake/route.mjs --questions");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const answers = raw.answers || raw;
const clientName = raw.client || path.basename(inputPath, ".json");

/* ---------- resolve ---------- */

const resolved = [];
const unanswered = [];
const invalid = [];

for (const question of q.questions) {
  const given = answers[question.id];
  if (given == null || given === "") { unanswered.push(question); continue; }
  const option = question.options.find(o => o.value === given);
  if (!option) { invalid.push({ question, given }); continue; }
  resolved.push({ question, option });
}

if (invalid.length) {
  for (const { question, given } of invalid) {
    console.error("Unrecognised answer for " + question.id + ": \"" + given + "\"");
    console.error("  Expected one of: " + question.options.map(o => o.value).join(", "));
  }
  process.exit(1);
}

const drivers = resolved.filter(r => r.option.exception);
const weight = resolved.reduce((a, r) => a + (r.option.weight || 0), 0);
const overThreshold = weight >= q.routing.weight_threshold;
const path_ = drivers.length || overThreshold ? "exception" : "template";

const work = [];
for (const r of resolved) {
  for (const t of (r.option.triggers || [])) {
    work.push({ ...t, from: r.question.id, because: r.option.label });
  }
}
// Same dependency triggered by two answers is one piece of work, not two.
const deduped = [];
for (const w of work) {
  const hit = deduped.find(d => d.item === w.item && d.owner === w.owner);
  if (hit) hit.because += "; " + w.because;
  else deduped.push({ ...w });
}
deduped.sort((a, b) => b.lead_time_days - a.lead_time_days);

if (asJson) {
  console.log(JSON.stringify({
    client: clientName, path: path_, weight,
    drivers: drivers.map(d => ({ question: d.question.id, answer: d.option.label, note: d.option.note || null })),
    unanswered: unanswered.map(u => u.id),
    work: deduped
  }, null, 2));
  process.exit(0);
}

/* ---------- report ---------- */

console.log("\n" + "=".repeat(74));
console.log("  INTAKE CLASSIFICATION — " + clientName);
console.log("=".repeat(74) + "\n");

if (unanswered.length) {
  console.log("  NOT YET ANSWERED — classification is provisional\n");
  for (const u of unanswered) console.log("    " + u.id.padEnd(20) + u.prompt);
  console.log("");
}

console.log("  PATH: " + path_.toUpperCase() +
  (path_ === "template" ? "   — runs on the standard track" : "   — needs a named owner and a bespoke plan"));
console.log("  Complexity weight " + weight + " against a threshold of " + q.routing.weight_threshold + ".\n");

if (drivers.length) {
  console.log("  WHY IT IS OFF THE TEMPLATE PATH\n");
  for (const d of drivers) {
    console.log("    " + d.question.id.padEnd(20) + d.option.label);
    if (d.option.note) console.log("      " + d.option.note);
  }
  console.log("");
} else if (path_ === "exception") {
  console.log("  No single answer is unusual, but they add up. Individually ordinary answers still");
  console.log("  produce a mandate that should not run on the standard track.\n");
} else {
  console.log("  Nothing here requires bespoke handling. Run it on the template.\n");
}

console.log("  LONG POLES\n");
for (const w of deduped.slice(0, 5)) {
  console.log("    " + String(w.lead_time_days + "d").padStart(5) + "  " + w.item);
  console.log("           " + w.owner + " — triggered by: " + w.because);
}
console.log("");

console.log("  DEPENDENCIES BY OWNER\n");
const byOwner = {};
for (const w of deduped) (byOwner[w.owner] ||= []).push(w);
for (const [owner, items] of Object.entries(byOwner).sort((a, b) =>
  Math.max(...b[1].map(i => i.lead_time_days)) - Math.max(...a[1].map(i => i.lead_time_days)))) {
  console.log("  " + owner + " (" + items.length + ")");
  for (const w of items) console.log("    " + String(w.lead_time_days + "d").padStart(5) + "  " + w.item);
  console.log("");
}

const longest = deduped.length ? deduped[0] : null;
console.log("  " + "-".repeat(70));
console.log("  " + deduped.length + " dependencies across " + Object.keys(byOwner).length + " teams, known before anyone opens the document.");
if (longest) {
  console.log("  The critical path runs through " + longest.owner.toLowerCase() + ": " + longest.item.toLowerCase() + ".");
}
console.log("");
console.log("  Lead times are nominal and belong to this repo, not to any real operation. Replace them");
console.log("  with measured cycle times and this stops being an illustration and starts being a");
console.log("  forecast. The structure is the point: every one of these was knowable on day one.\n");
