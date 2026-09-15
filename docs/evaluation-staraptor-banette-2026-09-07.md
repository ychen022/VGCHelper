# Staraptor / Banette team evaluation — September 7, 2026

> Historical M-B evidence. These results and pinned sources predate the M-C default and do not validate M-C outcomes. Reproducing them requires the original code/dependency revisions; current scripts target M-C.

These historical results predate the pre-publication fixes to damage-evidence HP handling and replay opening-sheet validation. The experiment has not been rerun on the corrected implementation.

The supplied team passed the pinned Champions M-B legality check. Across **384 completed simulated games**, it won **140 (36.5%)**. Within this model, MB778 was the hardest opponent, MB763 was intermediate, and MB684 was the closest matchup. These results describe the current automated policies; they are not calibrated predictions of your tournament win rate.

## Matchup results

Your team used the tactical policy throughout. Each opponent was tested with both tactical and damage-focused policies, with 64 games per cell. Parentheses show conditional 95% Monte Carlo sampling intervals; these do not include uncertainty about policy strength or hidden-set priors.

| Opponent from the same saved Featured Teams snapshot | Tactical opponent | Damage-focused opponent |
|---|---:|---:|
| MB778 — whairing, WCS Open champion; Staraptor / Torkoal / Glimmora / Sneasler / Whimsicott / Farigiraf | **25.0%**, 16/64 (16.0–36.8%) | **26.6%**, 17/64 (17.3–38.5%) |
| MB763 — unskilled99_, Talon's Fight Club champion; Aerodactyl / Charizard / Incineroar / Farigiraf / Sylveon / Garchomp | **34.4%**, 22/64 (23.9–46.6%) | **40.6%**, 26/64 (29.5–52.9%) |
| MB684 — maGicaUra, Ranked Season M-4 first place; Floette / Garchomp / Incineroar / Sneasler / Sinistcha / Kingambit | **48.4%**, 31/64 (36.6–60.4%) | **43.8%**, 28/64 (32.3–55.9%) |

All games reached a terminal result: 140 wins, 244 losses, zero draws, zero invalid games and zero turn-capped games. Differences between the two opponent policies are small relative to sampling uncertainty. The aggregate gives every opponent/profile equal weight; it is not weighted by metagame usage.

## What the matchup checks show

The observations below come from calculations and the published sets, rather than a claim that a particular cause explains every simulated loss. Damage is conditional on a hit, without Protect, critical hits or unlisted modifiers. Spread attacks include the doubles spread reduction. Attacks are at neutral stat stages unless specified; holding a Mega Stone selects that Mega form for these isolated calculations.

**MB778: speed mirrors and Farigiraf are concrete obstacles.** Your Mega Staraptor reaches 170 Speed against their 173; your Sneasler reaches 170 against their 172. With equal speed-control conditions, you lose both mirrors. Both Torkoal reach 36, so Trick Room alone does not resolve that mirror.

