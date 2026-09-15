import {describe, expect, it} from 'vitest';

import {evaluateTeam, generateLeadPairs} from '../src/analysis/matchup/evaluator.js';
import {analyzeReplay} from '../src/analysis/replay/analyzer.js';
import type {MetaTeam} from '../src/domain/contracts.js';
import {buildOpponentHypotheses} from '../src/meta/inference/hypotheses.js';
import {ingestReplay} from '../src/replay/index.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import {
  parsePartialShowdownTeam,
  parseShowdownTeam,
} from '../src/teams/parser.js';

const TEAM = `Garchomp @ Life Orb
Ability: Rough Skin
EVs: 20 Atk / 20 Spe
Jolly Nature
- Earthquake
- Dragon Claw
- Rock Slide
- Protect

Whimsicott @ Focus Sash
Ability: Prankster
EVs: 20 SpA / 20 Spe
Timid Nature
- Moonblast
- Tailwind
- Encore
- Protect

Kingambit @ Black Glasses
Ability: Defiant
EVs: 20 HP / 20 Atk
Adamant Nature
- Kowtow Cleave
- Sucker Punch
- Low Kick
- Protect

Sneasler @ White Herb
Ability: Unburden
EVs: 20 Atk / 20 Spe
Jolly Nature
- Close Combat
- Dire Claw
- Fake Out
- Protect

Basculegion @ Mystic Water
Ability: Adaptability
EVs: 20 Atk / 20 Spe
Adamant Nature
- Wave Crash
- Aqua Jet
- Last Respects
- Protect

Dragonite @ Dragoninite
Ability: Inner Focus
EVs: 20 HP / 20 Atk
Adamant Nature
- Extreme Speed
- Dragon Claw
- Stomping Tantrum
- Protect`;

const LOG = `|player|p1|Alice|
|player|p2|Bob|
|gametype|doubles
|tier|[Gen 9 Champions] VGC 2026 Reg M-C
|switch|p1a: Chomp|Garchomp|100/100
|switch|p1b: Cotton|Whimsicott|100/100
|switch|p2a: Gambit|Kingambit|100/100
|switch|p2b: Sneasler|Sneasler|100/100
|turn|1
|move|p1b: Cotton|Tailwind|p1b: Cotton
|-sidestart|p1: Alice|move: Tailwind
|move|p2b: Sneasler|Dire Claw|p1a: Chomp
|-damage|p1a: Chomp|0 fnt
|faint|p1a: Chomp
|win|Bob`;

