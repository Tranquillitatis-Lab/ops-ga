# Replication on OPS 0.5.4: the -23.5% does not repeat

Same design as the record one level up, rerun on **dsh-ops 0.5.4** (npm tarball, integrity
`sha512-JHRpQ9tr…MgA==`; worker rebuilt from the package sources for aarch64-linux-ohos).
0.5.4 is a patch release: it fixes `ops-ptc` batching guidance defaulting and reworks the CI
matrix; nothing in it touches compaction.

Fresh ledgers: control **126 calls / CNY 2.28**, treatment **114 calls / CNY 2.05**, both
`pending: false`. Same suite, same seed, same search settings (population 3, generations 1,
elites 2, `llmMutation: false`, `repetitions: 1`), four lanes.

## Held-out totals on the baseline genome (same measurement as the 0.5.3 record)

| lane | 0.5.4 control | 0.5.4 + live-compact | delta | 0.5.3 record delta |
| --- | --- | --- | --- | --- |
| operations | 172,258 | 201,777 | **+17.1%** | -20.3% |
| interface | 186,025 | 182,949 | -1.7% | -27.4% |
| ptc | 217,640 | 190,676 | -12.4% | -22.6% |
| discovery | 225,111 | 203,490 | -9.6% | -24.4% |
| **total (24 pairs)** | **801,034** | **778,892** | **-2.8%** | **-23.5%** |

The sign flips on operations and the magnitude collapses from -23.5% to -2.8%. The 0.5.3 number
was run-to-run variance, as the plugin's own counters already said.

## The plugin still never fires

`dsh-live-compact stats` after 114 paid episodes: **cuts 0 / saved 0 / rewrite 0**, 115 shadow
captures, zero `spine-checkpoint` events in any session. Its compaction needs a session that
stays resident between turns and a long-read round to cut; single-turn headless episodes have
neither.

## Search-level outcome on 0.5.4

| lane | control final | treatment final |
| --- | --- | --- |
| operations | 172,258 -> 244,872 (**-42.2%**, 6/6, `c12a32e7`) | identity 0.0%, 6/6 |
| interface | identity 0.0%, 6/6 | identity 0.0%, 6/6 |
| ptc | identity 0.0%, 6/6 | identity 0.0%, 6/6 |
| discovery | 225,111 -> 205,056 (**+8.9%**, 6/6, `e759dae7`) | identity 0.0%, 6/6 |

`c12a32e7` won the control operations gate and then cost 42.2% more on the held-out split — the
same genome was +41% on the holdout in the 2026-11-03 run. The discovery lane exported **8.9%**
with 6/6 resolved, the first exportable candidate since the 0.5.0 run.

## Same genome, different run

| genome | lane | previous run | this run | delta |
| --- | --- | --- | --- | --- |
| `f7a2d24f` | operations (treatment) | 269,833 | 201,777 | -25.2% |
| `8f41fc29` | interface (control) | 254,974 | 186,025 | -27.0% |
| `9b488c50` | discovery (control) | 289,846 | 203,490 | -29.8% |
| `8aa5b7f8` | ptc (control) | 217,640 | 217,640 | 0.0% |

Three of four lanes moved by 25-30% on identical inputs and seeds. That is the noise floor any
K=1 guidance comparison runs against, and it is larger than every guidance effect measured in
this series.

## Files

- `lanes.csv` — per lane x arm final summary
- `ab-pairs.csv` — 24 paired baseline-genome observations (control vs treatment)
- `budgets.csv` — settled ledger per arm
