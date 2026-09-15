# Play a local battle against an agent

Ask your conversation agent to start a battle, provide **two complete Showdown exports or PokePaste links**, label which team belongs to you and which belongs to the agent, and choose `open_sheet` or `closed`. You can specify `M-C` or omit the regulation to use the latest verified supported format.

Example request:

> Start a local Champions M-C battle. Use this paste for me: … and this paste for the agent: …. Play open team sheet.

Agent thinking defaults to **medium**. User timers default to **on**, agent timers to **off**. Add “disable my timer” or “enable the agent timer” to the initial request to change either setting.

The coordinator calls `vgc_battle_start` directly, opens its returned private browser URL, and launches **one fresh isolated player agent** with the returned agent handoff. Supported rules, defaults and date-aware regulation selection are bundled in the MCP; no web rules search or meta refresh is needed to launch. The start response includes `rules`. To inspect the rules before launching, optionally call `vgc_battle_rules` without a battle or credentials. The existing external-player architecture is used: the host supplies the model and launches the player; VGCHelper supplies the local referee and browser server. The server does not create a model session itself, invoke a model API, or substitute a heuristic bot.

## Install and run

```powershell
npm install
npm run build
```

Reconnect/restart your coordinator MCP connection to discover the new tools. Keep that connection running while the browser battle is open. No public Showdown account or connection to a Showdown battle server is needed. The interface uses remote Showdown sprite images; controls, names, HP, sheets, logs and mechanics work without those images.

| Tool | Who uses it | Purpose |
|---|---|---|
| `vgc_battle_start` | Coordinator | Validate both teams, create the match, return browser URL and isolated agent handoff. |
| `vgc_battle_rules` | Coordinator | Inspect bundled supported formats, latest resolution, team rules, timers, sheets and launch defaults without network access. |
| `vgc_battle_get` | Coordinator | Read progress/rematch requests using `admin_token`; optionally wait up to 30 seconds for a state change. |
| `vgc_battle_rematch` | Coordinator | Fulfill a browser rematch request and receive the next isolated player handoff. |
| `vgc_battle_cancel` | Coordinator | Cancel using `admin_token`. |
| `vgc_battle_open` | Coordinator | Reopen a persisted battle using the human token from its original URL fragment. |
| `vgc_battle_agent_view` | Isolated player | Connect and read its permitted decision packet. |
| `vgc_battle_agent_submit` | Isolated player | Lock one legal joint command with a short summary and optional plan. |

Start input:

```json
{
  "user_team": "<six-Pokémon Showdown export or https://pokepast.es/...>",
  "agent_team": "<six-Pokémon Showdown export or https://pokepast.es/...>",
  "team_sheet": "open_sheet",
  "regulation": "M-C",
  "user_timer": true,
  "agent_timer": false,
  "reasoning_effort": "medium"
}
```

Every set must specify an ability, nature and four moves. Items may be absent. Champions investments use Showdown's `EVs:` export field with Champions limits; Showdown validates them along with species, moves, abilities, items and clauses. Never pass a Scarlet/Violet EV spread as a Champions spread.

## Isolated agent setup

Give the player only `agent.prompt` and its own credential. Its fresh session must not inherit the coordinator conversation, either supplied paste, the human URL or administrator token. It learns its own complete team through its first view. Configure its MCP subprocess with:

```text
VGC_BATTLE_AGENT_TOKEN=<agent.token>
VGC_HELPER_DATABASE=<same absolute SQLite path as coordinator>
```

Do not also set `VGC_PLAYER_TOKEN`, which is the separate agent-versus-agent reasoning-player mode. A `VGC_BATTLE_AGENT_TOKEN` connection advertises only `vgc_battle_agent_view` and `vgc_battle_agent_submit`; other credentials are rejected. Apply the host isolation setup in [reasoning-players.md](reasoning-players.md), replacing its player variable and tool allowlist with these names. For a host with subagents, use a fresh context, not a fork of the coordinator's history. Remove filesystem/shell/process access except a restricted bridge if the host requires it. The MCP capability boundary is not an OS sandbox.

The existing bridge supports this mode:

```powershell
'{"tool":"vgc_battle_agent_view","arguments":{}}' |
  node scripts/reasoning-player.mjs --human-battle --token-file '<agent-only-token-file>' --database '<shared.sqlite>'
```

Keep the token file outside the player's general workspace and restrict access. The bridge receives only the agent token and refuses coordinator/human operations. The two tools can also be attached directly using the example [MCP configuration](../examples/reasoning/human-player.mcp.json.example).

