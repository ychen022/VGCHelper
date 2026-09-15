# VGCHelper

VGCHelper is a local MCP server for Pokemon Champions VGC doubles. It gives an MCP-capable chat host deterministic replay evidence, metagame snapshots, and Champions damage calculations while the host handles the conversational coaching.

The default ruleset is **Pokemon Champions VGC 2026 Regulation M-C** for analysis, simulations, agent battles, replay import and corpus filtering.

## Play against an agent

The local **Champions M-C** battle mode lets you play against an isolated reasoning agent in a Showdown-style browser interface. Ask your conversation agent to start a battle with two assigned team exports/PokePaste links and an explicit open/closed team-sheet choice. The coordinator uses `vgc_battle_start` and launches a fresh player with the returned handoff. Select your four, choose doubles actions and targets, switch, Mega Evolve and review the live log in the browser.

User clocks default to M-C's 90-second preview, 45-second selection and 7-minute player bank; agent clocks default to disabled. Either timer can be changed in the initial ask. Agent reasoning defaults to medium with a host-selected model. After a game, rematch with prior battle memory or a fresh isolated agent. Original team sheets and private player views prevent hidden stats, selected reserves and pending choices from crossing player boundaries. Human battles and agent simulations share the same pinned M-C Showdown engine. The Champions calculator is also updated for M-C species, items, abilities and mechanics.

Battle rules and launch defaults are bundled in the MCP: start directly without a web rules lookup, or inspect `vgc_battle_rules` first. See [local human battles](docs/human-battles.md) for setup, the isolated-agent handoff, timers, rematch supervision and all eight battle MCP tools. Rebuild and reconnect your MCP server to load them.

The battle interface includes:

- A separate Mega Evolution toggle alongside move and target selection.
- Six-member team sidebars with last-known HP, fainted markers and unknown-selection states; opponent HP is labeled with a percent sign.
- Side-specific conditions beside the affected team, shared conditions below the scene, and remaining/max turn counters.
- Terrain and weather log entries naming the triggering ability, Pokemon and side in engine order, plus explicit failed-move messages.
- Showdown replay HTML downloads by default and a separate text-log button, named `<ShowdownFormatName>-sim-yyyy-mm-dd-hh-mm-ss.html/log`.

The probabilistic simulator adds full-game outcome sampling, player-specific hidden-information beliefs, information-set search, Featured Teams cohort experiments and replay counterfactuals. See [simulation usage and limits](docs/simulation.md) and the [historical M-B stages 4–6 evaluation](docs/simulation-stages-4-6-evaluation.md). Rebuild and reconnect the MCP client to discover the six simulation tools.

## Requirements

- Node.js 22 or newer
- An MCP client such as GitHub Copilot
- Network access for installation, metagame refreshes, PokePaste links and remote battle/replay visual assets; battle mechanics run locally

## Setup

```powershell
npm install
npm run build
```

For GitHub Copilot, add this server entry to `%USERPROFILE%\.copilot\mcp-config.json`, preserving any other registered servers:

```json
{
  "mcpServers": {
    "vgc-helper": {
      "type": "local",
      "command": "node",
      "args": ["dist\\index.js"],
      "cwd": "<absolute-path-to-VGCHelper>",
      "tools": ["*"]
    }
  }
}
```

Replace `<absolute-path-to-VGCHelper>` with your checkout's absolute path, escaping Windows backslashes as `\\` in JSON. The entry point is resolved relative to `cwd`.

Run `vgc_status`. Replay analysis works immediately offline with your replay and team export; opponent calculations become available from open team sheets or cached metagame sets. Run `vgc_refresh_meta` before team evaluation. The initial refresh can take several minutes because it validates the tournament sheet, linked pastes, and battle-data files. Later calls use a local cache unless `force` is set.

Local state is written to `.vgc-helper\vgc-helper.sqlite`. Override the location with `VGC_HELPER_DATA_DIR`.

### Loading updates in Copilot conversations

Copilot launches `dist\index.js`, not the TypeScript source. After an agent changes the server, run this from the project directory:

```powershell
npm run build
copilot mcp get vgc-helper
```

The registration should show **Enabled**, the compiled entry point above, and **Tools: * (all)**. The wildcard includes newly added tools without changing the registration.

Start a new Copilot conversation after rebuilding so it launches the updated server and discovers its current tool schemas. An already-running MCP connection retains its loaded code; rebuilding alone does not refresh it. No separately running server is needed.

