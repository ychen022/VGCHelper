import {describe, expect, it} from 'vitest';
import {calculateChampionsDamage} from '../src/calc/champions.js';
import {parsePartialShowdownTeam} from '../src/teams/parser.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
const profile = loadRegulationProfile();
const attacker = parsePartialShowdownTeam('Garchomp @ Life Orb\nAbility: Rough Skin\nEVs: 32 Atk / 32 Spe\nAdamant Nature\n- Dragon Claw', profile).pokemon[0]!;
const defender = parsePartialShowdownTeam('Incineroar @ Sitrus Berry\nAbility: Blaze\nEVs: 32 HP / 32 Def\nImpish Nature\n- Protect', profile).pokemon[0]!;
describe('state-aware damage', () => {
  it('accepts Showdown Aegislash and distinguishes attacking Blade from defensive Shield', () => {
    const sword = parsePartialShowdownTeam('Aegislash @ Leftovers\nAbility: Stance Change\nModest Nature\n- Shadow Ball', profile).pokemon[0]!;
    const shield = calculateChampionsDamage({attacker, defender:sword, move:'Earthquake'});
    const blade = calculateChampionsDamage({attacker, defender:sword, move:'Earthquake',defenderPosition:{species:'Aegislash-Blade'}});
    expect(blade.range[0]).toBeGreaterThan(shield.range[1]);
    const attack = calculateChampionsDamage({attacker:sword,defender,move:'Shadow Ball'});
    const explicit = calculateChampionsDamage({attacker:{...sword,species:'Aegislash-Blade'},defender,move:'Shadow Ball'});
    expect(attack.range).toEqual(explicit.range);
    expect(shield.assumptions.join(' ')).toContain('Shield');
  });
  it('applies attack drops, burn and removed items rather than the original export', () => {
    const base = calculateChampionsDamage({attacker, defender, move: 'Dragon Claw'});
    const lowered = calculateChampionsDamage({attacker, defender, move: 'Dragon Claw', attackerPosition: {boosts: {atk: -1}, status: 'brn', item: ''}});
    expect(lowered.range[1]).toBeLessThan(base.range[0] / 2);
    expect(lowered.inputs?.attackerPosition?.boosts?.atk).toBe(-1);
  });
  it('honors Protect and switches spread reduction off for a sole target', () => {
    expect(calculateChampionsDamage({attacker, defender, move: 'Dragon Claw', field: {isProtected: true}}).range).toEqual([0, 0]);
    const both = calculateChampionsDamage({attacker, defender, move: 'Earthquake'});
    const single = calculateChampionsDamage({attacker, defender, move: 'Earthquake', field: {singleTarget: true}});
    expect(single.range[0]).toBeGreaterThan(both.range[0]);
  });
  it('uses observed base form without automatically Mega evolving it', () => {
    const zard = parsePartialShowdownTeam('Charizard @ Charizardite Y\nAbility: Blaze\nEVs: 32 SpA / 32 Spe\nModest Nature\n- Flamethrower', profile).pokemon[0]!;
    const base = calculateChampionsDamage({attacker: zard, defender, move: 'Flamethrower', attackerPosition: {species: 'Charizard'}});
    const mega = calculateChampionsDamage({attacker: zard, defender, move: 'Flamethrower'});
    expect(base.range[1]).toBeLessThan(mega.range[1]);
  });
  it('returns total weighted damage for multi-hit moves without exponential roll expansion', () => {
    const mouse = parsePartialShowdownTeam('Maushold @ Wide Lens\nAbility: Technician\nEVs: 32 Atk / 32 Spe\nJolly Nature\n- Population Bomb', profile).pokemon[0]!;
    const result = calculateChampionsDamage({attacker:mouse,defender,move:'Population Bomb'});
    expect(Math.min(...result.damage)).toBe(result.range[0]);
    expect(Math.max(...result.damage)).toBe(result.range[1]);
    expect(result.damageDistribution?.reduce((sum,r)=>sum+r.probability,0)).toBeCloseTo(1);
    expect(result.damage.length).toBeLessThan(1000);
  });
});