The agent calls view, waits in `lobby`/`waiting` with polling backoff, and selects commands in `decision` until `completed`/`cancelled`. It considers coordinated moves, targets, priority, protection, switching, speed/field control, resource use and later turns. Each decision packet includes its exact request, legal command menu, permitted sheet, observed protocol and pinned Champions move descriptions. It chooses using its own judgment; competitive strength is not guaranteed. Scenario-evaluation tools are not exposed on the human-battle player connection.

### Model and thinking level

VGCHelper saves the requested reasoning effort, defaults it to `medium`, and returns it as `agent.reasoningEffort`. The coordinator must explicitly apply that effort when launching the player. For Codex subagents, `agent.codexSpawn` supplies `fork_turns: "none"` and `reasoning_effort: "medium"` (or the requested override). For other hosts, use their equivalent launch setting. The prompt alone does not set a model's reasoning effort.

The model remains host-selected: no model name is hardcoded. Leave it at the host default unless the user requests a specific model, and retain that choice for rematches. Global Codex settings are not modified. Stored settings record the requested effort, not an independently verified runtime/model identity.

Submission on a bound connection:

```json
{
  "decision_id": "<decisionId from view>",
  "command": "move 2 1 mega, move 2",
  "summary": "Use coordinated pressure and speed control.",
  "plan": "Reassess after the opponent's actions are revealed."
}
```

Commands must come from the current `legalCommands`. Both sides lock their selections before resolution. Exact retries are idempotent; stale or different repeat commands are rejected. Some hidden trapping or disabling effects are only discovered when Showdown checks a submitted choice. An `accepted:false` response preserves that updated request; fetch the view and repair the choice within the remaining user time. Agent summaries and plans remain private.

## Browser flow

1. Wait for the agent to connect and press **Begin team preview**. The timer starts only once both are ready.
2. Select four Pokémon in order: two leads, then two reserves. Confirm the team.
3. Choose each active Pokémon's move/target or switch. Use the separate **Mega Evolve** toggle before choosing that Pokémon's move; target buttons stay the same size and count. The toggle applies to the selected move, and choosing a switch does not spend Mega Evolution. Confirm both actions together.
4. Select forced replacements when requested. Refreshing the page retains the match and committed actions; incomplete button selections can be re-entered.
5. Inspect team sheets, field conditions and the battle log. **Download replay (.html)** saves a Showdown replay by default; **Text log (.log)** saves plain protocol instead. HTML playback loads Showdown's player/assets over the internet and includes an offline raw log. In-progress downloads are labeled partial. Both formats contain only your player perspective. Forfeit ends the game immediately.
6. After a completed game, choose **Rematch · keep memory** or **Rematch · fresh agent**. The conversation coordinator prepares the next player; the page returns to a lobby for **Begin team preview**. Teams, sheet mode, timer settings and requested thinking level carry forward. Each game has fresh battle state, RNG, resources and clocks.

Opponent HP is labeled with `%` on the battlefield and in the readable log; your HP remains exact. Side conditions such as Tailwind appear beside the affected team, while weather, terrain and room effects use the shared ribbon. Counters use `Condition (remaining/max turns)`, decrement after each completed round, and survive refresh by reconstructing the permitted protocol. Hidden duration-extending items produce a range, such as `Light Screen (4–7/5–8 turns)`; conditions without turn expiry use `∞/∞`. The counter never reads private referee state.

Vertical roster bars show all six Pokémon on each side. Revealed living Pokémon keep colored icons and HP bars; fainted Pokémon are gray and marked `×`. Unconfirmed opponent selections stay faded with `?` and an unknown-HP bar. Your own unselected Pokémon are marked `–`; selected reserves show their exact current HP. Hover or focus a roster entry for its status and HP. Benched opponent HP is the last publicly observed value. Failed moves are explicitly labeled in the feed, separately from successful Protect and attacks blocked by protection.

Both download buttons use `<ShowdownFormatName>-sim-yyyy-mm-dd-hh-mm-ss.html` or `.log`, timestamped on the local host at download time (24-hour clock). The prefix comes from the battle's Showdown format name with spaces and punctuation removed, preserving capitalization: `[Gen 9 Champions] VGC 2026 Reg M-C` becomes `Gen9ChampionsVGC2026RegMC`. The underlying Showdown protocol stays unchanged for replay compatibility.

Terrain and weather messages identify the triggering Pokémon, side and ability when Showdown supplies them, preserving protocol order. Recurring weather messages say it continues rather than implying another activation. Missing roster sprites leave their icon space empty while names and HP bars retain their positions.

### Rematch supervision and memory

Keep the conversation coordinator supervising after the game ends: call `vgc_battle_get` with its last `stateId` as `after_state` and `wait_ms: 30000`. When `rematch` appears, call `vgc_battle_rematch` with the administrator token and `rematch.id`. Fulfillment returns a new player credential and context policy. Repeating that request ID is safe and returns the same handoff without resetting the game again.

