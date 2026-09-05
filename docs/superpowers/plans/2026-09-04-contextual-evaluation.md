# Contextual team evaluation implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent modules and integration review.

**Goal:** Evaluate legal Mega alternatives and matchup-specific team plans, preserve threat coverage, and compare proposed team edits against identical evidence.

**Architecture:** Keep the existing bounded damage screen, add explicit battle positions and mode selection, and expose contextual coverage and comparative reports through MCP. Separate cohort selection and comparisons into focused modules. Conditional support evidence must distinguish executed mechanics from unresolved interactions.

**Tech Stack:** TypeScript, Smogon Champions calculator, Zod MCP schemas, Vitest.

**Spec:** User-approved methodology in this conversation, September 4, 2026: legal Mega states on both sides; fixed bring-four/lead/Mega per opposing preview; threat-aware sampling; role hypotheses; before/after gains and losses; conditional reliability and support effects.

## Global constraints

- Preserve the exact supplied team and source provenance; no inferred role earns a score bonus.
- Only explicitly verified regulation usage can inform hydration or selection weights.
- Scores remain pressure heuristics, never win probabilities.
- No network dependency for tests; no new dependencies or full battle simulator.
- Workspace has no Git repository; work in place, do not initialize Git or attempt commits.

## Tasks

- [x] 1. Legal positions and fixed plans: add regression tests for dual Mega legality, base abilities, initial Intimidate then Mega ability, and fixed user decisions across opposing responses. Run failing tests, implement positions.ts and evaluator/guidance integration, rerun tests.
- [x] 2. Threat coverage: add tests where an older Charizard set must survive a recent-roster cap, distinct bulk sets remain eligible, missing priorities are disclosed, and input order is deterministic. Implement cohort.ts; integrate selection and evidence.
- [x] 3. Comparisons: test Rock Slide removal loses Charizard benchmarks while Dire Claw gains Fairy coverage; report matching scenarios, accuracy, Intimidate, bulk, and alternate teammate evidence. Implement comparison.ts without assuming battle win rates.
- [x] 4. Support and context: expose Helping Hand partner damage, Haze tradeoffs, Destiny Bond conditions, control/priority limitations, and bounded opening evidence. Validate context and mode input; persist context and comparison alongside evaluation.
- [x] 5. MCP/docs/review: expose context and comparison_team_export with retrieval, update coaching prompt and README, run typecheck, full tests, build, compiled MCP smoke and actual-team cached evaluation. Independently review and resolve material findings.

## Interface allocation

- cohort.ts: selectCohort(teams, maximum, priorityThreats) -> {teams, coverage}; independent of evaluator.
- positions.ts: explicit Mega selection and immutable entry state positions for calculator calls; root owns evaluator, contracts, guidance and MCP.
- comparison.ts: compareTeams(before, after, cohort) -> bounded same-scenario coverage changes; independent module, root integrates.

## Progress and rulings

- Approved design is in conversation; implementation is authorized without another approval round.
- Tasks 1/4/5 share evaluator interfaces and are owned by root. Tasks 2/3 use existing domain types and separate files to avoid conflicting edits.
- Cohort scenarios are shared by baseline and candidate; missing source coverage is disclosed rather than manufactured.
- Final evidence: 122/122 tests, typecheck, build, and compiled smoke pass. Cached exact-team validation passed at 7,250 legal states and detected both Charizard losses and Fairy gains for the proposed move swap.
- Independent module and final integration reviews completed. Fixed Mega-gained Intimidate, Armor Tail/Feint, pre-Mega source uncertainty, Mega-aware opening deduplication, target form aliases, preserved source knowledge, ally spread damage, report cap diversity, source provenance, pagination, and Aegislash normalization. Scoped final server re-review found no remaining actionable issues.
- No Git repository exists; source/build outputs remain in the authorized project directory. No commits, branches, merges, or remote publication were attempted.
