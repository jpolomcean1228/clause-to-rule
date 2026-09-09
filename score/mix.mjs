#!/usr/bin/env node
/**
 * Mandate composition score.
 *
 * Splits extracted restrictions three ways against the precedent corpus:
 *
 *   configuration   an archetype match whose parameter shape is exactly what a prior account
 *                   already coded. Only the values are this client's. Fill in the blanks
 *   parameterised   an archetype match, but the shape differs — this client needs a parameter
 *                   no precedent carries, or drops one every precedent has. Requires thought
 *   novel           nothing to work from: no archetype match, an archetype the book has never
 *                   coded, or no parameter in common with any precedent
 *
 * The split is on shape, not on values. A 5% cap where precedent says 4% is not extra work —
 * it is the same rule with a different number, which is the entire premise of the tool. What
 * costs time is a rule whose fields do not line up with anything coded before.
 *
 * Deterministic. No model calls, no network, no API key. Precedents are parsed out of
 * index.html rather than duplicated, for the same reason the eval parses the prompt there:
 * a second copy drifts.
 *
 *   node score/mix.mjs readiness/examples/meridian-extracted.json
 *   node score/mix.mjs <file> --json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..");
const args = process.argv.slice(2);
const inputPath = args.find(a => !a.startsWith("--"));
const asJson = args.includes("--json");

if (!inputPath) {
  console.error("Usage: node score/mix.mjs <extracted.json> [--json]");
  process.exit(1);
}

/* ---------- precedent corpus, read from the console ---------- */

function loadPrecedents() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const m = html.match(/const PRECEDENTS = (\[[\s\S]*?\n\];)/);
  if (!m) throw new Error("Could not find PRECEDENTS in index.html. If the console was refactored, update loadPrecedents().");
  return new Function("return " + m[1].replace(/;$/, ""))();
}

const PRECEDENTS = loadPrecedents();
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const clauses = Array.isArray(input) ? input : (input.clauses || input.proposals || []);
const restrictions = clauses.filter(c => c.classification === "RESTRICTION");

if (!restrictions.length) {
  console.error("No restriction clauses in " + inputPath + ".");
  process.exit(1);
}

/* ---------- classification ---------- */

const normName = n => String(n || "").toLowerCase().replace(/[^a-z]/g, "");
const normVal = v => String(v == null ? "" : v).toLowerCase().replace(/\s+/g, " ").trim();

// Nominal effort weights. These are assumptions, not measurements — see the caveat printed
// with the report. They exist to make the point that a count-based split understates novel work.
const EFFORT = { configuration: 1, parameterised: 2, novel: 5 };

function classify(rule) {
  if (!rule.archetype_id) {
    return { tier: "novel", reason: "no archetype match — the restriction grammar does not cover this clause" };
  }
  const pool = PRECEDENTS.filter(p => p.archetype_id === rule.archetype_id);
  if (!pool.length) {
    return { tier: "novel", reason: "archetype exists in the library but has never been coded for an account" };
  }
  const params = rule.parameters || [];
  const names = params.map(p => normName(p.name));
  let best = null;
  for (const cand of pool) {
    const candNames = cand.parameters.map(p => normName(p.name));
    const shared = candNames.filter(n => names.includes(n)).length;
    const onlyHere = names.filter(n => !candNames.includes(n)).length;
    const onlyThere = candNames.filter(n => !names.includes(n)).length;
    const sameValues = cand.parameters.filter(p =>
      params.some(x => normName(x.name) === normName(p.name) && normVal(x.value) === normVal(p.value))).length;
    const cmp = { cand, shared, onlyHere, onlyThere, sameValues, drift: onlyHere + onlyThere };
    // Prefer the precedent whose shape lines up best, then the one whose values agree most.
    if (!best || cmp.drift < best.drift || (cmp.drift === best.drift && cmp.sameValues > best.sameValues)) best = cmp;
  }
  if (best.shared === 0) {
    return { tier: "novel", reason: "same archetype as " + best.cand.account + ", but no parameter in common", precedent: best.cand };
  }
  if (best.drift === 0) {
    return {
      tier: "configuration",
      reason: "same shape as " + best.cand.account + " — " + best.shared + " parameter(s), " +
        best.sameValues + " at identical values, the rest are this client's numbers",
      precedent: best.cand
    };
  }
  const bits = [];
  if (best.onlyHere) bits.push(best.onlyHere + " parameter(s) no precedent carries");
  if (best.onlyThere) bits.push(best.onlyThere + " that " + best.cand.account + " has and this does not");
  return {
    tier: "parameterised",
    reason: "shape differs from " + best.cand.account + ": " + bits.join(", "),
    precedent: best.cand
  };
}

