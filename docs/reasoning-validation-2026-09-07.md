# External reasoning player validation

The external-agent mode is implemented and built. It uses local MCP with separate player credentials and fresh host agent contexts. The server runs Showdown mechanics and bounded hypothetical scenarios; it makes no model API calls. Actual battle choices come from the external agents.

## Automated checks

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npx vitest run --maxWorkers=4 --testTimeout=30000`: **330 tests passed across 37 files**.
- `npm run smoke`: passed the existing compiled replay/damage MCP workflow.
- `node scripts/smoke-reasoning.mjs`: completed a three-turn scripted battle across separate bound stdio MCP processes, accepted ten decisions, evaluated a plan in a worker, tested the one-call bridge, retained the terminal event, and exported complete replay HTML.

The suite covers hidden-team interventions, credential scope, hashed credential storage, simultaneous commit, private memory, idempotent retries, stale/illegal inputs, forced replacement revisions, independent database connections, cancellation, expiry, abandoned evaluation leases, worker termination, saved replay-prefix isolation, legal play with insufficient prior coverage, published set recombination, and defensive scenario diversity. Unknown player input keys now fail validation instead of silently discarding misspelled private-memory fields.

Default five-second timeouts failed in existing CPU-heavy team-analysis tests during concurrent runs. The full successful run used the explicit longer timeout above; test assertions were retained. The scripted smoke is a protocol/mechanics check, not an LLM playing-strength measurement.

## Actual isolated Codex trial

Two fresh Codex agents received no inherited coordinator conversation. Each received only its own bridge token-file path and instructions to use the three player tools. They played the contextual Staraptor/Banette team against a sampled published-set scenario for the MB861 roster, with a four-turn limit and ten-minute deadline.

All **14 decisions** were accepted: two preview choices, eight normal turn choices and four replacements. The match stopped as `capped` at the turn-5 boundary, with an unresolved outcome. It was deliberately a bounded trial, not a completed competitive game. Both agents used Protect on turn 2. They also selected Helping Hand combinations, speed control, priority attacks and switches to anticipate Fighting attacks. These examples show that real model decisions flowed through the interface; they do not establish that the decisions were optimal.

The trial made nine scenario-evaluation calls. Three returned one paired sample each; the other six returned no paired samples. Later public-prefix reconstruction often could not match the observations within its bounded search, including gender/selection constraints. Several calls exhausted their short budget. The agents continued by choosing from their visible evidence and legal commands, without server-selected fallback actions.

The agents identified stale nested HP values on fainted public board records and silent acceptance of `private_plan`/`contingent_plan` in place of `plan`. Both issues were reproduced, fixed and regression-tested after the trial. The final compiled scripted smoke uses the corrected interface.

The local trial report and both partial replay HTML files are under `.vgc-helper/diagnostics/reasoning-agents-20260907/`. These ignored artifacts contain the detailed move summaries and final player-perspective logs. The trial used fresh contexts and scoped MCP calls; it was not an adversarial test of an OS sandbox.

## Remaining limits

The mode provides an external reasoning player, not a validated human-strength opponent. Broader decision benchmarks and complete games remain needed. Scenario reconstruction coverage after complex histories is currently the main limitation: the engine can continue the real match while the actor-only hypothetical evaluator reports unsupported reconstruction. No privileged live checkpoint is used to fill that gap. Forced-switch planning roots are explicitly unsupported by the evaluator, though actual external players can make replacements normally.

Codex desktop agents were exercised through the bridge. Codex CLI and GitHub Copilot CLI configuration examples were checked against installed CLI help and official documentation, but no Copilot model game was run. The local Codex CLI had no login; the desktop trial used fresh Codex subagents instead. See [the host setup guide](reasoning-players.md) for the distinction between MCP capability scope and host filesystem/process isolation.
