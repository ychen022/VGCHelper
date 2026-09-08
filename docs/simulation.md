# Probabilistic Champions battle simulation

The simulator runs complete Champions M-B doubles games with a pinned Showdown engine. Both players choose independently from their own requests, public observations and uncertain opponent-set beliefs. Reports measure outcomes under these policies and priors; they are not calibrated ladder or tournament win rates.

## Start a report

Use `vgc_simulate_battle` with two team inputs. Each input has exactly one of `team_export` (a complete six-Pokemon Showdown export) or `preview` (six species). A preview can also include `known`, containing any analyst-supplied item, ability, nature, move subset or `skillPoints` constraints. Known inputs constrain the sampled real team, but the opposing policy does not learn them automatically.

```json
{
  "p1": {"team_export": "<complete Showdown export>"},
  "p2": {
    "preview": ["Dragonite", "Garchomp", "Whimsicott", "Kingambit", "Sneasler", "Basculegion"],
    "known": [{"species": "Garchomp", "moves": ["Rock Slide"]}]
  },
  "information_mode": "closed",
  "samples": 100,
  "max_turns": 80,
  "budget_ms": 180000,
  "seed": "team-review-001"
}
```

Defaults are 100 games, an absolute turn limit of 80 and a three-minute worker budget. The job returns immediately. Poll `vgc_simulation_get` with `job_id`; cancel with `vgc_simulation_cancel`. The server remains responsive during computation. Progress and terminal results survive server restart; abandoned jobs are marked interrupted using owner PID and a heartbeat lease.

Use `information_mode: "open_sheet"` when both players have opening sheets. Sheets reveal moves/items/abilities as the engine specifies, without exposing investment or exact opposing HP. Full opposing exports supplied to the analyst stay hidden in closed mode. Each actor knows its own selected four, complete set and exact own request.

`p1_policy` and `p2_policy` accept `tactical`, `damage` or `search`. The default remains tactical. Search is an experimental information-set UCT policy; it is slower and its reconstruction coverage is reported explicitly. Try several opponent styles to measure sensitivity. A single policy matchup cannot establish general team viability.

The fast policies use `belief-credible-v3`: they reject dead ally targets, unmodeled friendly attacks/hostile status, redundant empty-foe targets, expired Fake Out, and Helping Hand without a partner attack. Partner support and healing remain available; healing uses the recipient of a simultaneous switch. Intentional ally-damage combinations such as activating an ally's item are not modeled by these policies. Showdown's full legal command space remains available for explicitly supplied counterfactuals.

Sampling keeps the top 10% of supported joint plans (including score ties), within 18 heuristic points of the best tactical score or 12 for damage. The old uniform exploration floor is removed. Optional `action_selection` applies to battle, cohort and counterfactual requests and to fast search continuations:

```json
{"action_selection": {"topFraction": 0.1, "maxScoreGap": 18}}
```

`topFraction` must be greater than zero and at most one; `maxScoreGap` must be 0–10000. A zero gap retains only best-score ties. These settings restrict heuristic sampling, not engine accuracy/critical-hit randomness, and do not calibrate human action probabilities. The report records them in `configuration.actionSelection`; an omitted gap uses the policy-specific defaults above. Filtering does not remedy all move-order, strategy or opponent-prior weaknesses.

Search and automatic counterfactual proposals use a separate planning pool. It retains the best-scored plan and representatives for Protect, speed control, support, switching and setup before filling remaining slots by score. Very small `candidateCap` values can still omit families. Low immediate damage therefore does not automatically exclude defensive plans from planning. External LLM players use the separate [reasoning-player workflow](reasoning-players.md); these automated policies do not invoke an LLM.

## Information-set search and cohorts

Set `p1_policy: "search"` for bounded lookahead. Optional `search` settings use camelCase: `iterations` (24), `budgetMs` (1500 per decision), `maxTurns` (3 future turns), `maxDepth` (12 decision phases), `candidateCap` (8), and `confirmationSamples` (4). The outer `budget_ms` always limits the job. Search reserves 30% of its decision budget for independent, frozen-policy full-game confirmation. Partial confirmation retains terminal/capped/invalid counts and suppresses its win rate.

Each root iteration samples an imaginary opponent team from that actor's belief. The factory receives only the actor view, belief and fresh seed. A non-preview world must reproduce the actor's exact request, selected four and public history. Search nodes share statistics only when actor-visible information matches; neither the real checkpoint nor the real opposing request enters this factory. Opponents choose using their own sampled view and public source priors before simultaneous resolution.

