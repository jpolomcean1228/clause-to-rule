#!/usr/bin/env node
/**
 * Account readiness check.
 *
 * Takes extracted clause output and reports what is missing before the account can be funded,
 * traded, billed and reported. Entirely deterministic — no model calls, no network, no API key.
 * The model's job was judgement about what each clause says. This is bookkeeping about what a
 * mandate needs, and bookkeeping should not be probabilistic.
 *
 *   node readiness/check.mjs readiness/examples/meridian-extracted.json
 *   node readiness/check.mjs <file> --json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const inputPath = args.find(a => !a.startsWith("--"));
const asJson = args.includes("--json");

if (!inputPath) {
  console.error("Usage: node readiness/check.mjs <extracted.json> [--json]");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const clauses = Array.isArray(input) ? input : (input.clauses || input.proposals || []);

if (!clauses.length) {
  console.error("No clauses found in " + inputPath + ". Expected an array, or an object with a 'clauses' key.");
  process.exit(1);
}

/* ---------- evidence index ---------- */

const norm = s => String(s == null ? "" : s).toLowerCase();
const classifications = new Set(clauses.map(c => c.classification).filter(Boolean));
const archetypes = new Set(clauses.map(c => c.archetype_id).filter(Boolean));
const allText = clauses.map(c =>
  [c.classification, c.archetype_id, c.summary, c.rationale,
   (c.clause && c.clause.text) || c.text || "",
   ...(c.parameters || []).map(p => p.name + " " + p.value)].join(" ")
).join(" \n ").toLowerCase();

const paramNames = new Set();
const paramByArchetype = {};
for (const c of clauses) {
  for (const p of (c.parameters || [])) {
    const n = norm(p.name).replace(/[^a-z]/g, "");
    if (String(p.value || "").trim()) {
      paramNames.add(n);
      if (c.archetype_id) (paramByArchetype[c.archetype_id] ||= new Set()).add(n);
    }
  }
}
const openAmbiguities = clauses.filter(c => (c.ambiguities || []).length > 0);

/* ---------- rule evaluation ---------- */

function isRequired(item) {
  const w = item.required_when || {};
  if (w.always) return true;
  if (w.archetype_present) return w.archetype_present.some(a => archetypes.has(a));
  if (w.classification_present) return w.classification_present.some(c => classifications.has(c));
  return false;
}

function evaluate(item) {
  const s = item.satisfied_by || {};
  // External items are never satisfied by the document. That is the finding, not a failure of extraction.
  if (s.external) return { status: "external" };
  if (s.no_open_ambiguities) {
    return openAmbiguities.length === 0
      ? { status: "satisfied" }
      : { status: "gap", detail: openAmbiguities.length + " clause(s) with unresolved ambiguity: " +
          openAmbiguities.map(c => (c.clause && c.clause.id) || c.id || "?").join(", ") };
  }
  if (s.classification_present && s.classification_present.some(c => classifications.has(c))) return { status: "satisfied" };
  if (s.parameter_named && s.parameter_named.some(n => paramNames.has(norm(n).replace(/[^a-z]/g, "")))) return { status: "satisfied" };
  if (s.parameter_on_archetype) {
    const { archetype, name } = s.parameter_on_archetype;
    if (!archetypes.has(archetype)) return { status: "satisfied", detail: "not applicable" };
    const has = (paramByArchetype[archetype] || new Set()).has(norm(name).replace(/[^a-z]/g, ""));
    return has ? { status: "satisfied" } : { status: "gap", detail: "no " + name + " on the " + archetype + " rule" };
  }
  if (s.text_match && s.text_match.some(t => allText.includes(norm(t)))) return { status: "satisfied" };
  return { status: "gap" };
}

const rows = manifest.items
  .filter(isRequired)
  .map(item => ({ ...item, ...evaluate(item) }));

const gaps = rows.filter(r => r.status === "gap");
const external = rows.filter(r => r.status === "external");
const satisfied = rows.filter(r => r.status === "satisfied");
const skipped = manifest.items.filter(i => !isRequired(i));

/* ---------- output ---------- */

if (asJson) {
  console.log(JSON.stringify({ gaps, external, satisfied, not_applicable: skipped.map(s => s.id) }, null, 2));
  process.exit(0);
}

const ORDER = ["funding", "trading", "billing", "reporting", "none"];
const HEAD = {
  funding: "BLOCKS FUNDING",
  trading: "BLOCKS TRADING",
  billing: "BLOCKS FIRST INVOICE",
  reporting: "BLOCKS FIRST REPORT",
  none: "TRACKED, NOT BLOCKING"
};

console.log("\n" + "=".repeat(70));
console.log("  ACCOUNT READINESS");
console.log("  source: " + path.basename(inputPath) + "   clauses read: " + clauses.length);
console.log("=".repeat(70));

const open = [...gaps, ...external];
console.log("\n  " + satisfied.length + " of " + rows.length + " requirements met. " +
  open.length + " open (" + gaps.length + " from the document, " + external.length + " external).\n");

for (const level of ORDER) {
  const inLevel = open.filter(r => r.blocks === level);
  if (!inLevel.length) continue;
  console.log("  " + HEAD[level]);
  for (const r of inLevel) {
    const tag = r.status === "external" ? "[chase]" : "[gap]  ";
    console.log("    " + tag + " " + r.label + "  — " + r.owner);
    if (r.detail) console.log("             " + r.detail);
    if (r.note) console.log("             " + r.note);
  }
  console.log("");
}

if (satisfied.length) {
  console.log("  MET");
  for (const r of satisfied) console.log("    " + r.label + (r.detail ? " (" + r.detail + ")" : ""));
  console.log("");
}

/* by owner: the version somebody actually forwards */
console.log("  BY OWNER\n");
const byOwner = {};
for (const r of open) (byOwner[r.owner] ||= []).push(r);
for (const [owner, items] of Object.entries(byOwner).sort((a, b) => b[1].length - a[1].length)) {
  console.log("  " + owner + " (" + items.length + ")");
  for (const r of items) console.log("    - " + r.label + (r.status === "external" ? " — not in the document, must be chased" : ""));
  console.log("");
}

const blockingTrade = open.filter(r => r.blocks === "funding" || r.blocks === "trading").length;
if (blockingTrade) {
  console.log("  " + blockingTrade + " open item(s) prevent this account from trading.");
  console.log("  Absence, not difficulty, is what holds up onboarding. Every line above is something");
  console.log("  nobody has to discover in week three.\n");
} else {
  console.log("  Nothing outstanding blocks trading.\n");
}
