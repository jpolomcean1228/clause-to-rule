# Guideline intake console

A working prototype of the step that slows down institutional client onboarding most: turning the investment
guidelines in a signed mandate into coded compliance rules.

Paste an IMA schedule, side letter or guidelines exhibit. The pipeline segments it into operative clauses,
classifies each one, maps investment restrictions onto a rule archetype, scores its own confidence, and routes
the draft to a reviewer. The model never writes to a compliance engine. It produces a proposal with the source
language sitting next to it, and a human approves, edits or rejects.

Runs on synthetic mandate documents. No client data, no vendor data.

---

## The premise

Guideline coding looks bespoke. Every IMA reads differently, so onboarding teams treat each new mandate as an
authoring problem and start from a blank page.

But the underlying restriction grammar is small. Issuer concentration caps, sector and country limits, rating
floors, duration bands, maturity limits, prohibited instruments, liquidity minimums, restricted-list screens,
derivatives constraints, tracking error limits. A few dozen archetypes cover most of what real mandates
actually say.

**The client-specific part is the parameter, not the logic.** Once you accept that, coding a new mandate stops
being a build and becomes configuration against a pattern library — which brings reuse, precedent and an audit
trail along with it.

`pattern-library.json` holds the archetype catalog. In a real deployment you would not hand-write it. You would
derive it empirically by mining the rules already coded in the compliance engine, which is both a better
taxonomy and a lower-risk first project than shipping an extraction model.

## Pipeline

| Stage | What runs | Why |
|---|---|---|
| 1. Segment | Deterministic. Splits on clause numbering, falls back to paragraphs | Segmentation is a parsing problem, not a judgement problem. Using a model here adds cost and failure modes for nothing |
| 2. Classify | Model | Restriction, fee term, reporting obligation, operational term, performance term, boilerplate. Only the first goes to compliance; the rest are the dependency notifications that onboarding usually chases by email |
| 3. Match and extract | Model | Maps the clause to an archetype and fills parameters against a fixed schema. Structured output, not prose |
| 4. Score and tier | Deterministic, over model output | Confidence plus flagged ambiguities decide the review path |

Routing thresholds live in `tierOf()`:

- **Fast approve** — high confidence, clean match to an established archetype, no flagged ambiguity
- **Analyst review** — matched but uncertain
- **Escalate to legal** — low confidence, or any flagged ambiguity: an unnamed data vendor, an unstated
  measurement basis, a cross-reference to an appendix the model cannot see, a prohibition carved back by
  exception

Tiering is what makes this a throughput tool rather than an autonomy claim. The queue is triaged, not
eliminated.

## Precedent, not a blank page

Every restriction proposal is compared against the nearest previously coded rule of the same archetype, chosen
on shared parameter names and then on matching values. The reviewer sees a parameter-level diff rather than an
empty form: what matches precedent, what differs, what is new, and — most usefully — what the precedent
carries that this proposal does not.

That last row is the one that earns its place. When a tracking error rule comes back without a measurement
basis, or a revenue screen without a data vendor, the diff surfaces it in red because a prior account had that
parameter and this one lost it. It catches the same gaps the model is asked to flag, through an independent
mechanism. Two ways of noticing the same problem is a better safety property than one.

It is also what makes the reuse argument concrete. A reviewer confirming that a 5% issuer cap matches what was
coded for another account last quarter is doing something categorically faster than authoring the rule, and the
comparison happens without anyone having to remember the precedent exists.

## Onboarding checklist

Non-restriction clauses do not vanish. Fee terms, reporting obligations, custody and settlement instructions
and composite assignments are grouped by the team that owns them and rendered as work items, copyable in one
click.

These are the dependency notifications that onboarding usually chases by email. They fall out of the same pass
that drafts the compliance rules, because the classifier has already decided who owns each clause.

## Account readiness — what the document does not say

```bash
node readiness/check.mjs readiness/examples/meridian-extracted.json
node readiness/check.mjs readiness/examples/calder-extracted.json
```

No API key, no network, no model calls. The model's job was judgement about what each clause says. This is
bookkeeping about what a mandate needs, and bookkeeping should not be probabilistic.

`readiness/manifest.json` lists what an account requires before it can be funded, traded, billed and reported.
The checker compares that list against extracted output and reports what is missing, grouped by blocking level
and by owning team.

Requirements are conditional. A restricted-list feed is only required if a restricted-list rule was extracted;
an ESG data vendor only if a revenue-threshold screen exists; a tracking error measurement basis only if there
is a tracking error limit. Run the two examples and the Calder mandate raises requirements the Meridian one
never triggers.