`search.rootActions.meanValue` in a decision trace is a selection utility combining terminal results and capped public-HP heuristics, **not a win probability**. The report's `search` totals distinguish failed reconstruction, capped rollouts, tactical fallbacks and confirmation outcomes. Time-limited searches are not bit-for-bit reproducible across machine loads. Use fixed seeds and sufficiently generous budgets when comparing completed sample counts.

Use `vgc_simulate_cohort` to evaluate a team against cached Featured Teams:

```json
{
  "team_export": "<complete six-Pokemon export>",
  "cohort_size": 4,
  "player_policy": "tactical",
  "policy_profiles": ["tactical", "damage"],
  "samples": 100,
  "budget_ms": 180000,
  "seed": "cohort-001"
}
```

Alternatively provide `opponent_ids`. Automatic selection orders reported placement (including Champion/Runner-up), date and ID, retaining distinct rosters. It is not a metagame usage sample. Refresh sources first if the cache lacks complete published sets. The budget is shared across opponents and policy profiles. Poll/cancel with the same job tools; cancellation preserves completed matchup summaries. Aggregate and sensitivity values are withheld when coverage is incomplete. Aggregates describe the first/baseline variant; paired variants remain available per matchup.

## Team edits and decision alternatives

Add `comparison_team_export` to replace p1 for a paired comparison. Both versions face the same sampled opponent teams and start with paired random seeds. Each selects its own four unless `p1_fixed_plan` is supplied. Fixed plans contain four distinct species in lead/reserve order; `p2_fixed_plan` is also supported. Add `compare_reselected_plan: true` with a fixed p1 plan to compare that plan against adaptive preview selection for the same team. This cannot combine with a team replacement or replay branch. Cohorts expose the same controls as `fixed_plan` and `compare_reselected_plan`. Once paths diverge, shared seeds do not force identical random events.

For an existing simulation, call `vgc_replay_counterfactual`:

```json
{
  "job_id": "sim_<id>",
  "trace_index": 0,
  "turn": 1,
  "actor": "p1",
  "samples": 100,
  "seed": "turn-one-comparison"
}
```

By default this compares the saved decision, when present, with two tactical alternatives. Explicit `actions` can supply up to eight `{label, command}` objects using legal Showdown joint-command syntax, such as `move 1 1, move 4`. Commands refer to the actor's current request, not the original export order. Request `vgc_simulation_trace` to inspect decisions and candidate commands. A waiting player has no decision to override and is rejected.

Only the root action is forced. Both players then re-evaluate their own observations throughout each continuation. `continuation_policy` accepts tactical, damage or search, with optional search settings. Automatic root candidates are chosen by tactical scores. Outcome rankings are exploratory and should be confirmed with fresh samples after fixing the compared actions. No equilibrium or tournament-strength claim follows from this search.

Exact saved checkpoints hold one specific sampled world fixed while future randomness changes. Default checkpoints cover turns 1–5 of the first game; `checkpoint_turns` can request up to eight turns. At most five first-game variant traces are retained. Private checkpoint contents are stored locally for branching and excluded from MCP trace responses.

For a saved replay coaching analysis, substitute `analysis_id` for `job_id`. Only the analyzed player's perspective is supported. The adapter reads events strictly before the requested action boundary, samples hidden reserves and opposing sets, and verifies the generated public event/HP projection. It does not replay the recorded future as the opponent's counterfactual choices.

Public reconstruction supports complete turn boundaries through turn 200, subject to a bounded event-constrained particle search. Supported transitions include voluntary switches, pivots, forced replacements, faints, flinches and uncertain targets. Censored commands remain latent hypotheses with different possible PP/counters. Every retained transition must reproduce the observed mechanical events and HP projection; guessed HP/PP is never injected. Illusion, partial-turn forced-switch roots, partial/late sheet exchange, budget exhaustion and projection mismatches remain explicit failures. Public root switch alternatives are rejected because an unknown selected reserve could change what `switch 3` means between samples. Exact saved checkpoints support legal switching.

Exact M-B and M-B Bo3 battle tiers are recognized. A single Bo3 game does not restore disclosures or adaptations from earlier games in its series. Format M-A is not pooled into M-B inference.

