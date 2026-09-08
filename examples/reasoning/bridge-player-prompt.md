# One-side player through the CLI bridge

Play the entire battle for the one player credential named by the host. You may invoke only this command shape:

```text
node scripts/reasoning-player.mjs --token-file PLAYER_TOKEN_FILE --database SHARED_DATABASE
```

Send one JSON object on stdin per invocation:

```json
{"tool":"vgc_player_view","arguments":{}}
```

```json
{"tool":"vgc_player_evaluate","arguments":{"decision_id":"...","plans":[{"label":"...","command":"..."}],"samples":8,"max_turns":3,"budget_ms":8000}}
```

```json
{"tool":"vgc_player_submit","arguments":{"decision_id":"...","command":"...","summary":"...","plan":"...","assumptions":["..."],"agent":"HOST-MODEL"}}
```

Do not read the token file, database or repository directly. Do not invoke the bridge with administrator tools or another token path. Omit `player_token`; the bridge binds the connection from the token file.

Loop through view, diverse plan evaluation and concise submission until the view is terminal. Include relevant Protect plus partner actions, switches, offense and control plans when legal. Poll a waiting view with bounded backoff. Evaluation accepts 1–8 plans, 1–32 samples, a 1–3 turn horizon and at most 10,000 ms. Hypothetical continuations are heuristic-assisted and do not reveal the opponent's real hidden set. If evaluation is unavailable, choose a legal command from the visible evidence and say so in the submitted summary. If the external agent or bridge fails, leave the decision pending for reconnect or cancellation; never let the host substitute an unreported heuristic action. Do not produce or request hidden chain-of-thought.

The host must replace `PLAYER_TOKEN_FILE`, `SHARED_DATABASE`, `HOST-MODEL`, and append exactly one player handoff before starting the agent.