Farigiraf's Armor Tail blocks Bullet Punch and Mega Banette's Prankster Encore aimed at its side. Banette's Poltergeist also does zero damage to Farigiraf because of its Normal typing. This does not shut down Banette's entire set: self-targeted Destiny Bond and field-targeted Trick Room are not blocked by Armor Tail. Prankster raises Trick Room from −7 to −6 priority; it still acts after ordinary attacks. These interactions follow the pinned Showdown [ability implementation](https://raw.githubusercontent.com/smogon/pokemon-showdown/6b4bc34e44cc2541929cc4b8fff96e756ab3f268/data/abilities.ts) and local move definitions.

Your direct pressure into MB778 Farigiraf includes Sneasler's Throat Chop (**66.1–79.0%**) and Scizor's Knock Off while Sitrus is held (**61.6–73.2%**). Neither independently guarantees a full-health KO. Full-health Torkoal's Eruption in sun does **62.9–74.1%**, falling to **30.8–36.6%** at half health. Removing Farigiraf and preserving Torkoal's HP are therefore useful planning priorities; simply setting Trick Room is not a complete answer to this opponent.

**MB763: Rock Slide threatens Charizard, but Intimidate changes the calculation.** Sneasler's Rock Slide does **96.7–113.7%** to this bulky Mega Charizard Y: a 68.75% damage-roll KO chance conditional on hitting at neutral Attack. After one Intimidate, that falls to **62.3–76.5%**. Aerodactyl's Wide Guard is another reason not to treat spread damage as freely available.

Milotic is not an immediate Charizard KO threat in sun: Scald does **20.8–26.2%**, or **43.7–52.5%** at +2 Special Attack. Its support and Competitive pressure can still matter, but those numbers argue against relying on unboosted Scald to solve this matchup. Farigiraf creates the same priority restrictions as above. Be deliberate about when Sneasler attacks and whether its Attack has been reduced.

**MB684: the team has useful damage into its major threats.** Scizor's Bullet Punch does **79.2–94.3%** to this Mega Floette, giving a strong finishing option after chip rather than a full-health OHKO. Sneasler's Close Combat does **120.8–143.0%** to Chople Berry Kingambit at neutral Attack. These are clear offensive resources, although Intimidate, protection and positioning can change whether you realize them.

Milotic's Icy Wind does **28.3–34.3%** to Mega Garchomp. Your Milotic is Speed 115 and their Mega Garchomp is 116 before modifiers, so you should not assume Milotic slows it before its first attack. Their Sneasler starts at 189 Speed, ahead of yours. This matchup had your best results in the model, but those results do not establish a favorable human matchup.

## How much confidence to place in Banette's result

The current tactical policy does not plan Destiny Bond / Encore sequences well. Destiny Bond receives the generic status-move score of 2; Encore receives 16, while Trick Room normally receives 24. These are heuristic scores, not estimated strategic values. This experiment used no lookahead search and no adopted HolidayOugi-trained policy. A practiced Banette game plan could perform differently, and the experiment does not justify concluding that Banette itself is ineffective.

The saved first-game trace against tactical MB778 brought Scizor / Sneasler with Staraptor / Torkoal in reserve and lost. Some other retained preview plans included Banette. However, only one full episode trace and a capped list of preview plans are retained, so reliable Banette bring rates or move-use frequencies across all 384 games cannot be recovered from these outputs. No optimal lead or four-Pokémon selection was established.

Hidden-set inference also remains approximate. Every matchup reported public-reveal expansion and skipped ambiguous damage/order evidence; MB763 and MB684 additionally reported states with exhausted candidate support and an explicit public-view fallback. Your unpublished six-Pokémon roster has no coherent published team in this frozen prior, unlike the original benchmark teams. These coverage differences, different seeds and different sample counts prevent a clean percentage-point comparison with the previous team's results. See the [earlier representativeness audit](simulation-stages-4-6-evaluation.md) for the policy's measured tendency toward more aggressive play than the replay sample.

## Reproduction and saved evidence

- Input: `examples/teams/staraptor-banette-2026-09-07.txt`, unchanged moves, items, natures and investments. The export's EV labels were interpreted as Champions skill points. Omitted investments are zero; IVs use the parser's 31 defaults.
- Opponents: the same frozen MB778, MB763 and MB684 published sets, with no source refresh. Published exports: [MB778](https://pokepast.es/3a653f8692294a23), [MB763](https://pokepast.es/0a36793b5d73aaad), [MB684](https://pokepast.es/48fbd9ba1a6398c5).
- Source CSV SHA256: `dff8b694c5ad4477382b9aff6175061140df25908fab75bab8ffe3e565e6586e`.
- Actual current compiled MCP tool: `vgc_simulate_cohort`; job `sim_64e33afe-30d6-48de-bf83-491f4c139438`.
- Settings: tactical player, tactical/damage opponents, 64 samples per cell, 60-turn cap, 180-second job budget, closed opponent information, seed `staraptor-banette-evaluation-v1`.
- Exact sets define the engine's battles; each policy receives its own information and public observations, with opponent hypotheses from the frozen prior. Your private exact team was not added to that prior.
- Local artifacts: `.vgc-helper/experiments/staraptor-banette-2026-09-07/` contains `configuration.json`, `result.json`, `diagnostics.json`, `trace-p1.json`, the isolated database, and `run.mjs` / `inspect.mjs` reproduction helpers. Run those helpers from the repository root after building; they overwrite their local artifact filenames.
- Speed diagnostics cross-checked every base-form calculator Speed against an actual Champions engine preview request before computing Mega-form speeds. Damage calculations used the project's pinned Champions calculator.

No team edits or policy tuning were applied to obtain these results.
