# Simulation verification — September 7, 2026

> Historical M-B evidence. These results and pinned sources predate the M-C default and do not validate M-C outcomes. Reproducing them requires the original code/dependency revisions; current scripts target M-C.

The counts and experiments below are historical snapshots. Pre-publication review subsequently corrected exact-HP floating-point rejection, included pre-hit HP in damage likelihoods, rejected incomplete or invalid-side opening sheets, made job transitions atomic, released remotely cancelled queue slots, and stopped workers on stdio closure. The required public replay fixtures are now explicitly included in Git so the tests do not depend on a local replay download.

The corrected source passed type checking, **354 tests across 38 files** with two workers and a 30-second timeout, the production build, and all three compiled MCP smoke workflows. The numerical policy experiments below were not rerun.

## Final battle-log fix

Saved decision observations previously stopped before the final action resolution. Retained episode traces now save both channel-filtered final logs, and `vgc_simulation_trace` returns only the requested player's `battleLog`. Terminal logs include the final moves, faints and winner/tie event; unfinished logs are marked partial, and older records without logs are marked unavailable. Pre-decision observations remain unchanged.

Fresh verification passed type checking, the build, and **266 tests in 30 files**. Regression coverage checks terminal resolution, turn-capped resolution, both perspectives' public opponent HP, and legacy records. The compiled stdio smoke completed at **19:00:05 UTC**, retained a 120-line complete log through turn 5, and retrieved the identical trace after restarting the server. Its isolated artifact is `.vgc-helper/simulation-smoke/67d4b4a2-039a-48f3-b5b7-ac1824f0ada6/smoke-result.json`.

## Stages 4–6 extension

The extended source passes type checking and **263 tests in 30 files**. New regression coverage includes information-set search, actor-world reconstruction, fixed/reselected plans, cohort workers and cancellation, corpus grouping/freezes, metric validity and every reproduced review finding. Final verification includes a maximum-turn-200 search boundary regression.

The compiled stdio smoke completed at **09:51:27 UTC**, using the isolated directory `.vgc-helper/simulation-smoke/1d92cfe9-ec65-414e-95d4-e17fb18e2aae`. It discovered all six simulation tools, ran full battles and checkpoint/team comparisons, ran a search cohort with paired preview plans, cancelled a cohort while preserving a completed matchup, cancelled a long battle job, verified actor trace filtering and retrieved persisted results after reconnecting.

The [empirical evaluation](simulation-stages-4-6-evaluation.md) records 192 baseline cohort games, 96 fixed/reselected-plan games, 12 masked-spread games, 9 detailed-search games, and actual HolidayOugi replay reconstruction/continuation attempts. Independent reviews verified the corrected information boundaries, cohort cancellation, corpus metrics and adoption gate. The contextual replay artifact remains disabled. Search reconstruction and human-policy representativeness remain material limits, not passing-test claims.

## Preserved initial-version verification

The initial TypeScript source passed `npm run typecheck` and all **205 tests in 26 files** with `npx vitest run --maxWorkers=2` (21.07 seconds on this machine). The following records that earlier version, before the stages 4–6 extension.

`npm run build` passed. The final compiled stdio run of `node scripts/smoke-simulation.mjs` completed at 08:58:06 UTC and verified:

- All five simulation tools were discoverable.
- Two exact-versus-preview games completed with zero invalid/unresolved games.
- Two checkpoint root alternatives each completed two games; later decisions adapted independently.
- Baseline and edited teams each completed two paired games.
- A 10,000-sample job was cancelled after real completed progress; repeat cancellation preserved state.
- Reconnecting a fresh MCP process retrieved identical completed and cancelled records.
- Player traces excluded private engine checkpoints.

These ten completed smoke outcomes validate execution, not statistical battle strength. The raw local result is `.vgc-helper/simulation-smoke/d4aca0ba-e0bc-4e06-ae4d-a2cc3898f2c9/smoke-result.json`; the smoke uses an isolated database.

Focused tests additionally cover saved public-replay analysis-to-worker integration, a real cached M-B opening, prefix/future invariance, conditional HP matching, preserved PP/checkpoint provenance, illegal/waiting branch rejection, actor-p2 outcome orientation, hidden analyst-field invariance, item-conflicting partial completions, censored comparisons, worker recovery and output bounds. Rejected replay contexts are tested explicitly.

Independent engine, belief/policy and worker/data reviews identified and corrected concrete integration issues. The review found no remaining blocker in the inspected information boundaries or execution paths. This is not a broad cartridge mechanics audit or an independent policy-strength evaluation.

The local policy audit accepted 10 explicit M-B games: 204 executed and 3 censored move labels, with 7/1/2 grouped chronological train/validation/test games and 162 training examples. The artifact was rejected by the adoption gate. No HolidayOugi model is active by default.

Known limits and future work are recorded in [simulation usage and limits](simulation.md): synthetic fallback set priors, tactical policy bias, bounded root lookahead, approximate public-prefix world weights, restricted turn1–4 reconstruction and no calibrated ladder/tournament win-rate claim.
