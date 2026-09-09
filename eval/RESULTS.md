# Eval results

Generated 2026-09-09 · model `claude-sonnet-5` · 32 labeled clauses · 1 run(s)

## Headline

| Metric | Value | Why it is here |
|---|---|---|
| Restriction recall | 0.0% | A missed restriction is a potential breach. This is the number to optimise |
| Key value recall | 0.0% | Thresholds that survived extraction intact |
| Ambiguity recall | 0.0% | Known-hard clauses the model flagged rather than answered confidently |
| False restriction rate | 0.0% | Cheap error. Tracked, deliberately not minimised |
| Over-flag rate | 0.0% | Clean clauses sent to review anyway |
| Classification accuracy | 0.0% | Routing to the right downstream owner |
| Archetype accuracy | 0.0% | Pattern library coverage |
| Approvable unedited | 0.0% | Right class, right archetype, no lost values |

## Reading these

Recall and precision are not weighted equally here, on purpose. A restriction the pipeline misses reaches a
portfolio manager as an uncoded constraint. A restriction it invents costs a reviewer a few seconds. Optimising
a balanced F1 across those two would be the wrong objective function for the business, so the prompt is
instructed to over-propose and flag doubt.

Ambiguity recall is the metric that most directly measures whether the human gate works. A clause with an
unnamed data vendor or an unstated measurement basis cannot be coded correctly by anyone, model or analyst.
The pipeline succeeding there means raising a hand, not producing an answer.

## Failures

- **F01** — classified ERROR, expected RESTRICTION; archetype `none`, expected `ISSUER_CONCENTRATION`; lost values: 5
- **F02** — classified ERROR, expected RESTRICTION; archetype `none`, expected `ISSUER_CONCENTRATION`; lost values: 3
- **F03** — classified ERROR, expected RESTRICTION; archetype `none`, expected `SECTOR_LIMIT`; lost values: 25
- **F04** — classified ERROR, expected RESTRICTION; archetype `none`, expected `SECTOR_LIMIT`; lost values: 750
- **F05** — classified ERROR, expected RESTRICTION; archetype `none`, expected `GEOGRAPHIC_LIMIT`; lost values: 15
- **F06** — classified ERROR, expected RESTRICTION; archetype `none`, expected `GEOGRAPHIC_LIMIT`; lost values: 10
- **F07** — classified ERROR, expected RESTRICTION; archetype `none`, expected `CREDIT_RATING_FLOOR`; lost values: BBB-
- **F08** — classified ERROR, expected RESTRICTION; archetype `none`, expected `CREDIT_RATING_FLOOR`; lost values: A3
- **F09** — classified ERROR, expected RESTRICTION; archetype `none`, expected `DURATION_BAND`; lost values: 1
- **F10** — classified ERROR, expected RESTRICTION; archetype `none`, expected `DURATION_BAND`; lost values: 3, 7
- **F11** — classified ERROR, expected RESTRICTION; archetype `none`, expected `MATURITY_LIMIT`; lost values: 10
- **F12** — classified ERROR, expected RESTRICTION; archetype `none`, expected `PROHIBITED_INSTRUMENT`; lost values: commodities
- **F13** — classified ERROR, expected RESTRICTION; archetype `none`, expected `DERIVATIVES_USAGE`; lost values: duration
  <br><sub>Double negative. The clause permits an instrument class by negating a prohibition, then imposes a separate leverage constraint. A naive read inverts it.</sub>
- **F14** — classified ERROR, expected RESTRICTION; archetype `none`, expected `LIQUIDITY_MINIMUM`; lost values: 2
- **F15** — classified ERROR, expected RESTRICTION; archetype `none`, expected `LIQUIDITY_MINIMUM`; lost values: 1, 5
- **F16** — classified ERROR, expected RESTRICTION; archetype `none`, expected `RESTRICTED_LIST`; did not flag a known ambiguity
  <br><sub>The rule is codeable but the list itself is an external feed defined in an appendix the model cannot see. Correct behaviour is to propose the rule and flag the unresolved dependency.</sub>
- **F17** — classified ERROR, expected RESTRICTION; archetype `none`, expected `ESG_SCREEN`; lost values: 5, coal
- **F18** — classified ERROR, expected RESTRICTION; archetype `none`, expected `ESG_SCREEN`; lost values: 10, tobacco; did not flag a known ambiguity
  <br><sub>No data vendor named. Revenue-threshold screens are unimplementable without one, and different vendors classify differently, so the parameter is genuinely missing rather than merely unstated.</sub>
- **F19** — classified ERROR, expected RESTRICTION; archetype `none`, expected `DERIVATIVES_USAGE`; lost values: 20, hedging
- **F20** — classified ERROR, expected RESTRICTION; archetype `none`, expected `COUNTERPARTY_LIMIT`; lost values: 10, A-
- **F21** — classified ERROR, expected RESTRICTION; archetype `none`, expected `TRACKING_ERROR_LIMIT`; lost values: 400; did not flag a known ambiguity
  <br><sub>Ex ante and ex post tracking error are different measurements producing different breach profiles. The clause does not say which, and 'with a view to' further muddies whether this is a hard limit or a target.</sub>
- **F22** — classified ERROR, expected RESTRICTION; archetype `none`, expected `TRACKING_ERROR_LIMIT`; lost values: 300
- **F23** — classified ERROR, expected RESTRICTION; archetype `none`, expected `CURRENCY_HEDGE`; lost values: 100, 2
- **F24** — classified ERROR, expected RESTRICTION; lost values: 30; did not flag a known ambiguity
  <br><sub>A carve-out to unnamed other restrictions rather than a standalone rule. Correct behaviour is to surface it for review rather than force it into an archetype.</sub>
- **F25** — classified ERROR, expected RESTRICTION; archetype `none`, expected `ISSUER_CONCENTRATION`; did not flag a known ambiguity
  <br><sub>Archetype is unambiguous, threshold is defined only by external reference. The rule cannot be coded without Schedule 3.</sub>
- **F26** — classified ERROR, expected RESTRICTION; archetype `none`, expected `CURRENCY_HEDGE`; did not flag a known ambiguity
  <br><sub>A prohibition with an open-ended carve-back. Whether any side letter has since modified this is unknowable from the document alone.</sub>
- **F27** — classified ERROR, expected FEE
- **F28** — classified ERROR, expected FEE
- **F29** — classified ERROR, expected REPORTING
- **F30** — classified ERROR, expected OPERATIONAL
- **F31** — classified ERROR, expected PERFORMANCE
- **F32** — classified ERROR, expected BOILERPLATE

## Method

Fixtures in `eval/fixtures.json` are hand-labeled synthetic clauses, including deliberate hard cases: double
negatives, permissions nested inside prohibitions, thresholds defined only by external reference, screens with
no named data vendor, and open-ended carve-backs.

The runner parses `ARCHETYPES` and `SYSTEM` out of `index.html` rather than keeping its own copy, so the
eval always scores the prompt the console actually ships.

Key values are matched against the union of returned parameter values rather than against a named field, since
the model may reasonably name a parameter differently than the fixture does. What matters is whether the number
survived.

Reproduce with:

```bash
ANTHROPIC_API_KEY=sk-ant-... node eval/run.mjs
```

## Known limits

Synthetic fixtures written by the same author as the prompt will flatter the pipeline. The only honest version
of this eval runs against mandates already coded in a production compliance engine, where the labels are what
an analyst actually did. That is the first thing to build with real access.