Up to 16 candidate worlds are attempted for a supported public start, with bounded conditional transition sampling inside each reconstruction. These form an approximate prefix-consistent mixture: full prefix likelihoods are not integrated into team weights. Rejection counts and reconstruction assumptions are reported. Some valid real replays will therefore remain unsupported until their public mechanics and prior coverage are added.

## Read the report

- `outcomePerspective` identifies whose wins/losses are counted: p1 for battles/team edits, the selected actor for branches.
- `variants` separates wins, losses, draws, unresolved turn/time caps and invalid games. A cap is never a loss or draw.
- `winRate` and `monteCarlo95` are conditional sampling estimates. Any unresolved/invalid game suppresses the variant estimate; censored pairs also suppress action rankings and paired differences. Inspect counts even when estimates are unavailable.
- `comparison` describes the paired difference for two variants. Three or more root actions have exploratory `rankedActions`; no unearned precision is attached to the ranking.
- `versions`, `configuration`, `seed`, source hashes and team fingerprints preserve reproducibility. Elapsed times and job IDs naturally differ between runs.
- `selectedPlans` lists the most frequent observed four/lead orders. It is bounded to 16 entries, not an exhaustive coverage table.
- `vgc_simulation_trace` provides one selected player's battle log and decision evidence. Read `items[n].battleLog.lines` for chronological Showdown protocol lines including the final action resolution and `|win|`/`|tie` event. `battleLog.status` is `complete` for terminal games, `partial` for unfinished games (for example a turn cap), and `unavailable` when no final log was saved. Available logs include the engine's final `turn` and `ended` flag. The other player's private request, log channel and engine checkpoints are excluded.
- `decisions` remains bounded pre-action evidence: observations, known facts, candidate count/effective sample size and scored alternatives. Its observations intentionally exclude the action being chosen and its future resolution. Do not use the last decision's observations as a complete battle log. New traces also include `selectedAction`, even when the chosen command is outside the displayed alternatives: selection source, raw heuristic score, sampling probability/rank and candidate count. Probability and rank are null for search, fixed plans and forced branches because those commands were not sampled from the fast distribution. The rank is within the retained sampling pool; the candidate count is the searched pool for search decisions and the fast pool otherwise. Older saved traces may omit this field.
- Older persisted traces only saved pre-decision observations, so their final turn's resolution is unavailable. The updated tool reports this explicitly; rerun those simulations with the rebuilt server to save complete logs. Logs are retained for the same bounded first-game traces described above, not every sampled game. `offset` and `limit` paginate retained episodes, not turns; cohort traces cover the first matchup only.

Candidate teams prefer coherent cached published sets, then bounded recombination and legal synthetic completions. Missing published investment receives labeled modeled spread variants. Only regulation-verified usage can weight beliefs. Fallback default moves/items/spreads are explicitly synthetic and must not be described as meta frequencies.

Actor beliefs update on native move/item/ability reveals, opening sheets, clean damage intervals and comparable move orders. Damage conditioning includes both participants' pre-hit HP. Rounded public HP is integrated over compatible integer values with explicitly approximate uniform weights; exact HP comparisons tolerate arithmetic rounding only. Copied/transferred attributes are distinguished. Ambiguous numerical evidence—such as unsupported field/status/priority interactions—is skipped with warnings. Public expansion after an unexpected reveal preserves known fields, but historical numerical likelihoods are not recomputed for new candidates; that recovery is approximate.

The tactical policy scores legal joint actions using bounded expected damage across up to eight candidate teams, board state and explicit control/survival heuristics, with stochastic exploration. The engine resolves full mechanics, including timing, targets, switches, status, PP, Mega and randomness. Tactical scoring is deliberately less complete than the engine, so policy weaknesses remain a source of outcome bias.

## Export a battle log as replay HTML

Call `vgc_replay_export_html` with a retained simulation trace:

```json
{"job_id":"sim_...","trace_index":0,"perspective":"p1"}
```

Alternatively, pass `battle_log` as the `battleLog` object returned by `vgc_simulation_trace`, an array of protocol lines, or newline-separated protocol text. Export supports Showdown formats beyond M-B; it does not re-simulate or require a saved job for direct input. Supply exactly one of `job_id` and `battle_log`.

The result includes an absolute `path`, `mimeType`, byte count, log hash, and complete/partial status. Open the HTML file in a browser. Optional `title` sets its heading; optional `output_path` selects a new `.html` file. Otherwise a unique file is written under the configured data directory's `replays` folder. Existing files are never overwritten. Logs are limited to 4 MiB; unavailable legacy logs cannot be exported, and incomplete logs remain visibly labeled partial.

