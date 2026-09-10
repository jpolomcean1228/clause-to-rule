#!/usr/bin/env node
/**
 * Routing audit.
 *
 * Runs the console's own routing logic over extracted output and shows what each decision rests
 * on. The question this exists to answer is "how do you know the confidence scores mean anything",
 * and the answer is that routing mostly does not depend on them.
 *
 * Three of the four signals are checkable without trusting the model: whether it filled the
 * parameters its archetype expects, whether it dropped a parameter a prior account carried, and
 * what the source text looks like. The model's own confidence carries the smallest weight,
 * because a model's self-report about its own reliability is precisely the claim you should not
 * take at face value.
 *
 * Deterministic. No model calls, no network, no API key. The routing code is parsed out of
 * index.html between the ROUTING markers rather than duplicated — the same reason the eval parses
 * the prompt from there.
 *
 *   node routing/audit.mjs readiness/examples/meridian-extracted.json
 *   node routing/audit.mjs readiness/examples/calder-extracted.json --verbose
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..");
const args = process.argv.slice(2);
const inputPath = args.find(a => !a.startsWith("--"));
const verbose = args.includes("--verbose");

if (!inputPath) {
  console.error("Usage: node routing/audit.mjs <extracted.json> [--verbose]");
  process.exit(1);
}

/* ---------- load the console's routing logic ---------- */

function loadRouting() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const arch = html.match(/const ARCHETYPES = (\[[\s\S]*?\n\];)/);
  const prec = html.match(/const PRECEDENTS = (\[[\s\S]*?\n\];)/);
  const block = html.match(/\/\* --- ROUTING:START[\s\S]*?--- \*\/([\s\S]*?)\/\* --- ROUTING:END --- \*\//);
  if (!arch || !prec || !block) {
    throw new Error("Could not find ARCHETYPES, PRECEDENTS or the ROUTING block in index.html.");
  }
  const src =
    "const ARCHETYPES = " + arch[1] +
    "const PRECEDENTS = " + prec[1] +
    block[1] +
    "\nreturn { assess, COMPLEXITY_TESTS, SIGNAL_WEIGHTS };";
  return new Function(src)();
}

const { assess, SIGNAL_WEIGHTS } = loadRouting();

const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const clauses = (input.clauses || input.proposals || input).filter(c => c.classification === "RESTRICTION");

if (!clauses.length) {
  console.error("No restriction clauses in " + inputPath + ".");
  process.exit(1);
}

/* ---------- the model-only baseline, for comparison ---------- */

function modelOnlyTier(p) {
  if ((p.ambiguities || []).length > 0 || p.confidence < 0.6) return "escalate";
  if (p.confidence < 0.85) return "review";
  return "auto";
}

const rows = clauses.map(c => {
  const a = assess(c);
  return {
    id: (c.clause && c.clause.id) || c.id || "?",
    archetype: c.archetype_id || "(unmatched)",
    ...a,
    modelTier: modelOnlyTier(c),
    modelConfidence: c.confidence
  };
});

/* ---------- report ---------- */

const TIER = { auto: "fast approve", review: "analyst review", escalate: "escalate" };
const bar = v => "█".repeat(Math.round(v * 12)).padEnd(12, "·");

console.log("\n" + "=".repeat(76));
console.log("  ROUTING AUDIT");
console.log("  source: " + path.basename(inputPath) + "   restrictions: " + rows.length);
console.log("=".repeat(76) + "\n");

console.log("  SIGNAL WEIGHTS\n");
for (const [k, v] of Object.entries(SIGNAL_WEIGHTS)) {
  const verifiable = k !== "model";
  console.log("    " + k.padEnd(16) + v.toFixed(2) + "   " + (verifiable ? "checkable without the model" : "the model's own claim"));
}
const verifiableShare = Object.entries(SIGNAL_WEIGHTS).filter(([k]) => k !== "model").reduce((a, [, v]) => a + v, 0);
console.log("\n    " + Math.round(verifiableShare * 100) + "% of the routing decision rests on evidence independent of the model.\n");

console.log("  BY CLAUSE\n");
for (const r of rows) {
  const flag = r.tier !== r.modelTier ? "  <-- differs from model-only routing" : "";
  console.log("  " + r.id.padEnd(6) + TIER[r.tier].padEnd(16) + r.archetype + flag);
  console.log("         composite " + Math.round(r.composite * 100) + "%   " +
    "complete " + Math.round(r.signals.completeness * 100) + "%  " +
    "precedent " + (r.signals.precedent === null ? "n/a" : Math.round(r.signals.precedent * 100) + "%") + "  " +
    "clarity " + Math.round(r.signals.clarity * 100) + "%  " +
    "model " + Math.round(r.signals.model * 100) + "%");
  if (verbose) {
    for (const [k, v] of Object.entries(r.signals)) {
      if (v === null) { console.log("           " + k.padEnd(14) + "no precedent"); continue; }
      console.log("           " + k.padEnd(14) + bar(v) + " " + Math.round(v * 100) + "%");
    }
  }
  for (const h of r.hits) console.log("         text: " + h.label);
  for (const why of (r.hard || [])) console.log("         escalates: " + why);
  for (const why of (r.soft || [])) console.log("         needs review: " + why);
  console.log("");
}

/* ---------- the headline comparison ---------- */

const disagree = rows.filter(r => r.tier !== r.modelTier);
const modelSaysAuto = rows.filter(r => r.modelTier === "auto");
const caughtByEvidence = modelSaysAuto.filter(r => r.tier !== "auto");

console.log("  " + "-".repeat(72));
console.log("  MODEL-ONLY ROUTING vs SIGNAL ROUTING\n");
for (const t of ["auto", "review", "escalate"]) {
  console.log("    " + TIER[t].padEnd(16) +
    "model-only " + String(rows.filter(r => r.modelTier === t).length).padStart(2) +
    "     signals " + String(rows.filter(r => r.tier === t).length).padStart(2));
}
console.log("");
if (caughtByEvidence.length) {
  console.log("  " + caughtByEvidence.length + " clause(s) the model was confident enough to fast-approve, held back by");
  console.log("  evidence it does not control: " + caughtByEvidence.map(r => r.id).join(", ") + "\n");
  for (const r of caughtByEvidence) {
    console.log("    " + r.id + " — model said " + Math.round(r.modelConfidence * 100) + "%. " + r.reasons.join("; "));
  }
  console.log("");
} else if (disagree.length) {
  console.log("  " + disagree.length + " clause(s) routed differently once verifiable signals are included.\n");
} else {
  console.log("  On this document the two agree. That is a result, not a guarantee — it holds for");
  console.log("  these clauses and says nothing about the next mandate.\n");
}

console.log("  This audit does not prove the model's confidence is calibrated. It shows that routing");
console.log("  would still function if it were not. Calibration is measured by eval/run.mjs, which");
console.log("  needs an API key; this does not.\n");
