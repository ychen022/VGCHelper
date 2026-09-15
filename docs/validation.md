# V0 validation

> Historical M-B evidence. These results and pinned sources predate the M-C default and do not validate M-C outcomes. Reproducing them requires the original code/dependency revisions; current scripts target M-C.

Paths under `examples/reports` and `examples/public-replays` below refer to locally generated artifacts. Only the pinned public replays `gen9championsvgc2026regmb-2675724766.json` and `gen9championsvgc2026regmb-2675725887.json` needed by the regression tests are committed; use the reproduction commands to generate the remaining artifacts.

## Contextual-v1 evaluation update — 2026-09-04

Verified after the update: **122 tests across 17 suites pass**, TypeScript checking passes, the compiled build succeeds, and `npm run smoke` passes through the stdio MCP transport. The MCP integration suite additionally exercises context validation, fixed modes, same-cohort comparisons, persisted source provenance, exact candidate retrieval, and opening/comparison pagination.

`node scripts/validate-contextual.mjs` ran the exact team in `examples/contextual-team.txt` against 12 cached M-B teams. It screened **7,250 legal lead/Mega states**, included both prioritized Charizard Y and Floette, and retained the illustrative Banette Fairy mode. Comparing Rock Slide with Dire Claw detected Charizard Y coverage losses and Fairy coverage gains. The report is saved at `examples/reports/contextual-validation.json`.

The benchmark run constructed 752 candidate scenarios, evaluated 128, and disclosed 624 omitted scenarios. The evaluated sample reported 29 gains and 5 losses, with no evaluated gains/losses omitted from that report. These counts are sensitivity-scenario outcomes, **not matchup frequencies or an overall recommendation**. Both versions used identical selected sources and conditions. The illustrative fixed fours are testing hypotheses, not claims of optimal preview selection.

New regressions cover mutually exclusive Mega allocation, holding base forms, initial and Mega-gained Intimidate, Contrary timing, effective Choice Scarf/Chlorophyll Speed, Armor Tail versus Feint, Aegislash stances, threat-preserving cohort limits, source knowledge-aware deduplication, fixed context modes, Helping Hand/Haze/Destiny Bond evidence, side-labeled ally spread damage, weighted damage distributions, and diversity under comparison-report caps.

Remaining bounds are explicit: the matrix assumes damaging plans connect and retains a static control bonus; nominal accuracy is reported separately for supported comparison moves. Support menus do not resolve a full simultaneous turn, switch tree, status sequence, residual damage, or endgame. Known entry Intimidate/weather and selected Mega states are modeled; other entry effects and ambiguous pre-Mega abilities require conditional interpretation. The compiled files are rebuilt; an existing MCP process must reconnect/restart to load the new input schema.

## Scope

The implementation extends the existing local MCP prototype. Reports provide evidence and bounded conditional scenarios. They do not establish a calibrated advantage or replace a complete simulator.

## Automated coverage

Regression suites cover explicit M-B format isolation; downloaded HTML attribute ordering; JSON/log equivalence; turn snapshots; open team sheets; Mega forms and passive abilities; public HP uncertainty; effect attribution; consumed berries; temporary Protect state; position-aware damage; weighted multi-hit totals; pre-turn knowledge isolation; failed control moves; team-specific deduplicated history; source freshness and rollback; source aliases and missing coverage; lead matrices; conditional openings; and MCP persistence/retrieval.

Use `npm test`, `npm run typecheck`, and `npm run build` from the project root. `npm run smoke` exercises the compiled stdio transport using a separate database at `.vgc-helper/smoke`.

Prior V0 verification on 2026-09-04: 80 tests across 12 suites passed, TypeScript checking passed, and the compiled build succeeded. The earlier stdio smoke check exercised status, replay analysis, saved-report retrieval, turn evidence, standalone damage, source refresh, team evaluation and matchup retrieval.

## Live source and team evaluation

The live refresh loaded 257 published M-B teams and 5,256 usage rows. It reported missing usage for Floette-Eternal-Mega and Maushold and retained the published teams. Usage was explicitly unverified for regulation membership and excluded from set hydration and scoring. The source version was `20260903163627216`; the sheet snapshot hash begins `c814edd229b17bbb`.

The compiled team workflow evaluated the fabricated sample team against 12 representatives, persisted 2,700 lead matchups and 586 conditional openings, and retrieved two matchup details. The compact initial result is saved at `examples/reports/team-smoke.json`. Aegislash's Showdown base name exposed a calculator naming mismatch; the adapter now handles Shield/Blade explicitly with regression coverage and a stance-order assumption.

The source audit found 254 teams with six published Pokemon and four listed moves each. Across all sets, 462 omit spreads, 14 omit nature, and one omits an item. Reports retain these gaps; source membership and a parsed paste do not make every set field known.

## Public replay evidence

On 2026-09-04, `scripts/validate-live.mjs` fetched ten public explicit M-B JSON replays through Showdown's documented API. All ten imported successfully, spanning 2–11 turns. IDs and results are recorded in `examples/public-replays/validation.json`.

Replay `gen9championsvgc2026regmb-2675724766` was manually inspected against its log: six turns, six preview members per side, Charizard-Mega-Y with Drought and 2% displayed HP before turn two, and a final empty opponent board. Its Sitrus Berry consumption and Protect expiration sequences exposed and now guard two reducer bugs. Another eleven-turn replay was inspected for switching, Mega changes, failed moves and forfeit termination.

These public samples had no open-sheet events. Open-sheet parsing is covered by packed fixtures checked against Showdown's `showOpenTeamSheets` implementation. Downloaded HTML compatibility is fixture-tested, not validated against a user-supplied downloaded file. Public logs do not reveal exact user spreads, so these imports do not constitute ten expert-reviewed coaching reports.

## Interpretation limits

- Current usage API labels are not verified M-B labels. Unbound usage is contextual only; published M-B teams remain the evaluation cohort.
- Opening menus do not exactly resolve Fake Out, redirection, speed changes, entry abilities, accuracy, switching, survival branches, repeated Protect or all move conditions.
- Damage is conditional on supplied state and the calculator's selected hit count. Unknown spreads receive labeled scenarios, not silently asserted exact stats.
- The legacy matrix uses a heuristic control bonus and conditional knockout preemption. Scores are not win probabilities.
- Team import performs structural/stat checks; full species/move/ability legality is not validated by a bundled Showdown validator.
- Ten recent public replays provide an integration sample, not a representative metagame training corpus. Personal coaching quality needs evaluation with the user's exact teams and decisions.

## Reproduction

`npm run validate:live` refreshes the public replay sample. `node scripts/smoke-mcp.mjs --refresh` refreshes the real providers and evaluates the sample team, saving a compact report at `examples/reports/team-smoke.json`. Network access is required for these commands. Neither command changes the normal user-history database.