The distinction that makes this useful is between two kinds of open item:

- **Gaps** — the document should have answered this and did not. A screen with no named vendor, a tracking
  error limit with no measurement basis, no base currency stated
- **External** — the document could never answer this, and nobody should expect it to. An executed agreement,
  working settlement instructions, the restricted list file itself, the report distribution list

Conflating those two is how onboarding loses a week. The first is a question for the client. The second is
work that should already be in flight, and a checklist that does not distinguish them sends people back to
read a document that was never going to contain the answer.

Onboarding stalls on absence far more than on difficulty. This turns "here are your coded rules" into "here
is what is stopping this account from trading, and whose desk each item is on."

## Recall over precision, deliberately

The two error types are not symmetrical. A missed restriction is a potential breach and a client-facing
incident. A spurious one costs a reviewer a few seconds to delete.

So the extraction prompt is instructed to over-propose and flag doubt rather than stay silent, and any
evaluation of this pipeline should weight recall accordingly. Optimising for a balanced F1 here would be the
wrong objective function for the business.

## Evaluation

`eval/` holds a hand-labeled fixture set and a runner.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node eval/run.mjs                        # full set
node eval/run.mjs --limit 8              # quick pass
node eval/run.mjs --runs 3               # variance across repeated runs
node eval/run.mjs --model claude-opus-5  # compare models
```

A preflight call runs before anything is scored. If it fails, the harness stops and prints the API error
rather than reporting zeros — an eval that cannot distinguish "the model was wrong" from "the model never
ran" is worse than no eval. Failed calls mid-run are counted and reported separately from behavioural
results.

The runner parses `ARCHETYPES` and the system prompt out of `index.html` rather than keeping its own copy, so
it always scores the prompt the console actually ships. A duplicated prompt drifts within a week, and an eval
that scores a prompt you are not running is worse than no eval.

It reports recall and precision separately and deliberately does not blend them:

- **Restriction recall** — restrictions the pipeline classified as restrictions. The number to optimise
- **Key value recall** — thresholds that survived extraction intact
- **Ambiguity recall** — known-unanswerable clauses the model flagged rather than answered confidently
- **False restriction rate** and **over-flag rate** — the cheap errors, tracked but not minimised
- **Per-archetype breakdown** — where the pattern library is thin
- **Calibration** — whether stated confidence tracks actual accuracy. If it does not, the routing thresholds in
  `tierOf()` are decorative and the fast-approve queue is a liability

Results are written to `eval/RESULTS.md`.

The fixtures include deliberate hard cases: double negatives, permissions nested inside prohibitions,
thresholds defined only by reference to an appendix, revenue screens with no named data vendor, and
open-ended carve-backs. On those the correct behaviour is to flag, not to answer.

Fixtures written by the same author as the prompt will flatter the pipeline. The honest version of this eval
runs against mandates already coded in a production compliance engine, where the labels are what an analyst
actually did.

## Pointing it at real data

The harness above covers the mechanics. With real access, this is how it should be pointed at production data:

1. **Golden set from history.** Take mandates already coded in the compliance engine. Run their source
   documents through the pipeline. Compare proposals against what the analyst actually coded. This is the only
   honest measure, and the labels already exist.
2. **Recall-weighted scoring.** Report clause-level recall and parameter-level exact match separately. A rule
   matched to the right archetype with a wrong threshold is a different failure from a rule missed entirely.
3. **Adversarial generation.** Synthesise hard variants: double negatives, permissions nested inside
   prohibitions, thresholds defined by reference to a schedule, "except as otherwise agreed in writing". Both
   sample documents contain examples.
4. **Review telemetry as the real signal.** Edit rate and rejection rate per archetype tell you where the
   pattern library is thin. The decision log is that corpus.

## What is deliberately not here

- No write path to a compliance engine. Approved rules land in a log, which is where the boundary belongs
- No document ingestion for scanned PDFs
- Precedent is matched against an inlined constant standing in for a compliance engine query. Real retrieval
  would rank on clause-text similarity as well as parameter overlap
- No authentication, persistence or multi-user review state

## Running it

Open `index.html`. That is the whole thing — no build, no dependencies.

Outside a Claude artifact you need an Anthropic API key. The console prompts for one on the first failed call
and keeps it in memory only. That is fine for a local demo and wrong for anything else: in a real deployment the
key lives server-side behind a proxy, and browser-side key entry should be treated as demo scaffolding.

## Design notes

The review card splits warm paper on the left, cool slate on the right — the client's words against the
machine's proposal. That split is the whole interaction. A reviewer's job is comparison, so nothing in the
layout gets in the way of reading the two side by side.