Ask naturally, for example, "Use VGCHelper to show its status" or "Use `vgc_meta_query` to show cached Garchomp sets." Copilot may ask permission before calling a tool. Saved replays and the normal metagame cache remain in the same local database across rebuilds and new conversations.

## MCP tools

| Tool | Purpose |
|---|---|
| `vgc_battle_rules` | Read bundled M-C rules, supported formats, timers and launch defaults without a web search. |
| `vgc_battle_start` | Create a local human-versus-agent battle from two assigned team pastes. |
| `vgc_battle_open` | Retrieve the authenticated local browser URL. |
| `vgc_battle_get` | Supervise progress and rematch requests as coordinator. |
| `vgc_battle_rematch` | Start the requested rematch with actor-only memory or a fresh agent. |
| `vgc_battle_cancel` | Cancel a human-versus-agent battle. |
| `vgc_battle_agent_view` | Read the isolated player's permitted observations and legal choices. |
| `vgc_battle_agent_submit` | Submit the isolated player's action and private plan. |
| `vgc_status` | Show the regulation, calculator pin, database, and source freshness. |
| `vgc_refresh_meta` | Validate and atomically activate VGC Pastes and Champions Battle Data snapshots. |
| `vgc_replay_analyze` | Analyze a replay file/content with the user's exact Showdown team export. |
| `vgc_replay_get` | Retrieve a persisted replay coaching report. |
| `vgc_replay_turn` | Inspect the state before/after a turn and its battle events. |
| `vgc_replay_export_html` | Convert protocol text/lines, a battleLog object, or a saved simulation trace into a local replay HTML file. |
| `vgc_replay_trends` | Aggregate recurring coaching findings across local history. |
| `vgc_meta_query` | Inspect cached published sets and usage with source provenance. |
| `vgc_team_evaluate` | Evaluate all 15 user leads against representative opposing leads. |
| `vgc_matchup_detail` | Inspect bounded positions from a saved lead matrix. |
| `vgc_simulate_battle` | Start full-game sampling from exact or partial teams, with optional paired p1 team edits. |
| `vgc_simulate_cohort` | Run a bounded Featured Teams cohort, compare opponent policies and fixed/reselected plans. |
| `vgc_replay_counterfactual` | Compare root actions from a saved checkpoint or supported public replay prefix. |
| `vgc_simulation_get` | Poll persisted progress, outcome counts and conditional estimates. |
| `vgc_simulation_cancel` | Cancel queued/running work and retain completed progress. |
| `vgc_simulation_trace` | Inspect one player's observations, beliefs and sampled decisions. |
| `vgc_reasoning_battle_start` | Create an externally played battle with separate coordinator and player credentials. |
| `vgc_reasoning_battle_continue` | Start external players from a saved checkpoint or supported replay prefix. |
| `vgc_reasoning_battle_get` | Inspect coordinator progress and completed battle results. |
| `vgc_reasoning_battle_cancel` | Cancel an externally played battle without filling missing choices. |
| `vgc_player_view` | Read a player's own request and public battle evidence. |
| `vgc_player_evaluate` | Compare bounded joint plans using only actor-accessible hypotheses. |
| `vgc_player_submit` | Commit a player's legal command and concise private plan. |
| `vgc_damage_calculate` | Run an auditable standalone Champions doubles damage calculation. |

The server also exposes the `replay-coach` and `team-builder` prompts plus regulation, methodology, and source-status resources.

## Replay workflow

Provide:

1. A Pokemon Showdown replay as `.json`, `.log`, downloaded replay HTML, raw protocol text, or a local path to one of those files.
2. The exact six-Pokemon Showdown team export used in that battle.
3. The player name only if the team cannot uniquely identify the replay side.

Replay logs do not reveal full private sets. The user's team is authoritative; opponent moves, items, abilities, and skill points remain confidence-ranked hypotheses until revealed.

The importer accepts explicit `[Gen 9 Champions] VGC 2026 Reg M-C` and its Bo3 variant. The older broad `Champions VGC 2026` label is rejected as ambiguous; dataset category membership alone does not establish M-C. Each report records its team fingerprint, regulation fingerprint and calculator version. Open team sheets are read when present; they do not disclose skill points.

The initial report prioritizes up to five findings. A faint or failed move is a review prompt, not proof of a mistake. Alternatives cite pre-turn state and include a partner objective, plausible opposing responses and conditional damage. Inspect `vgc_replay_turn` for full evidence and use only `beforeEvents` when judging the decision. Switching alternatives use previously revealed bench Pokémon, not arbitrary members of the six. Filter trends with `team_version` to compare the same team; repeated analyses of one game count once.