const scored = restrictions.map(r => ({
  id: (r.clause && r.clause.id) || r.id || "?",
  archetype: r.archetype_id || "(unmatched)",
  ...classify(r)
}));

/* ---------- aggregates ---------- */

const tiers = ["configuration", "parameterised", "novel"];
const counts = Object.fromEntries(tiers.map(t => [t, scored.filter(s => s.tier === t).length]));
const total = scored.length;
const pct = n => Math.round((100 * n) / total) + "%";

const effortTotal = scored.reduce((a, s) => a + EFFORT[s.tier], 0);
const effortShare = Object.fromEntries(tiers.map(t =>
  [t, Math.round((100 * counts[t] * EFFORT[t]) / effortTotal) + "%"]));

// Parameter-level reuse, a finer measure than the clause-level split
let paramsTotal = 0, paramsMatched = 0;
for (const r of restrictions) {
  const c = classify(r);
  if (!c.precedent) { paramsTotal += (r.parameters || []).length; continue; }
  for (const p of (r.parameters || [])) {
    paramsTotal++;
    if (c.precedent.parameters.some(x => normName(x.name) === normName(p.name) && normVal(x.value) === normVal(p.value))) paramsMatched++;
  }
}

const corpusAccounts = new Set(PRECEDENTS.map(p => p.account)).size;

if (asJson) {
  console.log(JSON.stringify({
    total, counts, share: Object.fromEntries(tiers.map(t => [t, pct(counts[t])])),
    effort_share: effortShare,
    parameter_reuse: { matched: paramsMatched, total: paramsTotal },
    corpus: { rules: PRECEDENTS.length, accounts: corpusAccounts },
    clauses: scored
  }, null, 2));
  process.exit(0);
}

/* ---------- report ---------- */

const bar = n => "█".repeat(Math.round((n / total) * 40));

console.log("\n" + "=".repeat(70));
console.log("  MANDATE COMPOSITION");
console.log("  source: " + path.basename(inputPath) + "   restrictions scored: " + total);
console.log("=".repeat(70) + "\n");

const LABEL = {
  configuration: "Configuration ",
  parameterised: "Parameterised",
  novel: "Novel        "
};
for (const t of tiers) {
  console.log("  " + LABEL[t] + "  " + String(pct(counts[t])).padStart(4) + "  (" + counts[t] + "/" + total + ")  " + bar(counts[t]));
}

console.log("\n  " + (Math.round((100 * (counts.configuration + counts.parameterised)) / total)) +
  "% of this mandate's restrictions map onto rules the book has coded before.");
console.log("  " + pct(counts.configuration) + " needs nothing but this client's numbers filled into a known shape.");
console.log("  " + pct(counts.novel) + " has no precedent to work from.\n");

console.log("  Parameter-level reuse: " + paramsMatched + " of " + paramsTotal +
  " extracted parameters exactly match a prior account.\n");

console.log("  WEIGHTED BY EFFORT\n");
for (const t of tiers) {
  console.log("  " + LABEL[t] + "  " + String(effortShare[t]).padStart(4) + "  (weight " + EFFORT[t] + ")");
}
console.log("\n  Novel rules are " + pct(counts.novel) + " of the count but " + effortShare.novel +
  " of the work under these weights.");
console.log("  The weights are assumed, not measured. Replace them with real cycle times per rule");
console.log("  and this becomes a planning input rather than an illustration.\n");

console.log("  BY CLAUSE\n");
for (const s of scored) {
  console.log("  " + String(s.id).padEnd(6) + LABEL[s.tier].trim().padEnd(14) + s.archetype);
  console.log("         " + s.reason);
}

console.log("\n  " + "-".repeat(66));
console.log("  Measured against " + PRECEDENTS.length + " coded rules across " + corpusAccounts + " accounts.");
console.log("  A corpus this small overstates novelty: an archetype looks unprecedented when it");
console.log("  simply has not come up yet in four accounts. Against a real book of business the");
console.log("  configuration share rises and this number becomes worth quoting.\n");
