# External reasoning players

VGC Helper can let two independent Codex or GitHub Copilot agents play a battle through local MCP. The helper owns the Showdown engine, private player views, simultaneous action commit, persistence and bounded plan evaluation. Each external agent owns one player's strategic choices.

This mode does not call a model API, require an OpenAI API key or depend on MCP reverse sampling. The host coordinator starts the match, launches two fresh agent sessions and gives each session one player credential. The server cannot portably create or control Codex or Copilot sessions on the host's behalf.

## Security model

Treat the three capabilities returned by `vgc_reasoning_battle_start` as credentials:

- Keep `adminToken` in the coordinator. It authorizes `vgc_reasoning_battle_get` and `vgc_reasoning_battle_cancel`.
- Give the p1 agent only the p1 player token and the p2 agent only the p2 player token.
- Start each player in a fresh session that has no coordinator transcript, opposing team export, other player handoff or administrator credential.
- Configure only `vgc_player_view`, `vgc_player_evaluate` and `vgc_player_submit` on the player's MCP server. Set `VGC_PLAYER_TOKEN` for that server process. Calls on a bound connection may omit `player_token`; an explicit different token is rejected.

The player-only MCP surface prevents that connection from calling administrator or analyst tools. It is not an operating-system sandbox. A host that also grants shell, filesystem, process inspection or broad network tools may let the agent discover data outside MCP. Use a separate OS account, container, VM or equivalent file/process isolation when the opposing export or credentials must be protected against those host tools.

Use separate MCP connections for p1 and p2 even when both run on one computer. Point the coordinator and both players at the same SQLite file through `VGC_HELPER_DATABASE`. Keep token files outside either player's readable workspace, restrict their file permissions, and do not place tokens in transcripts, repository files or command-line arguments when environment injection is available. The returned handoff includes that side's token. On a token-bound connection, redact its credential line before appending the handoff to the generic prompt; the server process already receives the token through `VGC_PLAYER_TOKEN`.

## Start and supervise a match

On a coordinator connection with the full VGC Helper tool set, call:

```json
{
  "p1": {"team_export": "..."},
  "p2": {"preview": ["... six species ..."]},
  "seed": "external-agents-1",
  "max_turns": 80,
  "budget_ms": 600000
}
```

Pass that object to `vgc_reasoning_battle_start`. Either side can use `team_export` or the supported `preview`/`known` form. Save the returned match ID, administrator token and two handoffs immediately. The default match deadline is 15 minutes and the maximum accepted budget is one hour. Player capabilities are persistent credentials; if a player process disconnects, restart it with the same token and database and call `vgc_player_view` to resume the stored decision boundary. Build the current checkout before launch because the native MCP examples execute `dist/index.js`.

Launch both player sessions concurrently. Do not paste both handoffs into one conversation or fork a coordinator conversation that already contains both teams. The generic prompt in [player-agent.md](../examples/reasoning/player-agent.md) is designed to follow one side-specific handoff.

While the players run, the coordinator can inspect public match progress with:

```json
{"admin_token":"..."}
```

Use `vgc_reasoning_battle_get` for status and `vgc_reasoning_battle_cancel` when the match has exceeded its host deadline or should stop. No move is chosen silently when an agent times out or fails. Restart the player at its stored boundary or cancel the match; do not describe a heuristic fallback as external-agent play.

To start at a stored position, call `vgc_reasoning_battle_continue` on the coordinator connection with exactly one source:

```json
{"job_id":"...","trace_index":0,"turn":3,"max_turns":40,"budget_ms":600000}
```

A saved simulation `job_id` resumes its pinned checkpoint. An `analysis_id` instead reconstructs a supported public replay prefix and samples a possible opposing team consistent with that prefix; it does not recover the original hidden team. The call returns the same independent administrator and player capabilities as a new match. Keep the same launch and isolation rules.

## Player loop

Every player repeats the same bounded loop until its view is terminal:

