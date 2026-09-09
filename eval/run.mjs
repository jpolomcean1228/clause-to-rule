#!/usr/bin/env node
/**
 * Evaluation harness for the guideline extraction pipeline.
 *
 * The prompt and archetype list are parsed out of index.html at runtime rather than duplicated here.
 * A copied prompt drifts from the shipped one within a week, and an eval that scores a prompt you are
 * not actually running is worse than no eval at all.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node eval/run.mjs
 *   ANTHROPIC_API_KEY=sk-ant-... node eval/run.mjs --limit 8 --runs 3
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..");

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
};
const MODEL = argOf("--model", process.env.ANTHROPIC_MODEL || "claude-sonnet-5");
const LIMIT = parseInt(argOf("--limit", "0"), 10);
const RUNS = parseInt(argOf("--runs", "1"), 10);
const CONCURRENCY = 4;

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("Set ANTHROPIC_API_KEY before running.\n  export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

/* ---------- pull the live prompt out of the console ---------- */

function loadPrompt() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const archMatch = html.match(/const ARCHETYPES = (\[[\s\S]*?\]);/);
  const sysMatch = html.match(/const SYSTEM = `([\s\S]*?)`;/);
  if (!archMatch || !sysMatch) {
    throw new Error("Could not find ARCHETYPES or SYSTEM in index.html. If the console was refactored, update loadPrompt().");
  }
  const ARCHETYPES = new Function("return " + archMatch[1])();
  const SYSTEM = new Function("ARCHETYPES", "return `" + sysMatch[1] + "`")(ARCHETYPES);
  return { ARCHETYPES, SYSTEM };
}

/* ---------- model call ---------- */

