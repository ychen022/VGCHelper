import {describe, expect, it} from 'vitest';
import {buildOpeningScenarios} from '../src/analysis/matchup/openings.js';
import type {PokemonSet} from '../src/domain/contracts.js';

const set = (species: string, moves: string[], extra: Partial<PokemonSet> = {}): PokemonSet => ({
  species, moves, skillPoints: {hp: 32, spa: 32}, ivs: {}, level: 50, ...extra,
});

describe('conditional support opening evidence', () => {
  it('keeps held Megas in base form and uses exactly the selected Mega without changing source sets', () => {
    const user = [set('Charizard', ['Flamethrower'], {item: 'Charizardite Y', ability: 'Blaze'}),
      set('Gengar', ['Shadow Ball'], {item: 'Gengarite', ability: 'Cursed Body'})];
    const foes = [set('Dragonite', ['Dragon Claw']), set('Clefable', ['Moonblast'])];
    const held = buildOpeningScenarios(user, foes, 'source');
    expect(held[0]?.damage[0]?.inputs?.attackerPosition?.species).toBe('Charizard');
    const mega = buildOpeningScenarios(user, foes, 'source', 'Charizard', null);
    expect(mega[0]?.userMega).toBe('Charizard');
    expect(mega[0]?.opponentMega).toBeNull();
    expect(mega[0]?.damage.filter(hit => hit.inputs?.attacker.species === 'Charizard').every(hit => hit.inputs?.attackerPosition?.species === 'Charizard-Mega-Y')).toBe(true);
    expect(mega[0]?.damage.filter(hit => hit.inputs?.attacker.species === 'Gengar').every(hit => hit.inputs?.attackerPosition?.species === 'Gengar')).toBe(true);
    expect(mega[0]?.setScenario.user).toEqual(user);
    expect(user[0]?.ability).toBe('Blaze');
  });

  it('includes Helping Hand partner damage in the bounded menu', () => {
    const user = [set('Clefable', ['Protect', 'Follow Me', 'Helping Hand', 'Moonblast']), set('Charizard', ['Flamethrower'])];
    const foes = [set('Dragonite', ['Dragon Claw']), set('Clefable', ['Moonblast'])];
    const scenarios = buildOpeningScenarios(user, foes, 'source');
    const baseline = scenarios.find(row => row.userActions[0]?.move === 'Moonblast')!;
    const helped = scenarios.find(row => row.userActions[0]?.move === 'Helping Hand')!;
    expect(helped).toBeDefined();
    const plainHit = baseline.damage.find(hit => hit.inputs?.attacker.species === 'Charizard')!;
    const helpedHit = helped.damage.find(hit => hit.inputs?.attacker.species === 'Charizard')!;
    expect(helpedHit.inputs?.field?.isHelpingHand).toBe(true);
    expect(helpedHit.range[1]).toBeGreaterThan(plainHit.range[1]);
    expect(helped.support.join(' ')).toMatch(/Helping Hand.*partner.*damage/i);
    expect(scenarios.length).toBeLessThanOrEqual(216);
  });

  it('offers Haze and Destiny Bond even with competing support actions', () => {
    const user = [set('Gengar', ['Protect', 'Haze', 'Destiny Bond', 'Shadow Ball']),
      set('Clefable', ['Protect', 'Follow Me', 'Helping Hand', 'Moonblast'])];
    const scenarios = buildOpeningScenarios(user, [set('Dragonite', ['Dragon Claw']), set('Clefable', ['Moonblast'])], 'source');
    const moves = new Set(scenarios.flatMap(row => row.userActions.map(action => action.move)));
    expect(moves.has('Haze')).toBe(true);
    expect(moves.has('Destiny Bond')).toBe(true);
    expect(moves.has('Helping Hand')).toBe(true);
    const bond = scenarios.find(row => row.userActions.some(action => action.move === 'Destiny Bond'))!;
    expect(bond.support.join(' ')).toMatch(/Destiny Bond.*(?:conditional|if|requires)/i);
  });

  it('applies faster Haze to clear an ally Competitive boost before its conditional hit', () => {
    const user = [set('Gengar', ['Haze', 'Shadow Ball'], {skillPoints: {spe: 32, spa: 32}}),
      set('Milotic', ['Surf'], {ability: 'Competitive', nature: 'Quiet'})];
    const foes = [set('Incineroar', ['Flare Blitz'], {ability: 'Intimidate'}), set('Clefable', ['Moonblast'])];
    const scenarios = buildOpeningScenarios(user, foes, 'source');
    const baseline = scenarios.find(row => row.userActions[0]?.move === 'Shadow Ball')!;
    const hazed = scenarios.find(row => row.userActions[0]?.move === 'Haze')!;
    const baselineHit = baseline.damage.find(hit => hit.inputs?.attacker.species === 'Milotic')!;
    const hazeHit = hazed.damage.find(hit => hit.inputs?.attacker.species === 'Milotic')!;
    expect(baselineHit.inputs?.attackerPosition?.boosts?.spa).toBe(2);
    expect(hazeHit.inputs?.attackerPosition?.boosts?.spa ?? 0).toBe(0);
    expect(hazeHit.range[1]).toBeLessThan(baselineHit.range[1]);
    expect(hazed.support.join(' ')).toMatch(/Haze.*(?:Competitive|positive|own|ally)/i);
  });

  it('keeps boosts for hits before slower Haze and reports Trick Room negative priority', () => {
    const user = [set('Gengar', ['Haze', 'Trick Room'], {nature: 'Quiet', ivs: {spe: 0}}),
      set('Milotic', ['Surf'], {ability: 'Competitive', nature: 'Timid', skillPoints: {spa: 32, spe: 32}})];
    const foes = [set('Incineroar', ['Flare Blitz'], {ability: 'Intimidate'}), set('Clefable', ['Moonblast'])];
    const scenarios = buildOpeningScenarios(user, foes, 'source');
    const haze = scenarios.find(row => row.userActions[0]?.move === 'Haze')!;
    expect(haze.damage.find(hit => hit.inputs?.attacker.species === 'Milotic')?.inputs?.attackerPosition?.boosts?.spa).toBe(2);
    const room = scenarios.find(row => row.userActions[0]?.move === 'Trick Room')!;
    expect(room.support.join(' ')).toMatch(/Trick Room.*-7/);
  });

  it('respects Armor Tail damaging priority and identifies Prankster target immunity', () => {
    const user = [set('Whimsicott', ['Taunt', 'Moonblast'], {ability: 'Prankster'}), set('Incineroar', ['Fake Out'])];
    const foes = [set('Farigiraf', ['Psychic'], {ability: 'Armor Tail'}), set('Kingambit', ['Iron Head'])];
    const scenarios = buildOpeningScenarios(user, foes, 'source');
    const fakeHits = scenarios.flatMap(row => row.damage).filter(hit => hit.move === 'Fake Out');
    expect(fakeHits.length).toBeGreaterThan(0);
    expect(fakeHits.every(hit => hit.range[1] === 0)).toBe(true);
    const taunt = scenarios.filter(row => row.userActions.some(action => action.move === 'Taunt'));
    expect(taunt.some(row => row.support.join(' ').includes('Armor Tail'))).toBe(true);
    expect(taunt.some(row => row.limitations.join(' ').includes('Prankster'))).toBe(true);
  });

  it('reports Dark immunity for opposing Prankster status targeting', () => {
    const scenarios = buildOpeningScenarios([
      set('Whimsicott', ['Taunt', 'Moonblast'], {ability: 'Prankster'}), set('Milotic', ['Surf']),
    ], [set('Kingambit', ['Iron Head']), set('Dragonite', ['Dragon Claw'])], 'source');
    const taunt = scenarios.find(row => row.userActions.some(action => action.move === 'Taunt'))!;
    expect(taunt.support.join(' ')).toMatch(/Prankster.*fails into a Dark type/);
  });

  it('shows Surf and Earthquake ally costs as separate side-labeled conditional hits', () => {
    const scenarios = buildOpeningScenarios([
      set('Milotic', ['Surf']), set('Gengar', ['Haze', 'Protect', 'Shadow Ball'], {ability: 'Cursed Body'}),
    ], [set('Garchomp', ['Earthquake']), set('Clefable', ['Moonblast'])], 'source');
    const hazed = scenarios.find(row => row.userActions.some(action => action.move === 'Haze'))!;
    const surf = hazed.damage.filter(hit => hit.move === 'Surf');
    expect(surf).toHaveLength(3);
    const allySurf = surf.find(hit => hit.targetRelation === 'ally')!;
    expect(allySurf.inputs?.defender.species).toBe('Gengar');
    expect(allySurf.attackerSide).toBe('user');
    expect(allySurf.targetSide).toBe('user');
    expect(allySurf.range[0]).toBeGreaterThan(0);
    const allyQuake = hazed.damage.find(hit => hit.move === 'Earthquake' && hit.targetRelation === 'ally')!;
    expect(allyQuake.inputs?.defender.species).toBe('Clefable');
    expect(allyQuake.attackerSide).toBe('opponent');
    expect(allyQuake.targetSide).toBe('opponent');
    expect(hazed.support.join(' ')).toMatch(/Surf.*ally Gengar/);
    const protectedRow = scenarios.find(row => row.userActions.some(action => action.actor === 'Gengar' && action.kind === 'protect'))!;
    expect(protectedRow.damage.some(hit => hit.move === 'Surf' && hit.targetRelation === 'ally' && hit.range[1] > 0)).toBe(false);
  });
});