1. Call `vgc_player_view`. On a token-bound MCP connection, use `{}`. Read the decision ID, public history, exact own request, legal joint commands, prior decision summaries and uncertainty warnings.
2. If the view is waiting for the opponent, poll with backoff rather than issuing another submission. A practical local sequence is 0.5, 1, 2 and then 5 seconds, capped by the match deadline.
3. At a decision, form a small diverse set of complete legal joint plans. Include an offensive line, relevant Protect plus partner-action lines, deliberate switches, speed or field control, and forced replacement choices when they apply. A command must match one of the current legal commands.
4. When useful, call `vgc_player_evaluate` with the current `decision_id` and the proposed `{label, command}` plans. The accepted bounds are 1–8 plans, 1–32 samples, a 1–3 turn horizon and a 1–10,000 ms evaluation budget. A player can make at most three evaluation calls per decision and 240 per match. Keep them within the remaining match deadline. Evaluations use actor-visible beliefs and paired sampled worlds. Their continuations are heuristic-assisted planning, and their horizon values are not battle win probabilities or evidence of competitive strength.
5. Choose a legal command, then call `vgc_player_submit` with the same decision ID, the command, a concise evidence-based summary, an optional contingent plan and explicit assumptions. Set `agent` to a short host/model label. If evaluation is unavailable or fails, the player may choose from the visible legal commands itself and must say that evaluation was unavailable in the summary. Do not let the host or server silently insert a heuristic action, and do not submit hidden chain-of-thought.
6. Return to `vgc_player_view`. The server locks both players' commands at the same boundary and resolves them together. A stale decision error means the battle advanced; discard the old proposal and fetch the new view.

Player tool inputs reject unknown keys. The private memory field is named `plan`; fields such as `private_plan` or `contingent_plan` are errors. Evaluation inputs use `plans: [{"label":"...","command":"..."}]`. A public replay may not reveal the player's selected reserves, so a reconstructed continuation can use a hypothetical reserve selection; inspect its reconstruction warnings.

A useful summary says what the action protects or threatens and cites the evaluation result that changed the choice. Keep it short enough to serve as future player memory. For example: `Tailwind + Protect preserved both attackers in 7/8 sampled turn resolutions; next turn target the slower slot unless Trick Room is revealed.` Assumptions should identify uncertainty such as an unrevealed Choice Scarf, not invent it as fact.

## Codex host

