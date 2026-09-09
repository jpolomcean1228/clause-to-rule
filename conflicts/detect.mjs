#!/usr/bin/env node
/**
 * Multi-document conflict detection.
 *
 * A mandate is rarely one document. There is a base IMA, amendments, and side letters, and a side
 * letter routinely overrides the agreement it sits under. Coding only the last document read, or
 * only the base agreement, is how an account ends up trading against the wrong constraint.
 *
 * This compares extracted output from two or more documents and reports where they collide on the
 * same archetype. Deterministic — no model calls, no network, no API key.
 *
 *   node conflicts/detect.mjs conflicts/examples/meridian-ima.json conflicts/examples/meridian-side-letter.json
 *   node conflicts/detect.mjs <a.json> <b.json> [...] [--json]
 *
 * The distinction the report is built around: a later document that TIGHTENS a restriction is a
 * bookkeeping event. One that LOOSENS it is a risk decision, and somebody has to sign it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..");
const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith("--"));
const asJson = args.includes("--json");

if (files.length < 2) {
  console.error("Usage: node conflicts/detect.mjs <doc1.json> <doc2.json> [...] [--json]");
  process.exit(1);
}

const lib = JSON.parse(fs.readFileSync(path.join(ROOT, "pattern-library.json"), "utf8"));
const TIGHTEN = Object.fromEntries(lib.archetypes.map(a => [a.id, a.tightening || {}]));
const SCALE = lib.rating_scale;
const ALIAS = lib.rating_aliases;

const docs = files.map(f => {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  const meta = d.document || {};
  return {
    file: path.basename(f),
    id: meta.id || path.basename(f),
    type: meta.type || "UNKNOWN",
    effective: meta.effective_date || null,
    precedence: typeof meta.precedence === "number" ? meta.precedence : 0,
    clauses: (d.clauses || d.proposals || []).filter(c => c.classification === "RESTRICTION")
  };
});

/* ---------- value comparison ---------- */

const normName = n => String(n || "").toLowerCase().replace(/[^a-z]/g, "");
const normVal = v => String(v == null ? "" : v).toLowerCase().replace(/\s+/g, " ").trim();

function ratingRank(v) {
  const tokens = String(v).split(/[^A-Za-z0-9+-]+/).filter(Boolean);
  for (const t of tokens) {
    const key = ALIAS[t] || t.toUpperCase();
    const i = SCALE.indexOf(key);
    if (i !== -1) return SCALE.length - i; // higher rank = better credit = tighter floor
  }
  return null;
}