async function callModel(system, prompt, attempt = 0) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 900,
      system,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt)));
    return callModel(system, prompt, attempt + 1);
  }
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).error?.message || detail; } catch {}
    throw new Error(`HTTP ${res.status} — ${detail}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.search(/[{[]/);
  return JSON.parse(start > 0 ? cleaned.slice(start) : cleaned);
}

/* ---------- scoring ---------- */

const norm = s => String(s == null ? "" : s).toLowerCase();
const numbersIn = s => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);

/**
 * Key values are matched against the union of returned parameter values and carve-outs rather than
 * against a named field. The model may reasonably call a parameter limit_pct, threshold or max_percent;
 * what matters for a reviewer is whether the number survived the trip.
 */
function keyValuesFound(expected, pred) {
  const haystack = [
    ...(pred.parameters || []).map(p => `${p.name} ${p.value}`),
    ...(pred.exceptions || [])
  ].join(" | ");
  const nums = new Set(numbersIn(haystack));
  const hay = norm(haystack);
  return expected.map(v => {
    const asNum = Number(v);
    const hit = Number.isFinite(asNum) && /^\d+(\.\d+)?$/.test(v) ? nums.has(asNum) : hay.includes(norm(v));
    return { value: v, hit };
  });
}

function score(fx, pred) {
  const classOk = pred.classification === fx.classification;
  const isRestriction = fx.classification === "RESTRICTION";
  const archetypeOk = fx.archetype_id == null ? null : pred.archetype_id === fx.archetype_id;
  const kv = keyValuesFound(fx.key_values || [], pred);
  const kvOk = kv.every(k => k.hit);
  const flagged = (pred.ambiguities || []).length > 0;
  return {
    id: fx.id,
    expected: fx.classification,
    predicted: pred.classification,
    classOk,
    isRestriction,
    predictedRestriction: pred.classification === "RESTRICTION",
    archetypeExpected: fx.archetype_id,
    archetypePredicted: pred.archetype_id,
    archetypeOk,
    keyValues: kv,
    kvOk,
    shouldFlag: !!fx.should_flag,
    flagged,
    confidence: typeof pred.confidence === "number" ? pred.confidence : 0,
    // "Fully correct" means a reviewer could approve without editing.
    fullyCorrect: classOk && archetypeOk !== false && kvOk,
    hardCase: fx.hard_case || null,
    ambiguities: pred.ambiguities || []
  };
}

/* ---------- run ---------- */

async function pool(items, worker, size) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const n = i++;
      out[n] = await worker(items[n], n);
    }
  }));
  return out;
}

const pct = (n, d) => (d === 0 ? "—" : (100 * n / d).toFixed(1) + "%");

function report(rows) {
  const restrictions = rows.filter(r => r.isRestriction);
  const nonRestrictions = rows.filter(r => !r.isRestriction);
  const withArchetype = rows.filter(r => r.archetypeOk !== null);
  const shouldFlag = rows.filter(r => r.shouldFlag);
  const shouldNotFlag = rows.filter(r => !r.shouldFlag);
  const allKv = rows.flatMap(r => r.keyValues);

  const m = {
    n: rows.length,
    classificationAccuracy: rows.filter(r => r.classOk).length / rows.length,
    restrictionRecall: restrictions.filter(r => r.predictedRestriction).length / (restrictions.length || 1),
    falseRestrictionRate: nonRestrictions.filter(r => r.predictedRestriction).length / (nonRestrictions.length || 1),
    archetypeAccuracy: withArchetype.filter(r => r.archetypeOk).length / (withArchetype.length || 1),
    keyValueRecall: allKv.filter(k => k.hit).length / (allKv.length || 1),
    ambiguityRecall: shouldFlag.filter(r => r.flagged).length / (shouldFlag.length || 1),
    overFlagRate: shouldNotFlag.filter(r => r.flagged).length / (shouldNotFlag.length || 1),
    fullyCorrect: rows.filter(r => r.fullyCorrect).length / rows.length
  };

  console.log("\n" + "=".repeat(66));
  console.log("  GUIDELINE EXTRACTION EVAL");
  console.log("  model: " + MODEL + "   clauses: " + m.n + "   runs: " + RUNS);
  console.log("=".repeat(66) + "\n");

  const line = (label, val, note) =>
    console.log("  " + label.padEnd(26) + String(val).padStart(7) + (note ? "   " + note : ""));

  console.log("  RECALL — the metric that matters\n");
  line("Restriction recall", pct(restrictions.filter(r => r.predictedRestriction).length, restrictions.length),
    "misses are potential breaches");
  line("Key value recall", pct(allKv.filter(k => k.hit).length, allKv.length),
    "thresholds that survived");
  line("Ambiguity recall", pct(shouldFlag.filter(r => r.flagged).length, shouldFlag.length),
    "known-hard clauses flagged");

  console.log("\n  PRECISION — cheap errors, tracked but not optimised\n");
  line("False restriction rate", pct(nonRestrictions.filter(r => r.predictedRestriction).length, nonRestrictions.length),
    "seconds of reviewer time");
  line("Over-flag rate", pct(shouldNotFlag.filter(r => r.flagged).length, shouldNotFlag.length),
    "clean clauses sent to review");

  console.log("\n  ACCURACY\n");
  line("Classification accuracy", pct(rows.filter(r => r.classOk).length, rows.length));
  line("Archetype accuracy", pct(withArchetype.filter(r => r.archetypeOk).length, withArchetype.length));
  line("Approvable unedited", pct(rows.filter(r => r.fullyCorrect).length, rows.length));

  /* per-archetype breakdown shows where the pattern library is thin */
  console.log("\n  BY ARCHETYPE\n");
  const byArch = {};
  for (const r of withArchetype) {
    const k = r.archetypeExpected;
    (byArch[k] ||= { n: 0, ok: 0, kv: 0, kvn: 0 });
    byArch[k].n++;
    if (r.archetypeOk) byArch[k].ok++;
    byArch[k].kv += r.keyValues.filter(x => x.hit).length;
    byArch[k].kvn += r.keyValues.length;
  }
  for (const [k, v] of Object.entries(byArch).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n)) {
    console.log("  " + k.padEnd(26) + String(v.ok + "/" + v.n).padStart(7) +
      "   values " + pct(v.kv, v.kvn));
  }

  /* calibration: is stated confidence worth anything? */
  console.log("\n  CALIBRATION\n");
  const buckets = [[0.9, 1.01], [0.8, 0.9], [0.7, 0.8], [0, 0.7]];
  for (const [lo, hi] of buckets) {
    const b = rows.filter(r => r.confidence >= lo && r.confidence < hi);
    if (!b.length) continue;
    const acc = b.filter(r => r.fullyCorrect).length / b.length;
    const label = (lo === 0 ? "below 0.70" : lo.toFixed(2) + " – " + (hi > 1 ? "1.00" : hi.toFixed(2)));
    const bar = "█".repeat(Math.round(acc * 20)).padEnd(20, "·");
    console.log("  " + label.padEnd(14) + String("n=" + b.length).padStart(5) + "  " + bar + " " + pct(b.filter(r => r.fullyCorrect).length, b.length));
  }
  console.log("\n  If stated confidence does not track accuracy here, the routing thresholds in");
  console.log("  tierOf() are decorative and the fast-approve queue is a liability.\n");

  const failures = rows.filter(r => !r.fullyCorrect);
  if (failures.length) {
    console.log("  FAILURES\n");
    for (const f of failures) {
      const why = [];
      if (f.errored) why.push("call failed, not scored");
      else if (!f.classOk) why.push(`classified ${f.predicted}, expected ${f.expected}`);
      if (!f.errored && f.archetypeOk === false) why.push(`archetype ${f.archetypePredicted || "none"}, expected ${f.archetypeExpected}`);
      const missed = f.errored ? [] : f.keyValues.filter(k => !k.hit).map(k => k.value);
      if (missed.length) why.push("lost values: " + missed.join(", "));
      if (!f.errored && f.shouldFlag && !f.flagged) why.push("did not flag a known ambiguity");
      console.log("  " + f.id + "  " + why.join("; "));
      if (f.hardCase) console.log("        " + f.hardCase);
    }
    console.log("");
  }

  const missedFlags = rows.filter(r => r.shouldFlag && !r.flagged && !r.errored);
  if (missedFlags.length) {
    console.log("  Silently confident on " + missedFlags.length + " clause(s) that should have been escalated: " +
      missedFlags.map(r => r.id).join(", ") + "\n");
  }

  return m;
}

function writeMarkdown(m, rows) {
  const md = `# Eval results

Generated ${new Date().toISOString().slice(0, 10)} · model \`${MODEL}\` · ${m.n} labeled clauses · ${RUNS} run(s)

## Headline

| Metric | Value | Why it is here |
|---|---|---|
| Restriction recall | ${pct(m.restrictionRecall * 100, 100)} | A missed restriction is a potential breach. This is the number to optimise |
| Key value recall | ${pct(m.keyValueRecall * 100, 100)} | Thresholds that survived extraction intact |
| Ambiguity recall | ${pct(m.ambiguityRecall * 100, 100)} | Known-hard clauses the model flagged rather than answered confidently |
| False restriction rate | ${pct(m.falseRestrictionRate * 100, 100)} | Cheap error. Tracked, deliberately not minimised |
| Over-flag rate | ${pct(m.overFlagRate * 100, 100)} | Clean clauses sent to review anyway |
| Classification accuracy | ${pct(m.classificationAccuracy * 100, 100)} | Routing to the right downstream owner |
| Archetype accuracy | ${pct(m.archetypeAccuracy * 100, 100)} | Pattern library coverage |
| Approvable unedited | ${pct(m.fullyCorrect * 100, 100)} | Right class, right archetype, no lost values |

## Reading these

Recall and precision are not weighted equally here, on purpose. A restriction the pipeline misses reaches a
portfolio manager as an uncoded constraint. A restriction it invents costs a reviewer a few seconds. Optimising
a balanced F1 across those two would be the wrong objective function for the business, so the prompt is
instructed to over-propose and flag doubt.

Ambiguity recall is the metric that most directly measures whether the human gate works. A clause with an
unnamed data vendor or an unstated measurement basis cannot be coded correctly by anyone, model or analyst.
The pipeline succeeding there means raising a hand, not producing an answer.

## Failures

${rows.filter(r => !r.fullyCorrect).map(f => {
  const why = [];
  if (!f.classOk) why.push(`classified ${f.predicted}, expected ${f.expected}`);
  if (f.archetypeOk === false) why.push(`archetype \`${f.archetypePredicted || "none"}\`, expected \`${f.archetypeExpected}\``);
  const missed = f.keyValues.filter(k => !k.hit).map(k => k.value);
  if (missed.length) why.push("lost values: " + missed.join(", "));
  if (f.shouldFlag && !f.flagged) why.push("did not flag a known ambiguity");
  return `- **${f.id}** — ${why.join("; ")}${f.hardCase ? `\n  <br><sub>${f.hardCase}</sub>` : ""}`;
}).join("\n") || "None."}

