# OPS 0.5.3 four-lane A/B, dsh-live-compact as the variable — and why the difference is variance

This is a **benchmark execution record**, not an `external-pr/` submission: local fixture strata, no
public benchmark, no benchmark claim. It documents a full four-lane run on OPS 0.5.3 on DSH
0.2.2-rc.1 (HarmonyOS arm64) with `dsh-live-compact 1.1.5` as the only variable between two
isolated profiles, **and the post-hoc check that invalidated the causal reading**.

## Correction (read this first)

The arms differ by -23.5% on held-out tokens (see below), but the plugin never actually compacted:
its own accounting reports

```
cuts 0
saved 0
rewrite 0
```

after 120 paid episodes and 122 shadow captures (`plugin-stats.txt`). Two independent reasons:

1. **The compaction path runs but cannot commit.** Instrumenting a probe home showed the hook does
   fire (`agent/status idle` -> `finishTurn`) and, once a session accumulates several long `read`
   rounds, the selector produces a real span (12.7k-23.9k tokens at 52k-84k context). The commit
   then fails with `spine: raw backup missing before cut`: every headless turn is a separate
   process, so the tool-result backups written by the turn that produced the span are not
   available to the turn that cuts. Closing that needs a resident session (web/tui), where
   capture and cut share one process.
2. **The takeover never happened in this install.** The plugin's adapter imports the host
   packages (`@deepseek-ai/dsh-compaction-basic`, `dsh-compaction`, `dsh-llm`, `schemastery`); in
   a hand-built profile `node_modules` those are not resolvable, and the plugin falls back with
   `spine: 本会话未接管自动小切`. After symlinking the host packages into the profile (imports then
   resolve), a fresh two-turn probe at ~45k context still recorded **0 cuts, 0 saved**.
2. **The compaction runs at the end of a turn.** Live Compact checks **at the
end of a turn** and cuts finished turns; the framework's episodes are **single-turn** (one user
message, then the final answer), so a cut can never shorten the context of the episode that
produced it. The -23.5% is therefore **run-to-run behavioural variance** (step counts differ by
0-3 per task), not a plugin effect. The measurement is kept because it is a real measurement of
that variance; the plugin conclusion is withdrawn.

## Setup (pinned)

| item | value |
| --- | --- |
| DSH | 0.2.2-rc.1 source build (`harness-src/dsh-022rc1`), `headless` profile |
| OPS | `dsh-ops 0.5.3` from the official GitHub release tarball, sha256 `9695b0dc…5163` (verified against the release `SHA256SUMS`) |
| OPS worker | rebuilt from the same tag for `aarch64-linux-ohos` with three OHOS-only adaptations; worker sha256 `be5f19db…a49c` |
| plugin variable | `dsh-live-compact 1.1.5` (npm); its bundle disables `compaction-basic` and inserts `compaction-spine` |
| isolation | two dedicated `DSH_HOME`s, identical except for that bundle |
| model | `deepseek-official / deepseek-flash`, reasoningEffort `high` |
| permission | `danger-full-access` (this host cannot enforce a kernel sandbox), recorded in every artifact |
| suite | official 18-task representative suite (6 families x 3 splits) |
| search | population 3, generations 1, elites 2, `llmMutation: false`; `repetitions: 1` |
| lanes | operations, interface, ptc, discovery |

Ledgers, one fresh CNY 20 per arm: control **120 calls / CNY 2.04**, treatment **120 calls /
CNY 2.02**, both `pending: false`.

## What was measured (and what it actually is)

Each lane's **baseline genome** on the same six held-out tasks, 24 paired observations:

| lane | control tokens | treatment tokens | difference | paired CI95 (per task) |
| --- | --- | --- | --- | --- |
| operations | 338,390 | 269,833 | -20.3% | [-29,456, +6,604] |
| interface | 254,974 | 185,093 | -27.4% | [-41,333, +18,040] |
| ptc | 215,473 | 166,780 | -22.6% | [-20,388, +4,157] |
| discovery | 289,846 | 219,173 | -24.4% | [-19,242, -4,315] |
| **pooled (24)** | **1,098,683** | **840,879** | **-23.5%** | **[-19,526, -1,958]** |

Success counts are 24/24 in both arms. Decomposition of the operations lane shows where the
difference lives:

| task | control | treatment | delta | steps (control -> treatment) |
| --- | --- | --- | --- | --- |
| aggregation-test | 22,076 | 16,391 | -25.8% | 4 -> 3 |
| discovery-test | 70,381 | 43,662 | -38.0% | 10 -> 7 |
| multi-file-edit-test | 44,758 | 31,618 | -29.4% | 7 -> 5 |
| paging-test | 122,452 | 78,149 | -36.2% | 9 -> 9 |
| repair-test | 34,895 | 49,935 | **+43.1%** | 6 -> 8 |
| triage-test | 36,599 | 44,944 | **+22.8%** | 6 -> 7 |

Three of the four winning tasks won by taking fewer steps; the two losing tasks lost by taking
more. With one observation per (task, genome) that is indistinguishable from sampling noise, and
the plugin's own counter says it contributed nothing.

## Search-level outcome

| lane | control final | treatment final |
| --- | --- | --- |
| operations | identity 0.0%, 6/6 | -2.8%, 6/5, rejected |
| interface | identity 0.0%, 6/6 | identity 0.0%, 6/6 |
| ptc | -6.9%, 6/5, rejected | identity 0.0%, 6/6 |
| discovery | identity 0.0%, 6/6 | identity 0.0%, 6/6 |

No lane exported (identity controls, two held-out quality regressions, the rest `No measured token
improvement`).

## What this shows

- Shows: in this configuration the plugin's compaction path never engaged — its own counters say
  so (0 cuts over 120 single-turn episodes; 0 cuts in a two-turn 45k-token probe with the host
  packages linked). The -23.5% cannot be attributed to it.

- Shows: on single-turn episodes, this plugin cannot reduce the tokens of the episode it is
  installed in — its accounting is the proof (0 cuts over 120 episodes), not an inference.
- Shows: two independent runs of the same four-lane flow differ by ~20-27% per lane on the same
  genome, which is a useful lower bound on the noise floor for any guidance comparison at K=1.
- Does not show: any plugin saving. A multi-turn episode design (or `SPINE_MIN_TOKENS` low enough
  that a cut lands before the last turn) is required before the plugin can be measured at all.

## Files

- `lanes.csv` — per lane x arm final summary
- `ab-pairs.csv` — the 24 paired baseline-genome observations
- `budgets.csv` — settled ledger per arm
- `plugin-stats.txt` — the plugin's own `stats` output from the treatment home (cuts 0 / saved 0 / rewrite 0)
- `configs/` — redacted config per arm