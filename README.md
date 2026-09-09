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

## Recall over precision, deliberately

The two error types are not symmetrical. A missed restriction is a potential breach and a client-facing
incident. A spurious one costs a reviewer a few seconds to delete.

So the extraction prompt is instructed to over-propose and flag doubt rather than stay silent, and any
evaluation of this pipeline should weight recall accordingly. Optimising for a balanced F1 here would be the
wrong objective function for the business.

## How you would evaluate it

Not shipped in this prototype — it needs real coded rules — but this is the approach:

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
- No retrieval against prior coded mandates. The precedent diff — showing a reviewer the nearest existing rule
  rather than a blank proposal — is the highest-value next addition
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