## Method

Fixtures in \`eval/fixtures.json\` are hand-labeled synthetic clauses, including deliberate hard cases: double
negatives, permissions nested inside prohibitions, thresholds defined only by external reference, screens with
no named data vendor, and open-ended carve-backs.

The runner parses \`ARCHETYPES\` and \`SYSTEM\` out of \`index.html\` rather than keeping its own copy, so the
eval always scores the prompt the console actually ships.

Key values are matched against the union of returned parameter values rather than against a named field, since
the model may reasonably name a parameter differently than the fixture does. What matters is whether the number
survived.

Reproduce with:

\`\`\`bash
ANTHROPIC_API_KEY=sk-ant-... node eval/run.mjs
\`\`\`

## Known limits

Synthetic fixtures written by the same author as the prompt will flatter the pipeline. The only honest version
of this eval runs against mandates already coded in a production compliance engine, where the labels are what
an analyst actually did. That is the first thing to build with real access.
`;
  fs.writeFileSync(path.join(DIR, "RESULTS.md"), md);
}

/* ---------- main ---------- */

const { SYSTEM } = loadPrompt();
const fixtures = JSON.parse(fs.readFileSync(path.join(DIR, "fixtures.json"), "utf8")).clauses;
const set = LIMIT > 0 ? fixtures.slice(0, LIMIT) : fixtures;