This follows Showdown's [downloaded replay format](https://github.com/smogon/pokemon-showdown-client/blob/master/play.pokemonshowdown.com/src/battle-log.ts) and [official embed player](https://github.com/smogon/pokemon-showdown-client/blob/master/play.pokemonshowdown.com/src/replay-embed.ts). The log is embedded locally; animated playback loads official scripts, styles and sprites over the internet. A raw text fallback remains readable offline. The export tool itself performs no upload or network request. Saved-job exports preserve the chosen player's information; direct inputs preserve the information supplied by the caller.

## Replay learning

After building, audit local JSON or JSONL records without ingesting other formats:

```powershell
node scripts/audit-simulation-corpus.mjs --input examples/public-replays --max-records 100 --max-bytes 10485760
```

The audit accepts explicit M-B only, records provenance/duplicates/rating coverage, labels censored actions and splits grouped games chronologically. Features exclude later reveals and earlier resolutions from the same simultaneous turn. Unknown original targets are not fabricated. The optional `--hf-metadata --revision <commit>` path records Hugging Face metadata; the script does not download the entire replay dataset or directly ingest Parquet. Export a bounded M-B JSONL subset before training from the HolidayOugi corpus.

The stages 4–6 evaluation acquired a pinned 2,500-game M-B sample from two relevant HolidayOugi Parquet shards. The broad CHAMPIONS category is accepted only with matching explicit M-B IDs and log tiers. Match-series and exact disclosed-team groups cannot cross chronological train/development/test boundaries. Source bytes, IDs, model settings and implementation hashes are frozen before evaluation. The current artifact is **not adopted** because it fails the species-frequency baseline. See the [empirical report](simulation-stages-4-6-evaluation.md), including its explicit holdout-reuse limitation after correctness review.

An optional `opponent_action_prior_path` can load a standalone artifact for an explicit 15% p2 tactical/fallback move-prior mixture. Loading rechecks M-B identity, source hash, shaped finite counts, at least 500 training examples, at least 50 held-out examples and consistent log-loss improvement over both global and species-frequency baselines. Search's tree policy does not use this mixture. Rejected artifacts cannot silently become active. Preview/switch probability mass is preserved.

This gate is a minimum evidence check, not a claim of calibrated human prediction or improvement over the tactical battle policy. Learned lead/switch/target selection, persistent posterior particles, stronger continuation policies, broader replay coverage and independent human-outcome calibration remain future work.

Reproduce source acquisition/evaluation with `scripts/fetch-simulation-corpus.py`, `scripts/prepare-featured-cohort.ts`, `scripts/evaluate-replay-corpus.ts`, `scripts/evaluate-simulation.ts`, `scripts/evaluate-replay-reconstruction.ts` and `scripts/summarize-simulation-evaluation.ts`. Commands and pinned sources are in the empirical report. Network acquisition is separate from normal MCP jobs; experiments write under `.vgc-helper/experiments/stages-4-6`.

## Reproducibility and verification

Mechanics use [Showdown revision 6b4bc34](https://github.com/smogon/pokemon-showdown/tree/6b4bc34e44cc2541929cc4b8fff96e756ab3f268), format `gen9championsvgc2026regmb`, mod `champions`. The Showdown engine uses generation 9; the existing Champions damage-calculator adapter uses generation 0. These are intentionally distinct conventions. `npm install` builds the pinned engine archive through `postinstall`.

```powershell
npm run typecheck
npx vitest run --maxWorkers=2 --testTimeout=30000
npm run build
node scripts/smoke-simulation.mjs
```

The smoke script creates a separate `.vgc-helper/simulation-smoke/<uuid>` database and verifies the compiled stdio server, complete exact-versus-preview battles, checkpoint branches, paired team edits, trace filtering, progress/cancellation and restart persistence. It does not alter the normal history/cache.

Engine tests cover deterministic continuation, actor hidden-state invariance, opening legal choices, Protect, Mega and HP/Speed agreement with the calculator for six species. This validates the pinned engine contract, not broad cartridge equivalence. One worker per MCP process has a 512 MiB old-generation limit, a bounded queue and persisted output limits. Source caches and existing heuristic reports retain their original storage and meanings.

The upstream package also includes optional Showdown server dependencies; the adapter uses simulator exports only and starts no Showdown network server. Dependency audit findings in those optional transitive packages are not evidence that battle mechanics were independently security-audited.