- **Keep memory:** resume the isolated player with the new credential, or launch an isolated player that uses `priorBattles` from its view. That history contains only its permitted observations and submitted summaries/plans from previous games. It can learn revealed moves/items and opponent habits, but never receives the human's private team data or exact-health channel through this history.
- **Fresh agent:** end the previous player and launch a new isolated context using only the returned handoff. Do not fork or forward its earlier conversation. Its `memory` and `priorBattles` start empty. Later keep-memory rematches remember only games since this fresh start.

Both modes revoke the previous agent credential. Restart/rebind a token-bound MCP connection or bridge with the new credential. The human URL stays the same. The browser requests a rematch; the conversation host performs the model launch, so it must remain available to process the handoff. While waiting in the lobby, no clocks run. Download the finished game's replay before starting a rematch; the download buttons then refer to the new game.

The local page uses its human capability from the URL fragment, clears that fragment, and keeps the token in tab session storage. HTTP requests use an authorization header. The listener binds only to `127.0.0.1`; host/origin checks and a restrictive content security policy protect the local endpoints. The browser transport has no agent/admin endpoint. Tokens are stored as hashes in SQLite; full engine state and teams are private referee data on disk.

## Information rules

| Information | Open sheet | Closed sheet |
|---|---|---|
| Opponent's initial six species | Visible | Visible |
| Moves, item, ability, nature | Visible | Hidden until public battle evidence reveals them |
| Stats, investments, IVs | Hidden | Hidden |
| Selected four, leads, reserve order | Hidden until revealed | Hidden until revealed |
| Pending opponent command/plan | Hidden | Hidden |

Both players receive a filtered Showdown channel. Original six-member rosters are preserved separately from Showdown checkpoints so restoring a battle cannot expose the opponent's selected four. Public damage, moves and abilities can legitimately support inferences during the game; the referee does not provide actual hidden stats.

## Timers

The [official M-C rules](https://news.pokemon-home.com/en/page/816.html) specify 90-second preview, 45-second selections, a 7-minute player bank and a 20-minute total. The server enforces these clocks; the browser only displays them.

- Preview does not consume the seven-minute player bank or total battle time.
- Each enabled player's selection and bank clocks run only while that player owes a choice. Selection expiry invokes Showdown's default selection. Player-bank expiry loses immediately, even if the opponent has not committed; simultaneous empty banks tie.
- **Training adaptation:** by default the human is timed and agent thinking has no deadline. Disable `user_timer` for unlimited human thinking or enable `agent_timer` to apply the same preview, selection and bank limits to the agent. Disabled players are never auto-selected or forfeited by a clock.
- Shared battle time runs while at least one enabled player owes a choice, counting simultaneous time once. It pauses while only untimed players think. With both timers off, the shared clock is disabled too. Consequently this is not a strict 20-minute wall-clock game.
- At shared-time expiry, complete the pending simultaneous decision, then use the pinned Showdown tiebreak. An untimed player still gets unlimited time to finish that decision.
- Background tabs and browser disconnections do not pause enabled clocks. Persisted elapsed time is settled on reconnection if the host process was stopped; charging stops at each player's deadline, rather than consuming extra bank time after an auto-selection. A new decision starts at resolution, without retroactive charges.

Showdown's server timer adds a latency allowance and is not used for the user clock. Battle mechanics, legality, automatic choices, RNG, forced replacements and tiebreak resolution come from Showdown itself.

## Version and verification

Human battles and agent simulations share the `pokemon-showdown` dependency pinned to `b1156ff19204e48089e2384eb2c9c1a8004f57ce` and `gen9championsvgc2026regmc`. Analysis uses the M-C profile and updated Champions calculator. Historical M-B checkpoints cannot be restored with this engine. The latest alias is valid only during the verified M-C regulation window; outside it, explicitly request M-C until a new supported profile is added.

`vgc_battle_rules` reads the local pinned Showdown format and resolved team rules. It reports the verified date window, source reference, supported aliases, launch requirements and timer adaptations. An expired `latest` request returns `selection.available: false` with guidance; explicit M-C remains available for practice. Unsupported formats are reported locally and rejected before fetching team links. This is a catalog of the installed simulator's supported rules, not a live rules-update service. PokePaste links still require network access to retrieve the supplied teams; pasted team text does not.

Regression coverage includes full engine games, M-C legality, sheet privacy under private-team changes, original-roster preservation after bring-four, simultaneous commit, credential isolation across SQLite connections, clock deadlines, delayed-agent behavior, timeout auto-selection, forfeits, Mega Evolution, persistence, browser origins and the restricted MCP catalog. The UI is a local Showdown-style battlefield and command interface; it does not bundle Showdown's full animated client.
