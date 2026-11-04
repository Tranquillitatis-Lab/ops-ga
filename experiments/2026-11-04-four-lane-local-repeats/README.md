# Four-lane local stratified-suite run — execution record (2026-11-04)

## What this record is, and is not

This is an execution record of a four-lane run on the repository's **local stratified fixture suite**
(`node bin/ops-ga.mjs suite`), not on a public benchmark.

- It is **not** an `external-pr/` submission and makes **no benchmark claim**. There is no official
  harness, no SWE-bench instance, and no held-out public split.
- The suite is explicitly documented as coverage strata, not a production-representative corpus.
- What it does add to the record: it is the first run here with `evaluation.repetitions > 1` carried
  through selection *and* the final paired holdout, so run-to-run variance is measurable instead of
  assumed.

Read the variance section before reading the savings numbers. The savings in this record are not
distinguishable from zero, and that is the point of publishing it.

## Provenance

- Lanes: `operations`, `interface`, `ptc`, `discovery` — all four in one output directory, so they
  share one ledger and one budget.
- Search: seed `42`, population `3`, elites `2`, generations `4`, `llmMutation: true`.
- Evaluation: `repetitions: 5`, `order: balanced`, `requireRepresentativeSuite: true`
  (6 families × train/gate/test).
- Stack: DSH `0.2.1-rc.5`, OPS `0.5.0-alpha3`, `deepseek-flash`, `reasoningEffort=max`,
  `workspace-write`, `reserveTokensPerCall = 1,000,000`.
- Engine: the run was produced from a working tree that also contained the (at the time uncommitted)
  changes proposed in #9 and #10. Neither touches token accounting or scoring: #9 only relaxes a
  Windows short-path check in `safeFile`, and #10 only changes what happens when a `step_end` event
  arrives without `usage`. **That recovery path never fired in this run**
  (`unknownUsageInvocations: 0`), so no number below depends on it.
- No regressions and no unaccounted invocations were recorded in any lane.

## Results

| Lane | Winner | Winner = seed | Comparison | Baseline tokens | Candidate tokens | Savings | Mean task Δ | 95% interval | Success (base / cand) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `operations` | `402522c2` | no | repeated-task-paired | 937,399 | 756,400 | 19.31% | −6,033 | [−17,164, +902] | 30/30 · 30/30 |
| `interface` | `4eecb940` | no | repeated-task-paired | 900,228 | 840,551 | 6.63% | −1,989 | [−5,784, +1,269] | 30/30 · 30/30 |
| `ptc` | `8aa5b7f8` | **yes** | identity-control | 806,674 | 806,674 | 0.00% | 0 | [0, 0] | 30/30 · 30/30 |
| `discovery` | `1d53723b` | no | repeated-task-paired | 908,513 | 819,948 | 9.75% | −2,952 | [−7,581, +677] | 30/30 · 30/30 |

Per-pair observations: `pairs.csv` (120 rows). Per-lane summary: `lanes.csv`. Per-task means:
`per-task.csv`.

**All three non-identity lanes have a 95% interval that crosses zero**, and every lane reports
`statisticalNonInferiorityProven: false`. `ptc` selected its own seed, so both arms reused a single
evaluation; the framework labels it `identity-control` with `independentArms: false` and its interval
degenerates to `[0, 0]`. That lane demonstrates the plumbing, nothing about guidance quality.

## The suite is saturated

Every lane scored **30/30 in both arms** — 6 tasks × 5 repetitions, all successful, no exceptions. The
training split behaves the same way.

With the primary ranking key (successes) tied everywhere, candidate selection in this run was decided
**entirely by the token tie-break**. This is a property of an easy local fixture suite, not evidence
about guidance quality: it means these fixtures cannot discriminate candidates on capability, so any
rank ordering here is a token ordering.

## Run-to-run variance (why this record exists)

Same genome, same task, five independent repetitions:

| Statistic over the 48 lane×task×arm cells | Value |
| --- | --- |
| Coefficient of variation, minimum | 0.022 |
| Coefficient of variation, median | **0.230** |
| Coefficient of variation, maximum | **0.725** |
| max/min token ratio, median | 1.63 |
| max/min token ratio, maximum | **4.43** |

The worst cell is `interface` / `discovery-test` / baseline: five runs of one unchanged configuration
span 4.43× in tokens (CV 0.725).

This is the measurement a single-observation design cannot produce. Any per-task token effect smaller
than roughly this spread cannot be separated from run-to-run noise by looking at one run, which is why
the 19.31% / 6.63% / 9.75% figures above are reported as *not established* rather than as savings.

## Per-task dispersion

The aggregate hides sign changes. **7 of 24 lane×task cells used more tokens than their baseline**, and
the positive aggregate is carried by a few cells:

| Lane | Task | Savings |
| --- | --- | --- |
| `operations` | paging-test | +43.00% |
| `operations` | triage-test | **−10.95%** |
| `operations` | repair-test | **−8.57%** |
| `interface` | discovery-test | +35.38% |
| `interface` | aggregation-test | **−15.98%** |
| `interface` | repair-test | **−8.12%** |
| `discovery` | paging-test | +17.35% |
| `discovery` | aggregation-test | **−20.23%** |

Full table: `per-task.csv`. A weighted average over six tasks with this dispersion should not be read
as "guidance got better".

## What this record does not show

- No capability improvement. Success counts are identical in every arm of every lane.
- No statistical non-inferiority. The bootstrap is descriptive
  (`descriptive-task-cluster-bootstrap-v1`, 1,000 draws over 6 task clusters); six clusters is a very
  weak basis, provider sampling and cache behaviour are uncontrolled, and the framework sets
  `statisticalNonInferiorityProven: false` itself.
- No exercise of the unaccounted-usage path from #10: `unknownUsageInvocations: 0`.
- No generalisation claim. These are local fixtures; nothing here transfers to SWE-bench or to
  production OPS.

## Cost

| Item | Value |
| --- | --- |
| Session invocations | 1,431 |
| Evaluation episodes | 1,410 |
| Model steps | 6,668 |
| Tokens | 45,254,261 |
| Ledger estimate (`estimatedSpentMicros`) | CNY 27.21 |
| Ledger upper bound (`conservativeSpentMicros`) | CNY 362.03 |
| Pending at completion | `false` |

The operator reported that the provider-side bill was roughly half the ledger estimate at the applicable
idle tier. The ledger prices pinned rates and is not an invoice; the provider remains the only authority.
Raw ledger: `ledgers/four-lane-2026-11-03b.json`.

## Reproduction

```console
node bin/ops-ga.mjs suite --out .local/stratified-tasks.json
node bin/ops-ga.mjs preflight --config <private-config> --lane operations
node bin/ops-ga.mjs run --config <private-config> --lane <lane> --allow-paid
node bin/ops-ga.mjs validate --config <private-config> --lane <lane> --allow-paid
```

`configs/ops-ga.local.json` is the configuration with the private absolute paths redacted, for shape
only. It is not a run authorisation and contains no credential.

The run directory also holds per-episode receipts and private session captures; those are deliberately
not included here.
