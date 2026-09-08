# Stages 4–6: implementation and empirical evaluation

September 7, 2026. The search, replay-world reconstruction, cohort experiments and frozen corpus pipeline are implemented. The measurements support execution correctness and expose substantial policy/coverage limits. They do **not** establish calibrated human battle-outcome prediction.

These are historical measurements, collected before the pre-publication corrections to damage-evidence HP handling and opening-sheet validation. The numerical experiments have not been rerun after those corrections and should not be treated as measurements of the corrected implementation.

## Delivered behavior

- Actor-only information-set UCT, bounded candidate exploration, future decision nodes, independent full-game confirmation, shared outer deadlines and explicit tactical fallback counts.
- Prefix-constrained replay particles supporting switches, pivots, replacements, faints and censored/redirected actions. Exact own request and selected-four consistency are required for search worlds.
- `vgc_simulate_cohort`, policy sensitivity, fixed four/lead plans and paired fixed-versus-reselected or team-edit comparisons. Progress, cancellation and restart persistence use the existing worker system.
- Pinned M-B corpus acquisition, chronological match/team grouping, train/development/test separation, feature/model/code freezes, honest move-prediction metrics and an enforced adoption gate.

## Sources and selection

The [Featured Teams spreadsheet](https://docs.google.com/spreadsheets/d/1axlwmzPA49rYkqXh7zHvAtSP-TKbM0ijGYBPRflLSWw/edit?gid=1774271567#gid=1774271567) CSV snapshot has SHA256 `dff8b694c5ad4477382b9aff6175061140df25908fab75bab8ffe3e565e6586e`. Twelve high-placing published teams were inspected; the first four legal, distinct rosters were selected by placement, descending date and ID. All four selected teams included published spreads:

| ID | Published team | Result used for selection |
|---|---|---|
| MB861 | Takuma Yamazaki — Worlds 2026 | Champion |
| MB778 | whairing — WCS Open 2026 | Champion |
| MB763 | unskilled99_ — Talon's Fight Club #98 | Champion |
| MB684 | maGicaUra — Ranked Season M-4 | 1st |

The [HolidayOugi dataset](https://huggingface.co/datasets/HolidayOugi/pokemon-showdown-replays/tree/3bfbfa516d10ff5d32a1cf5eeca9febbf1a3ceb5) is pinned to revision `3bfbfa516d10ff5d32a1cf5eeca9febbf1a3ceb5`. Champions shards 3 and 4 totaled 296,116,205 bytes. SHA256 verification preceded ingestion. Of 200,601 scanned rows, 193,179 matched explicit M-B/M-B Bo3 IDs and tiers; M-A rows were excluded. A seeded uniform reservoir retained 2,500 eligible rows from these two shards, not from the entire dataset. Sample SHA256: `ed8b64af02b40305453bc17923ceaa2103314596e672f0098e63d1b28a229b98`.

The sample contains 2,499 completed games, 514 with both full opening sheets and 1,994 with a dataset rating (median 1117). Missing ratings and first/later Bo3-game strata are recorded. This is not an elite tournament sample. Regulation-unverified Champions Battle Data usage was not used as metagame weights.

## Battle experiments

Each baseline player faced the other three teams under tactical and damage opponent policies, eight samples per cell: **192 games**, all terminal with zero invalid or capped games. A further **96** paired fixed/reselected-plan games, **12** deliberately masked-spread games and **9** detailed-search games also completed without invalid/capped battle outcomes. These are small conditional experiments; source coverage and human-policy uncertainty greatly exceed the reported Monte Carlo sampling intervals.

| Measure | Tactical cohort, 192 games | Detailed search, 9 games | Real sample, 2,500 games |
|---|---:|---:|---:|
| Mean final turn | 5.30 | 5.56 | 6.58 |
| Protect per 100 executed moves | 3.43 | 5.07 | 11.84 |
| Control moves per 100 executed moves | 6.87 | 7.25 | 11.69 |
| Voluntary-switch proxy per game | 0.24 | 0.44 | 1.72 |

Control-move definitions and all denominators are preserved in the JSON report. The switch proxy counts post-turn-marker switches before the first move; later switches are kept separately as replacement/pivot/ambiguous. Aggregate differences mix team composition, opponent strength and policy behavior. They indicate that the current policies are more aggressive than this replay sample, not a uniquely identified tuning target.

Detailed search used production defaults: 24 selection iterations, 1.5 seconds per decision, three-turn search horizon and four independent confirmation samples, inside a three-minute cohort budget. Nine games took about **88 seconds**. Of 76 searched decisions, **58 fell back**; selection produced 1,004 rollouts, including 678 invalid sampled worlds and 300 capped rollouts. Confirmation separately produced 72 terminal results out of 263 attempts. Full battle outcomes can be valid while search-world coverage remains weak. Search strength is **not demonstrated** by these nine games.

The real sample contains 12 appearances of the MB763 roster and 11 of MB684; the other selected rosters have none. Only two disclosed sheets match a selected published team exactly, and **no battle pairs two selected cohort rosters**. Therefore there is no supported direct observed-versus-simulated matchup win-rate calibration here. Roster-matched wins against other opponents are retained as descriptive evidence only.

## Replay continuation coverage

Twelve development games were frozen before attempts, from 98 eligible games with both full sheets and at most 12 turns. With four hypothetical sheet-derived spread pairs, 128 transition attempts, four particles and 500 ms per reconstruction:

- Turn 1 reconstructed in **8/12 games**; turn 2 in **3/12**.
- 44 of 96 candidate/turn attempts succeeded. Failures were opening projection mismatch, Illusion or transition-budget exhaustion.
- All 96 attempts took about 12 seconds; the largest individual attempt took 406 ms.

One supported [actual replay](https://replay.pokemonshowdown.com/gen9championsvgc2026regmbbo3-2659090789) opens Basculegion/Grimmsnarl versus Excadrill/Tyranitar. Two legal Wave Crash target alternatives, with Spirit Break into Tyranitar, completed four continuations each. Both sides adapted after the forced action. Results were 0/4 versus 2/4 wins, with broad 95% sampling intervals approximately [0, .49] and [.15, .85]. This demonstrates the pipeline, not a reliable coaching ranking: the private spreads/reserves are hypothetical and the sample is tiny.

## Replay learning and review corrections

Exact duplicate/match-series/full-sheet groups were joined before chronological splitting. Eighteen boundary-crossing games were purged, leaving **1,746 train / 363 development / 373 test** games. The predeclared smoothing grid was [.05, .5, 2]. Training vocabulary plus one unknown category is fixed for every held-out example; calibration uses ten-bin top-label ECE. No test actions enter training counts, vocabulary or parameter selection.

Initial evaluation rejected the contextual prior. Review then found a real feature bug: replay labels did not track Mega/form and position changes while runtime features did. The correction was evaluated with the same game IDs and grid in a new versioned output directory. **Those corrected numbers reuse an inspected holdout and are explicitly a correctness recheck, not a fresh independent final test.** Initial results are preserved; code hashes now participate in the freeze.

| Corrected move model | Log loss, lower is better | Top-3 recall | Top-label ECE |
|---|---:|---:|---:|
| Global frequencies | 4.6216 | 19.26% | .0235 |
| Species frequencies | 2.3184 | 65.50% | .0206 |
| Contextual frequencies | 2.3984 | 64.69% | .0283 |

There are 7,514 usable move labels in the corrected held-out recheck. The contextual artifact remains **disabled**, failing the species baseline. The loader now retains and rechecks both baseline comparisons, so changing an adoption flag cannot bypass that failure. Tactical move prediction could not be compared fairly without inventing exact actor requests/PP/private sets; this limitation is recorded instead of synthesizing a misleading baseline.

Development runs and independent review also produced concrete fixes: Eternal Floette identity after Mega Evolution; nickname continuity; strict preview/gender checks; preserving variation in every unknown spread under a candidate cap; fixed-plan alias/candidate validation; retaining completed cohort results on cancellation; partial-result sensitivity suppression; full-game confirmation budgets and maximum-turn validation. Each behavioral fix has regression coverage. No policy was tuned simply to force aggregate human action frequencies to match.

## Verification and reproduction

The source passed type checking and the complete test suite; the compiled stdio smoke additionally exercised search cohorts, paired preview plans, checkpoint branches, completed-matchup cancellation and restart persistence. Final verification totals are recorded in [simulation validation](simulation-validation-2026-09-07.md).

Run from the repository root:

```powershell
python scripts/fetch-simulation-corpus.py --parts 3,4 --max-records 2500 --max-download-mb 350
npx tsx scripts/prepare-featured-cohort.ts
npx tsx scripts/evaluate-replay-corpus.ts .vgc-helper/experiments/stages-4-6/holidayougi-mb.jsonl .vgc-helper/experiments/stages-4-6/corrected-corpus correctness-recheck-of-previously-inspected-holdout
npx tsx scripts/evaluate-simulation.ts baseline
npx tsx scripts/evaluate-simulation.ts plans
npx tsx scripts/evaluate-simulation.ts spreads
npx tsx scripts/evaluate-simulation.ts search-detailed
npx tsx scripts/evaluate-replay-reconstruction.ts
npx tsx scripts/summarize-simulation-evaluation.ts
```

The Python reader requires `requests` and `pyarrow` (this run used workspace-local pyarrow 21.0.0). The preparation script uses the saved Featured Teams CSV and refreshes its selected public Pokepastes. Reacquiring today's sheet can change selection; use the saved snapshot for this evaluation. Local data, freezes, complete outcome reports and bounded continuation traces are under `.vgc-helper/experiments/stages-4-6/`; `evaluation-summary.json` joins the evidence. These ignored data artifacts are not committed to the repository.

The next quality gains require persistent prefix-consistent particles, broader set/transition support, better protective/switching decisions, and a new independent evaluation sample after those changes. The current tools expose uncertainty and failure coverage so their estimates can be used cautiously as model-based comparisons.