Raw replays, normalized events, turn states, and reports stay in local SQLite. Spectator/chat messages are not included in coaching output.

Fabricated inputs for a quick smoke test are available at `examples\sample-team.txt` and `examples\sample-replay.log`.

## Team workflow

`vgc_team_evaluate` parses a complete Showdown export and selects a bounded cohort (12 by default, controlled by the regulation profile). Selection combines user-prioritized threats, recent results, weather/control diversity, and distinct published sets. The `coverage` report identifies tested and omitted priorities, source reasons, and sampling limits. This is tournament-source coverage, not ladder usage.

The evaluator enumerates all 15-by-15 lead pairs and explicit legal Mega choices on both sides, including holding Mega. Initial entry Intimidate and weather resolve before selected Mega abilities; damage and effective Speed use explicit positions. A stone holder that does not Mega evolve stays in its base form. Unknown pre-Mega abilities and unresolved ties remain conditional assumptions. The screen measures:

- speed-adjusted immediate damage pressure
- incoming knockout pressure resolved in priority and Speed order
- raw and post-preemption pressure for auditing the score
- speed control, Fake Out, redirection, protection, and related turn-one control

The full matrix is persisted, while the initial tool response remains bounded. Use `vgc_matchup_detail` to inspect a specific archetype or pair of leads. Its `user_mega` and `opponent_mega` filters accept a roster species or `null` for holding Mega. `opening_offset` pages conditional openings and returns `nextOpeningOffset`; `comparison_offset` pages comparison benchmarks and returns `comparison.nextOffset`.

Optional `evaluation_context` accepts:

```json
{
  "priorityThreats": ["Charizard-Mega-Y", "Floette-Mega"],
  "roles": [{"pokemon": "Sneasler", "move": "Rock Slide", "purpose": "Immediate Charizard Y pressure", "target": "Charizard-Mega-Y"}],
  "modes": [{"id": "fairy-plan", "bringFour": ["Banette", "Scizor", "Milotic", "Sneasler"], "mega": "Banette", "targets": ["Floette-Mega"]}]
}
```

Modes may optionally specify a two-member `lead`. Each reported plan fixes its four, lead and Mega allocation before testing opposing responses. Roles and modes are hypotheses, never positive score bonuses. User modes are reported alongside inferred alternatives; bench utility remains a conditional coverage heuristic rather than a switching simulation. The supplied roster, moves and Mega eligibility are validated against mode declarations.

Supply `comparison_team_export` to compare a proposed edit before recommending it. Both versions use the same selected opponent teams and published sets. The comparison includes opening-score deltas, declared-mode deltas, lost role/mode hypotheses, and bounded damage benchmarks with gains and losses. Scenarios include published bulk or explicitly unknown physical/special bulk, neutral/sun sensitivity, Attack drops, and Helping Hand. Accuracy-adjusted KO probabilities are separate from KO rolls conditional on hitting, and neither establishes that the attacker gets to act. Alternate teammate attacks report Mega and support requirements. Scenario and result caps disclose omissions, including evaluated gains/losses omitted from presentation. Detail retrieval preserves both exact team versions and scenario sources.

`examples/contextual-team.txt` reproduces the discussed six-Pokemon team. `examples/contextual-evaluation.json` supplies illustrative fixed fours for its two modes, not assertions of optimal selections. After building, `node scripts/validate-contextual.mjs` tests it against the active offline cache and writes a compact report to `examples/reports/contextual-validation.json`.

Scores are **not win probabilities**. V0 does not simulate switching trees, simultaneous move combinations beyond its bounded heuristics, adaptation across games, or a full best-of-three.

The report adds per-opponent fixed mode plans, opening menus with both partners' actions, and three practice experiments with tradeoffs. Selected openings compare unknown spreads against a labeled bulk sensitivity scenario. Helping Hand modifies partner damage; earlier Haze conditionally clears both sides' stages; Destiny Bond is described as contingent on action timing and a direct KO. Spread moves show side-labeled ally damage where applicable. Only two opening scenarios are returned initially; the complete set is persisted and available through `vgc_matchup_detail` (up to six per page).

Control effects in those V0 menus are conditional. Fake Out action denial, redirection, same-turn speed-control resolution, competing weather ties, residual damage, and many other interactions are not a complete turn simulation. The screen still uses a static control bonus. Multi-hit damage uses a weighted total-damage distribution conditional on the calculator's selected hit count. Those heuristic reports apply structural/stat validation; the separate simulation tools use the bundled Showdown learnset/format validator and full battle engine.

