import {describe, expect, it} from 'vitest';

import {calculateChampionsDamage, pokemonSpeed} from '../src/calc/champions.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import {
  parsePartialShowdownTeam,
  parseShowdownTeam,
} from '../src/teams/parser.js';

const TEAM = `Dragonite @ Dragoninite
Ability: Inner Focus
EVs: 20 HP / 20 Atk / 10 Spe
Adamant Nature
- Extreme Speed
- Dragon Claw
- Stomping Tantrum
- Protect

Garchomp @ Life Orb
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
- Protect`;

describe('Showdown team and Champions calculator', () => {
  const profile = loadRegulationProfile();

  it('parses six complete Champions sets and maps EVs to skill points', () => {
    const team = parseShowdownTeam(TEAM, profile);
    expect(team.pokemon).toHaveLength(6);
    expect(team.pokemon[0]?.species).toBe('Dragonite');
    expect(team.pokemon[0]?.skillPoints).toMatchObject({
      hp: 20,
      atk: 20,
      spe: 10,
    });
    expect(team.pokemon[0]?.level).toBe(50);
  });

  it('runs generation-zero Champions damage calculations', () => {
    const team = parseShowdownTeam(TEAM, profile);
    const attacker = team.pokemon[1];
    const defender = team.pokemon[3];
    expect(attacker).toBeDefined();
    expect(defender).toBeDefined();

    const result = calculateChampionsDamage({
      attacker: attacker!,
      defender: defender!,
      move: 'Earthquake',
    });

    expect(result.calculatorVersion).toContain('e7fd7e5');
    expect(result.damage).toHaveLength(16);
    expect(result.range[0]).toBeGreaterThan(0);
    expect(result.percentRange[1]).toBeGreaterThan(result.percentRange[0]);
    expect(pokemonSpeed(attacker!)).toBeGreaterThan(0);
  });

  it('rejects incomplete teams by default', () => {
    expect(() =>
      parseShowdownTeam(
        `Garchomp @ Life Orb
Ability: Rough Skin
Jolly Nature
- Earthquake`,
        profile,
      ),
    ).toThrow(/Expected 6 Pokemon/);
  });

  it('uses the Mega form selected by a Champions stone', () => {
    const team = parseShowdownTeam(TEAM, profile);
    const dragonite = team.pokemon[0]!;
    const base = {...dragonite};
    delete base.item;
    expect(pokemonSpeed(dragonite)).toBeGreaterThan(pokemonSpeed(base));

    const result = calculateChampionsDamage({
      attacker: dragonite,
      defender: team.pokemon[3]!,
      move: 'Extreme Speed',
    });
    expect(result.description).toContain('Dragonite-Mega');

    const garchomp = team.pokemon[1]!;
    const wrongStone = {...garchomp, item: 'Dragoninite'};
    const noStone = {...garchomp};
    delete noStone.item;
    expect(pokemonSpeed(wrongStone)).toBe(pokemonSpeed(noStone));

    const explicitWrongAbility = {
      ...dragonite,
      species: 'Dragonite-Mega',
      ability: 'Inner Focus',
    };
    const explicitCorrectAbility = {
      ...dragonite,
      species: 'Dragonite-Mega',
      ability: 'Multiscale',
    };
    const wrongAbilityDamage = calculateChampionsDamage({
      attacker: garchomp,
      defender: explicitWrongAbility,
      move: 'Dragon Claw',
    });
    const correctAbilityDamage = calculateChampionsDamage({
      attacker: garchomp,
      defender: explicitCorrectAbility,
      move: 'Dragon Claw',
    });
    expect(wrongAbilityDamage.range).toEqual(correctAbilityDamage.range);
  });

  it('enforces Champions skill-point limits', () => {
    const set = (evs: string) => `Garchomp @ Life Orb
Ability: Rough Skin
EVs: ${evs}
Jolly Nature
- Earthquake`;
    expect(() => parsePartialShowdownTeam(set('33 Atk'), profile)).toThrow(
      /0-32 per stat/,
    );
    expect(() =>
      parsePartialShowdownTeam(set('32 HP / 32 Atk / 3 Spe'), profile),
    ).toThrow(/at most 66/);
  });

  it('rejects unknown field values instead of silently ignoring them', () => {
    const team = parseShowdownTeam(TEAM, profile);
    expect(() =>
      calculateChampionsDamage({
        attacker: team.pokemon[1]!,
        defender: team.pokemon[3]!,
        move: 'Earthquake',
        field: {weather: 'Fog'},
      }),
    ).toThrow(/Unknown weather/);
  });
});