function numeric(v) {
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * Returns "tighter", "looser", "changed" (differs but direction not determinable) or "same".
 * Direction is only claimed where the pattern library says which way the parameter tightens
 * and both values are comparable. Guessing here would be worse than saying "changed".
 */
function direction(archetype, name, baseVal, newVal) {
  if (normVal(baseVal) === normVal(newVal)) return "same";
  const dir = (TIGHTEN[archetype] || {})[normName(name)] ||
              (TIGHTEN[archetype] || {})[name] ||
              Object.entries(TIGHTEN[archetype] || {}).find(([k]) => normName(k) === normName(name))?.[1];
  if (!dir) return "changed";
  const isRating = /rating/.test(normName(name));
  const a = isRating ? ratingRank(baseVal) : numeric(baseVal);
  const b = isRating ? ratingRank(newVal) : numeric(newVal);
  if (a == null || b == null) return "changed";
  if (a === b) return "same";
  const higherIsTighter = dir === "higher";
  const tighter = higherIsTighter ? b > a : b < a;
  return tighter ? "tighter" : "looser";
}

const CARVE_BACK = /except as otherwise agreed|unless the client agrees|as otherwise agreed in writing|subject to.*written (consent|agreement)/i;

/* ---------- collision analysis ---------- */

const byArchetype = {};
for (const d of docs) {
  for (const c of d.clauses) {
    if (!c.archetype_id) continue;
    (byArchetype[c.archetype_id] ||= []).push({ doc: d, clause: c });
  }
}

const findings = [];

for (const [archetype, entries] of Object.entries(byArchetype)) {
  const uniqueDocs = new Set(entries.map(e => e.doc.id));
  if (uniqueDocs.size < 2) {
    // Present in only one document. Note it if it arrived in a later one.
    const e = entries[0];
    const isLater = e.doc.precedence > Math.min(...docs.map(d => d.precedence));
    if (isLater) {
      findings.push({ kind: "added", archetype, governing: e.doc, clause: e.clause,
        detail: "New restriction introduced by " + e.doc.id + ". Not present in the base agreement." });
    }
    continue;
  }

  const sorted = [...entries].sort((a, b) => a.doc.precedence - b.doc.precedence);
  const base = sorted[0];
  const maxP = Math.max(...entries.map(e => e.doc.precedence));
  // Two documents of equal top rank disagreeing is the case precedence cannot settle.
  const tops = entries.filter(e => e.doc.precedence === maxP);
  const top = tops[0];
  const tie = tops.length > 1 && tops.some(t => (t.clause.parameters || []).some(pp =>
    (top.clause.parameters || []).some(qq => normName(qq.name) === normName(pp.name) && normVal(qq.value) !== normVal(pp.value))));
  if (tie) {
    const rows = [];
    for (const pp of (tops[0].clause.parameters || [])) {
      const other = (tops[1].clause.parameters || []).find(x => normName(x.name) === normName(pp.name));
      if (other && normVal(other.value) !== normVal(pp.value)) {
        rows.push({ name: pp.name, from: pp.value, to: other.value, direction: "conflicting" });
      }
    }
    findings.push({ kind: "unresolved", archetype, base: tops[0], top: tops[1], rows,
      detail: tops[0].doc.id + " and " + tops[1].doc.id + " carry equal precedence and disagree. " +
        "Nothing in the documents settles which governs." });
    continue;
  }

  const baseParams = base.clause.parameters || [];
  const topParams = top.clause.parameters || [];
  const rows = [];
  for (const bp of baseParams) {
    const tp = topParams.find(x => normName(x.name) === normName(bp.name));
    if (!tp) continue;
    const d = direction(archetype, bp.name, bp.value, tp.value);
    if (d !== "same") rows.push({ name: bp.name, from: bp.value, to: tp.value, direction: d });
  }

  const baseCarveBack = [...(base.clause.exceptions || []), ...(base.clause.ambiguities || [])]
    .some(x => CARVE_BACK.test(x)) || CARVE_BACK.test((base.clause.clause && base.clause.clause.text) || "");

  if (baseCarveBack && rows.length === 0) {
    findings.push({ kind: "carveback", archetype, base, top,
      detail: base.doc.id + " permitted this subject to written agreement. " + top.doc.id +
        " appears to be that writing — the open carve-back is now resolved." });
  } else if (baseCarveBack) {
    findings.push({ kind: "carveback", archetype, base, top, rows,
      detail: base.doc.id + " left this open subject to written agreement. " + top.doc.id + " supplies the terms." });
  } else if (rows.some(r => r.direction === "looser")) {
    findings.push({ kind: "loosened", archetype, base, top, rows,
      detail: top.doc.id + " relaxes a constraint set by " + base.doc.id + "." });
  } else if (rows.some(r => r.direction === "tighter")) {
    // A parameter with no direction semantics (an agency name, a measure) should not outvote
    // the ones that plainly moved. Judge on the rows where direction is determinable.
    const unclear = rows.filter(r => r.direction === "changed").length;
    findings.push({ kind: "tightened", archetype, base, top, rows,
      detail: top.doc.id + " tightens " + base.doc.id + "." +
        (unclear ? " " + unclear + " other parameter(s) changed without a determinable direction." : "") });
  } else if (rows.some(r => r.direction === "changed")) {
    findings.push({ kind: "changed", archetype, base, top, rows,
      detail: "Values differ but direction is not determinable from the pattern library." });
  } else {
    findings.push({ kind: "duplicate", archetype, base, top,
      detail: "Same rule restated identically. No action, but worth knowing it is coded twice." });
  }
}

if (asJson) {
  console.log(JSON.stringify({ documents: docs.map(d => ({ id: d.id, type: d.type, effective: d.effective, precedence: d.precedence, restrictions: d.clauses.length })), findings }, null, 2));
  process.exit(0);
}

/* ---------- report ---------- */

console.log("\n" + "=".repeat(74));
console.log("  MANDATE CONFLICT REVIEW");
console.log("=".repeat(74) + "\n");

console.log("  DOCUMENTS\n");
for (const d of [...docs].sort((a, b) => a.precedence - b.precedence)) {
  console.log("    " + String(d.precedence).padStart(2) + "  " + d.id.padEnd(22) + d.type.padEnd(14) +
    (d.effective || "no effective date").padEnd(14) + d.clauses.length + " restrictions");
}
console.log("\n    Higher precedence governs. Rank comes from the documents, not from load order.\n");

const GROUPS = [
  ["unresolved", "UNRESOLVED — NEEDS A DECISION", true],
  ["loosened", "LOOSENED — NEEDS SIGN-OFF", true],
  ["changed", "CHANGED — DIRECTION UNCLEAR", true],
  ["carveback", "CARVE-BACK RESOLVED", false],
  ["tightened", "TIGHTENED — NOTE AND CODE", false],
  ["added", "ADDED BY A LATER DOCUMENT", false],
  ["duplicate", "RESTATED IDENTICALLY", false]
];

let attention = 0;
for (const [kind, heading, isAttention] of GROUPS) {
  const items = findings.filter(f => f.kind === kind);
  if (!items.length) continue;
  if (isAttention) attention += items.length;
  console.log("  " + heading + "\n");
  for (const f of items) {
    const where = f.base && f.top ? f.base.clause.clause.id + " \u2192 " + f.top.clause.clause.id
                                  : (f.clause && f.clause.clause ? f.clause.clause.id : "");
    console.log("    " + f.archetype + "   " + where);
    console.log("      " + f.detail);
    for (const r of (f.rows || [])) {
      console.log("        " + r.name.padEnd(24) + r.from + "  \u2192  " + r.to + "   [" + r.direction + "]");
    }
    console.log("");
  }
}

console.log("  " + "-".repeat(70));
if (attention) {
  console.log("  " + attention + " item(s) need a human decision before this mandate can be coded.");
} else {
  console.log("  Every collision resolved cleanly on document precedence.");
}
console.log("  A later document that tightens a restriction is bookkeeping. One that loosens it is a");
console.log("  risk decision, and the point of this report is that nobody gets to make it silently.\n");