## Source integrity

Published team fields retain field-level provenance; an absent spread is unknown. Champions Battle Data's `Current` label does not establish M-C membership. Unverified usage remains queryable as context but is excluded from set hydration and matchup scoring. An optional `sources.championsBattleData.binding` with `regulationId`, `season`, `validFrom`, and `validTo` can admit explicitly verified dated snapshots. Do not infer a regulation window from download time.

Provider failures preserve the previously active snapshot. Missing usage coverage is reported explicitly. Dates, hashes and source versions make saved reports reproducible; featured-team representation is not a ladder usage estimate.

## Regulation changes

Profiles live in `config\regulations`. `config\active-regulation.json` selects the default profile.

When a season changes:

1. Add a new immutable profile with accepted Showdown formats, rules, source mappings, and evaluation bounds.
2. Update and verify the Showdown engine pin, calculator coverage, simulation/corpus format gates and source bindings.
3. Change the active profile pointer and run the regression suite.
4. Run `vgc_refresh_meta` for the new profile.

Historical analyses retain their original regulation and source versions. The M-B profile remains available explicitly for historical replay import, and committed M-B replays and evaluation reports retain their original labels. M-B caches, learned priors and engine checkpoints are not reused as M-C evidence. Refresh meta data for M-C after updating; existing M-B results do not establish M-C playing strength. New experiment scripts use `.vgc-helper/experiments/m-c` and require fresh M-C input.

## Data sources

- [Pokemon Showdown replay protocol and API](https://github.com/smogon/pokemon-showdown-client/blob/master/WEB-API.md)
- [Pokemon Showdown battle event protocol](https://github.com/smogon/pokemon-showdown/blob/master/sim/SIM-PROTOCOL.md)
- [HolidayOugi Pokemon Showdown replays](https://huggingface.co/datasets/HolidayOugi/pokemon-showdown-replays), used as an optional parser-compatibility corpus rather than a runtime dependency
- [VGC Pastes Regulation M-C repository](https://docs.google.com/spreadsheets/d/1axlwmzPA49rYkqXh7zHvAtSP-TKbM0ijGYBPRflLSWw/edit?gid=2001945654#gid=2001945654)
- [Smogon damage calculator](https://github.com/smogon/damage-calc), pinned to Champions-capable commit `e7fd7e59f3eef7ea42fba3c8b83261cb4a14109d`

Battle data provided by [Pokemon Champions Battle Data](https://championsbattledata.com/).

Cached source data is for analysis, not redistribution as a standalone mirror or data service.

## Development

For battles played by separate Codex or GitHub Copilot agents, use `vgc_reasoning_battle_start` and the [external reasoning player guide](docs/reasoning-players.md). Each player receives a private MCP view, can compare bounded joint-action scenarios, and submits its own action. The server persists the match and resolves simultaneous choices; it does not invoke a model API or replace missing agent choices with heuristic moves. Saved checkpoints and supported replay prefixes can start at a particular turn through `vgc_reasoning_battle_continue`.

After building, `node scripts/smoke-reasoning.mjs` verifies separate player MCP processes, credential scope, scenario evaluation, final logs and the bridge. This scripted protocol check does not measure LLM playing strength.

```powershell
npm run typecheck
npm test
npm run build
npm run smoke
```

`npm run smoke` tests the compiled stdio MCP workflow against a separate `.vgc-helper/smoke` database. `node scripts/smoke-mcp.mjs --refresh` also refreshes public data and evaluates the example team. `npm run validate:live` downloads up to ten public M-C replay JSON files and writes an import summary under `examples/public-replays`. These two network checks are manual, not part of ordinary tests.

After a successful smoke refresh, `node scripts/smoke-mcp.mjs --team` repeats the team evaluation using that cached snapshot without network access. It writes the example output locally to `examples/reports/team-smoke.json`. Connect your MCP client using the setup above; the smoke database is separate from your normal coaching history.

Local databases, machine-specific agent settings, analysis output, downloaded replay samples, and generated reports are excluded from Git. The fabricated sample inputs, two pinned public replay regression fixtures, and the pinned calculator's compiled package are included so a fresh checkout can run the offline workflow and tests.

See [validation notes](docs/validation.md) for historical evidence and its limits. Run the checks above for the current M-C implementation.

The calculator source and compiled package are vendored under `vendor\damage-calc` because the current npm release does not yet include the repository's Pokemon Champions mechanics. Its upstream MIT license is preserved in `vendor\damage-calc\LICENSE`.