describe('analysis services', () => {
  const profile = loadRegulationProfile();
  const userTeam = parseShowdownTeam(TEAM, profile);
  const meta: MetaTeam = {
    id: 'meta-1',
    regulationId: profile.id,
    name: 'Mirror',
    pokemon: userTeam.pokemon,
    roster: userTeam.pokemon.map((set) => set.species),
    exactSets: true,
    source: {
      provider: 'test',
      retrievedAt: '2026-09-03T00:00:00.000Z',
      sourceVersion: '1',
    },
  };

  it('generates exactly 15 unique leads', () => {
    expect(generateLeadPairs(userTeam)).toHaveLength(15);
  });

  it('builds the complete lead matrix for one meta team', () => {
    const result = evaluateTeam(userTeam, [meta], [], {
      ...profile,
      evaluation: {...profile.evaluation, maxMetaTeams: 1},
    });
    expect(result.matchups).toHaveLength(400);
    expect(result.evaluation.matchupCount).toBe(400);
    expect(result.evaluation.bestLeads).toHaveLength(3);
  });

  it('removes preempted damage while allowing slower priority attacks', () => {
    const banette = parsePartialShowdownTeam(
      `Banette @ Banettite
Ability: Frisk
EVs: 32 HP / 2 Atk / 32 SpD
Adamant Nature
- Poltergeist`,
      profile,
    ).pokemon[0]!;
    const floette = parsePartialShowdownTeam(
      `Floette-Eternal @ Floettite
Ability: Flower Veil
EVs: 2 HP / 32 SpA / 32 Spe
Modest Nature
- Dazzling Gleam`,
      profile,
    ).pokemon[0]!;
    const basculegion = parsePartialShowdownTeam(
      `Basculegion @ Life Orb
Ability: Adaptability
EVs: 28 Atk / 13 Def / 25 Spe
Adamant Nature
- Wave Crash
- Last Respects`,
      profile,
    ).pokemon[0]!;
    const slowTeam = parseShowdownTeam(TEAM, profile);
    slowTeam.pokemon[0] = banette;
    slowTeam.pokemon[1] = {...slowTeam.pokemon[1]!, moves: ['Protect']};
    const opponentPokemon = parseShowdownTeam(TEAM, profile).pokemon;
    opponentPokemon[0] = floette;
    opponentPokemon[4] = basculegion;
    const speedMeta: MetaTeam = {
      ...meta,
      id: 'speed-meta',
      name: 'Speed check',
      pokemon: opponentPokemon,
      roster: opponentPokemon.map((set) => set.species),
    };

    const result = evaluateTeam(slowTeam, [speedMeta], [], {
      ...profile,
      evaluation: {...profile.evaluation, maxMetaTeams: 1},
    });
    const speedMatchup = result.matchups.find(
      (entry) =>
        entry.userLead.first === 'Banette' &&
        entry.userLead.second === 'Whimsicott' &&
        entry.opponentLead.first === 'Floette-Eternal' &&
        entry.opponentLead.second === 'Basculegion',
    );

    expect(speedMatchup).toBeDefined();
    expect(speedMatchup!.features.rawOutgoingPressure).toBeGreaterThan(0);
    expect(speedMatchup!.features.outgoingPressure).toBe(0);
    expect(speedMatchup!.features.outgoingPreemptionRisk).toBe(100);

    const priorityTeam = {
      ...slowTeam,
      pokemon: slowTeam.pokemon.map((set) =>
        set.species === 'Banette' ? {...set, moves: ['Shadow Sneak']} : set,
      ),
    };
    const priorityResult = evaluateTeam(priorityTeam, [speedMeta], [], {
      ...profile,
      evaluation: {...profile.evaluation, maxMetaTeams: 1},
    });
    const priorityMatchup = priorityResult.matchups.find(
      (entry) =>
        entry.userLead.first === 'Banette' &&
        entry.userLead.second === 'Whimsicott' &&
        entry.opponentLead.first === 'Floette-Eternal' &&
        entry.opponentLead.second === 'Basculegion',
    );

    expect(priorityMatchup).toBeDefined();
    expect(priorityMatchup!.features.outgoingPressure).toBeGreaterThan(0);
    expect(priorityMatchup!.features.outgoingPressure).toBe(
      priorityMatchup!.features.rawOutgoingPressure,
    );
    expect(priorityMatchup!.features.outgoingPreemptionRisk).toBe(0);
  });

  it('produces turn-cited replay findings and Protect alternatives', () => {
    const replay = ingestReplay({content: LOG}, profile);
    const result = analyzeReplay(replay, userTeam, [meta], profile, 'Alice');
    expect(result.playerSide).toBe('p1');
    expect(result.result).toBe('loss');
    expect(result.findings.some((finding) => finding.turn === 1)).toBe(true);
    expect(
      result.findings.some((finding) =>
        finding.alternatives.some((alternative) =>
          alternative.action.includes('Protect'),
        ),
      ),
    ).toBe(true);
  });

  it('does not claim certainty for an unrevealed sampled opponent set', () => {
    const hypotheses = buildOpponentHypotheses(
      {
        side: 'p2',
        slot: 'p2a',
        nickname: 'Chomp',
        species: 'Garchomp',
        active: true,
        fainted: false,
        boosts: {},
        moves: [],
      },
      [meta],
    );
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]?.confidence).toBeLessThan(0.7);
  });
});