// Preflight. An eval that cannot tell "the model was wrong" from "the model never ran"
// is worse than no eval, so one call has to succeed before we score anything.
try {
  await callModel(SYSTEM, "Clause PRE:\n\nThe Account shall hold not less than two percent (2%) in cash.");
} catch (e) {
  console.error("\n  Preflight call failed. Nothing was scored.\n");
  console.error("  " + e.message + "\n");
  if (/model/i.test(e.message)) {
    console.error("  The model name looks wrong for this account. List what you can reach:\n");
    console.error("    curl -s https://api.anthropic.com/v1/models \\");
    console.error("      -H \"x-api-key: $ANTHROPIC_API_KEY\" \\");
    console.error("      -H \"anthropic-version: 2023-06-01\"\n");
    console.error("  Then rerun with:  node eval/run.mjs --model <id>\n");
  } else if (/authenticat|api.?key|401|403/i.test(e.message)) {
    console.error("  Check that ANTHROPIC_API_KEY is exported in this shell and has credit.\n");
  }
  process.exit(1);
}

console.log(`Running ${set.length} clauses × ${RUNS} run(s) against ${MODEL}…`);

const rows = [];
const errors = [];
for (let run = 0; run < RUNS; run++) {
  const results = await pool(set, async fx => {
    try {
      const pred = await callModel(SYSTEM, "Clause " + fx.id + ":\n\n" + fx.text);
      process.stdout.write(".");
      return score(fx, pred);
    } catch (e) {
      process.stdout.write("x");
      errors.push(fx.id + ": " + e.message);
      const row = score(fx, { classification: "ERROR", archetype_id: null, parameters: [], ambiguities: [], confidence: 0 });
      row.errored = true;
      return row;
    }
  }, CONCURRENCY);
  rows.push(...results);
}
process.stdout.write("\n");

if (errors.length) {
  const rate = errors.length / rows.length;
  console.log("\n  " + errors.length + " of " + rows.length + " calls failed outright.");
  console.log("  Distinct errors:");
  for (const e of [...new Set(errors.map(x => x.split(": ").slice(1).join(": ")))].slice(0, 5)) {
    console.log("    " + e);
  }
  if (rate > 0.2) {
    console.log("\n  More than a fifth of calls failed. The numbers below are not a measure of");
    console.log("  extraction quality — fix the failures and rerun before reading them.\n");
  }
}

const metrics = report(rows);
fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify({ model: MODEL, runs: RUNS, metrics, rows }, null, 2));
writeMarkdown(metrics, rows);
console.log("  Wrote eval/results.json and eval/RESULTS.md\n");