Codex CLI, the Codex IDE extension and the ChatGPT desktop app support local stdio MCP servers. Codex configuration supports server environment variables, a per-server `enabled_tools` allowlist, required startup and tool timeouts. `codex exec` starts a fresh noninteractive task, accepts a prompt on stdin and supports `--ephemeral` so the rollout is not persisted. See the official [Codex MCP guide](https://developers.openai.com/codex/mcp/), [configuration reference](https://developers.openai.com/codex/config-reference/) and [CLI reference](https://developers.openai.com/codex/cli/reference/).

Copy [codex-player.config.toml.example](../examples/reasoning/codex-player.config.toml.example) into a clean, player-specific Codex configuration directory and replace its absolute paths. Set `VGC_PLAYER_TOKEN` separately for each process and set `VGC_HELPER_DATABASE` to the coordinator's exact SQLite path. Check `codex login status` for that clean Codex home and use the normal `codex login` flow if needed; Codex CLI authentication is separate from whether the desktop app is signed in. This workflow can use ChatGPT-account authentication and does not require an API key.

Start each side from an empty player workspace, not the repository or coordinator task. Replace `<absolute-path-to-VGCHelper>` with your checkout location:

```powershell
$env:CODEX_HOME = 'C:\isolated\codex-p1'
$env:VGC_PLAYER_TOKEN = (Get-Content -Raw 'C:\secure\p1.token').Trim()
$env:VGC_HELPER_DATABASE = 'D:\vgc-match-data\vgc-helper.sqlite'
$vgcRoot = '<absolute-path-to-VGCHelper>'
$prompt = (Get-Content -Raw (Join-Path $vgcRoot 'examples\reasoning\player-agent.md')) +
  "`n`n" + (Get-Content -Raw 'C:\secure\p1-handoff-redacted.md')
$prompt |
  codex exec --ephemeral --sandbox read-only --skip-git-repo-check -C 'C:\isolated\player-p1' -
```

Run p2 in another process with a different `CODEX_HOME`, workspace and token. The MCP allowlist limits tools from the VGC Helper server. Codex may still provide built-in host tools, and a user's base configuration may contain other MCP servers. A clean Codex home and OS sandbox are therefore part of strong isolation. Desktop and IDE clients share the host's MCP configuration but require their documented restart/reload step after configuration changes; `codex exec` is the reproducible choice for newly launched players.

## GitHub Copilot host

GitHub Copilot CLI supports local stdio MCP, per-server tool lists, session-only `--additional-mcp-config`, fresh programmatic runs with `-p`, and model-visible tool restriction through `--available-tools`. Exact `--allow-tool` entries can approve only the player operations. See GitHub's official [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), [MCP setup guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) and [tool restriction guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools).

Copy [copilot-player.mcp.json.example](../examples/reasoning/copilot-player.mcp.json.example), replace its absolute paths, and launch one fresh process per side. This PowerShell shape uses a session-only MCP definition, disables built-in MCP servers and removes built-in tools from the model-visible set:

```powershell
$env:VGC_PLAYER_TOKEN = (Get-Content -Raw 'C:\secure\p1.token').Trim()
$env:VGC_HELPER_DATABASE = 'D:\vgc-match-data\vgc-helper.sqlite'
$vgcRoot = '<absolute-path-to-VGCHelper>'
$prompt = (Get-Content -Raw (Join-Path $vgcRoot 'examples\reasoning\player-agent.md')) +
  "`n`n" + (Get-Content -Raw 'C:\secure\p1-handoff-redacted.md')
copilot -p $prompt -C 'C:\isolated\player-p1' `
  --disable-builtin-mcps `
  --additional-mcp-config '@D:\isolated\p1-mcp.json' `
  --no-custom-instructions `
  --no-ask-user `
  --no-remote `
  --no-remote-export `
  --available-tools='vgc-player(vgc_player_view),vgc-player(vgc_player_evaluate),vgc-player(vgc_player_submit)' `
  --allow-tool='vgc-player(vgc_player_view),vgc-player(vgc_player_evaluate),vgc-player(vgc_player_submit)'
```

Do not use `--allow-all` for this workflow. Do not mark `VGC_PLAYER_TOKEN` with `--secret-env-vars`: that option also strips named variables from MCP server environments, so the bound server would not receive its credential. The explicit available-tool list removes shell access that could inspect the process environment. In prompt mode, persistent memory is disabled unless explicitly enabled; leave it disabled so the server's side-scoped summaries are the only carried battle memory. Copilot CLI and VS Code use different MCP configuration file shapes, and `.vscode/mcp.json` is not read by Copilot CLI. The example here targets Copilot CLI because its fresh process, session-only config and exact tool filters are suitable for repeatable two-player launches. Organization policy can still disable MCP or models.

## Bridge fallback for an existing agent

Some already-open hosts cannot replace the model's tool catalog during a session. Use `scripts/reasoning-player.mjs` as a one-call bridge in that case. It reads one JSON request from stdin, reads only the player credential from `--token-file`, starts a token-bound stdio MCP process against `--database`, invokes one player tool and prints the JSON result.

```powershell
'{"tool":"vgc_player_view","arguments":{}}' |
  node scripts/reasoning-player.mjs --token-file 'C:\secure\p1.token' --database 'D:\vgc-match-data\vgc-helper.sqlite'
```

The allowed `tool` values are only `vgc_player_view`, `vgc_player_evaluate` and `vgc_player_submit`. Use [bridge-player-prompt.md](../examples/reasoning/bridge-player-prompt.md) when the host must operate through that command. Restrict its shell permission to this bridge invocation where the host supports command allowlists. The bridge does not turn a general shell into an OS sandbox, and it cannot perform administrator operations.

## Completion and replay export

After both agents report a terminal view, call `vgc_reasoning_battle_get` with the administrator capability and verify the match is terminal. Select either `result.battleLogs.p1` or `result.battleLogs.p2` and pass that one perspective's log to the existing coordinator export tool:

```json
{
  "battle_log": {"lines": ["..."], "status": "complete", "ended": true},
  "title": "External reasoning battle"
}
```

Pass that object to `vgc_replay_export_html`. The export contains only the player-channel log supplied to it. Preserve both agent labels, concise summaries, evaluation budgets, match seed and final artifact path in the experiment record. One completed game demonstrates orchestration and information boundaries; it does not establish human-level or tournament-level play.
