import {describe, expect, it} from 'vitest';
import type {MetaTeam, PokemonSet, PokemonTeam} from '../src/domain/contracts.js';
import {compareTeams} from '../src/analysis/matchup/comparison.js';

const known = {knowledge: 'known' as const, confidence: 1, source: 'published fixture export'};
const set = (species: string, overrides: Partial<PokemonSet> = {}): PokemonSet => ({
  species, moves: ['Protect'], level: 50, nature: 'Serious', skillPoints: {},
  ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
  provenance: {skillPoints: known, nature: known}, ...overrides,
});
const sneasler = set('Sneasler', {item: 'Life Orb', ability: 'Unburden', nature: 'Adamant',
  skillPoints: {atk: 32, spe: 32, hp: 2}, moves: ['Close Combat', 'Rock Slide', 'Fake Out', 'Protect']});
const garchomp = set('Garchomp', {item: 'Garchompite', ability: 'Rough Skin', nature: 'Adamant',
  skillPoints: {atk: 32, spe: 32, hp: 2}, moves: ['Rock Slide', 'Earthquake', 'Dragon Claw', 'Protect']});
const before: PokemonTeam = {sourceText: 'exact original export', pokemon: [sneasler, garchomp]};
const after: PokemonTeam = {...before, sourceText: 'exact candidate export', pokemon: [
  {...sneasler, moves: ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect']}, garchomp,
]};
const meta = (id: string, pokemon: PokemonSet[]): MetaTeam => ({
  id, name: id, regulationId: 'test', exactSets: true, roster: pokemon.map(p => p.species), pokemon,
  source: {provider: 'published-fixture', retrievedAt: '2026-09-04T00:00:00Z', url: `https://example.test/${id}`},
});
const zard = set('Charizard', {item: 'Charizardite Y', ability: 'Blaze', nature: 'Modest', skillPoints: {spa: 32, spe: 32, hp: 2}});
const cohort = [meta('offensive', [zard]), meta('bulky', [
  {...zard, nature: 'Bold', skillPoints: {hp: 32, def: 32, spd: 2}},
]), meta('floette', [set('Floette-Eternal', {item: 'Floettite', ability: 'Flower Veil', skillPoints: {spa: 32, spe: 32, hp: 2}})])];

describe('same-scenario team comparisons', () => {
  it('preserves direct Charizard coverage losses and Floette gains despite another Rock Slide user', () => {
    const report = compareTeams(before, after, cohort);
    const zardRows = report.benchmarks.filter(row => row.attackerSpecies === 'Sneasler' && row.defenderSpecies === 'Charizard-Mega-Y');
    expect(zardRows.some(row => row.opponentTeamId === 'offensive' && row.change === 'loss')).toBe(true);
    expect(zardRows.some(row => row.opponentTeamId === 'bulky' && row.change === 'loss')).toBe(true);
    expect(report.benchmarks.some(row => row.defenderSpecies.includes('Floette') && row.change === 'gain')).toBe(true);
    const neutral = zardRows.find(row => row.weather === 'neutral' && row.attackStage === 0 && !row.helpingHand)!;
    expect(neutral.beforeMoves.find(move => move.move === 'Rock Slide')?.ohkoOnHit).toBe(1);
    expect(neutral.beforeMoves.find(move => move.move === 'Rock Slide')?.accuracyAdjustedOhko).toBe(0.9);
    expect(neutral.afterMoves.some(move => move.move === 'Rock Slide')).toBe(false);
    expect(neutral.alternateTeammateAttacks.some(move => move.attackerSpecies === 'Garchomp-Mega' && move.move === 'Rock Slide' && move.megaRequired)).toBe(true);
    expect(report.beforeTeam).toEqual(before);
    expect(report.afterTeam).toEqual(after);
    expect(report.scenarios.find(s => s.opponentTeamId === 'bulky')?.publishedSet).toEqual(cohort[1]!.pokemon[0]);
    expect(report.scenarios.find(s => s.opponentTeamId === 'bulky')?.source).toEqual(cohort[1]!.source);
  });

  it('pairs neutral, Sun, minus-one physical Attack and Helping Hand without assuming support execution', () => {
    const report = compareTeams(before, after, cohort.slice(0, 1));
    const rows = report.benchmarks.filter(row => row.defenderSpecies === 'Charizard-Mega-Y');
    expect(new Set(rows.map(row => row.weather))).toEqual(new Set(['neutral', 'Sun']));
    const ordinary = rows.find(row => row.weather === 'neutral' && row.attackStage === 0 && !row.helpingHand)!;
    const lowered = rows.find(row => row.weather === 'neutral' && row.attackStage === -1 && !row.helpingHand)!;
    const assisted = rows.find(row => row.weather === 'neutral' && row.attackStage === 0 && row.helpingHand)!;
    const rock = (row: typeof ordinary) => row.beforeMoves.find(move => move.move === 'Rock Slide')!;
    expect(rock(lowered).percentRange[1]).toBeLessThan(rock(ordinary).percentRange[1]);
    expect(rock(assisted).percentRange[0]).toBeGreaterThan(rock(ordinary).percentRange[0]);
    expect(assisted.conditions.join(' ')).toMatch(/Helping Hand.*conditional/i);
    expect(report.limitations.join(' ')).toMatch(/not.*win probabilit/i);
  });

  it('never labels a missing or inferred spread published and discloses both bulk sensitivities', () => {
    const unknown = {...zard, provenance: {skillPoints: {knowledge: 'inferred' as const, confidence: 0.4, source: 'marginal'}}};
    const report = compareTeams(before, after, [meta('unknown', [unknown])]);
    expect(new Set(report.scenarios.map(s => s.spreadKind))).toEqual(new Set(['unknown-zero-investment', 'unknown-physical-bulk', 'unknown-special-bulk']));
    expect(report.scenarios.every(s => s.publishedSet.skillPoints.spa === 32)).toBe(true);
    expect(report.scenarios.find(s => s.spreadKind === 'unknown-physical-bulk')?.defenderSet.skillPoints).toEqual({hp: 32, def: 32, spd: 2});
    expect(compareTeams(before, after, [meta('unmarked', [{...zard, provenance: undefined} as unknown as PokemonSet])]).scenarios.every(s => s.spreadKind !== 'published')).toBe(true);
  });

  it('keeps the strongest alternate Mega attack conditional and its base attack separately visible', () => {
    const report = compareTeams(before, after, cohort.slice(0, 1));
    const row = report.benchmarks.find(row => row.defenderSpecies === 'Charizard-Mega-Y' && row.attackStage === 0 && !row.helpingHand)!;
    const mega = row.alternateTeammateAttacks.find(move => move.attackerSpecies === 'Garchomp-Mega' && move.move === 'Rock Slide')!;
    const base = row.alternateTeammateAttacks.find(move => move.attackerSpecies === 'Garchomp' && move.move === 'Rock Slide')!;
    expect(mega.conditions.join(' ')).toMatch(/Mega.*conditional/);
    expect(base.megaRequired).toBe(false);
    expect(base.percentRange[1]).toBeLessThan(mega.percentRange[1]);
  });

  it('reports truncation and retains identical evidence independent of input cohort order', () => {
    const many = Array.from({length: 60}, (_, i) => meta(`team-${String(i).padStart(3, '0')}`, [{...zard, skillPoints: {hp: i % 33}}]));
    const report = compareTeams(before, after, many);
    expect(report.counts.omittedScenarios).toBeGreaterThan(0);
    expect(report.counts.totalScenarios).toBe(report.scenarios.length + report.counts.omittedScenarios);
    expect(report.counts.totalBenchmarks).toBe(report.benchmarks.length + report.counts.omittedBenchmarks);
    expect(compareTeams(before, after, [...many].reverse())).toEqual(report);
  });

  it('does not report alphabetical move ties or team reordering as damage gains or losses', () => {
    const icePunch: PokemonTeam = {pokemon: [set('Snorlax', {ability: 'Thick Fat', moves: ['Ice Punch']})]};
    const firePunch: PokemonTeam = {pokemon: [{...icePunch.pokemon[0]!, moves: ['Fire Punch']}]};
    const equalMoves = compareTeams(icePunch, firePunch, [meta('equal', [set('Snorlax', {ability: 'Immunity'})])]);
    const neutralRows = equalMoves.benchmarks.filter(row => row.weather === 'neutral');
    expect(neutralRows[0]!.beforeMoves[0]!.percentRange[0]).toBeGreaterThan(0);
    expect(neutralRows.every(row => row.change === 'unchanged')).toBe(true);
    const reordered = {...before, pokemon: [...before.pokemon].reverse()};
    expect(compareTeams(before, reordered, cohort.slice(0, 1)).benchmarks.every(row => row.change === 'unchanged')).toBe(true);
  });

  it('weights Parental Bond rolls and leaves unsupported accuracy unknown', () => {
    const kangaskhan: PokemonTeam = {pokemon: [set('Kangaskhan', {
      item: 'Kangaskhanite', ability: 'Scrappy', nature: 'Adamant', skillPoints: {atk: 32}, moves: ['Double-Edge'],
    })]};
    const report = compareTeams(kangaskhan, kangaskhan, [meta('weighted', [set('Blastoise', {ability: 'Torrent'})])]);
    const move = report.benchmarks.find(row => row.attackStage === 0 && !row.helpingHand)!.beforeMoves.find(move => move.megaRequired)!;
    // 78 of 256 equally likely pairs reach Blastoise's 154 HP. The 28 unique
    // damage totals are not equiprobable; counting unique totals would give 10/28.
    expect(move.damageRange).toEqual([136, 163]);
    expect(move.ohkoOnHit).toBe(78 / 256);
    expect(move.nominalAccuracy).toBeNull();
    expect(move.accuracyAdjustedOhko).toBeNull();
  });

  it('does not retain a Mega ability in the stone wearer base-form benchmark', () => {
    const megaAbilityExport: PokemonTeam = {pokemon: [{...zard, ability: 'Drought', moves: ['Flamethrower']}]};
    const report = compareTeams(megaAbilityExport, megaAbilityExport, [meta('target', [set('Snorlax', {ability: 'Immunity'})])]);
    const row = report.benchmarks.find(row => row.weather === 'neutral' && row.attackStage === 0 && !row.helpingHand)!;
    expect(row.beforeMoves.find(move => !move.megaRequired)?.attackerAbility).toBe('Blaze');
    expect(row.beforeMoves.find(move => move.megaRequired)?.attackerAbility).toBe('Drought');
  });

  it('retains later distinct threat forms when many earlier repeated sources fill the scenario budget', () => {
    const earlier = Array.from({length: 30}, (_, i) => meta(`early-${i}`, [set('Snorlax', {ability: 'Thick Fat'})]));
    const report = compareTeams(before, after, [...earlier, meta('z-last-charizard', [zard])]);
    expect(report.scenarios.some(s => s.opponentTeamId === 'z-last-charizard' && s.defenderSpecies === 'Charizard-Mega-Y')).toBe(true);
    expect(report.benchmarks.some(row => row.opponentTeamId === 'z-last-charizard' && row.change === 'loss')).toBe(true);
  });

  it('preserves a fully specified published spread without per-field provenance', () => {
    const complete = {...zard, skillPoints: {hp: 2, atk: 0, def: 0, spa: 32, spd: 0, spe: 32}};
    delete complete.provenance;
    const report = compareTeams(before, after, [meta('complete', [complete])]);
    expect(report.scenarios.every(s => s.spreadKind === 'published')).toBe(true);
    expect(report.scenarios[0]?.defenderSet.skillPoints).toEqual(complete.skillPoints);
    const hypothetical = {...meta('not-published', [complete]), exactSets: false};
    expect(compareTeams(before, after, [hypothetical]).scenarios.every(s => s.spreadKind !== 'published')).toBe(true);
  });

  it('retains later targets and both changed attackers after the final benchmark-row cap', () => {
    const original: PokemonTeam = {pokemon: [set('Sneasler', {moves: ['Dire Claw'], skillPoints: {atk: 32}}),
      set('Garchomp', {moves: ['Dragon Claw'], skillPoints: {atk: 32}})]};
    const edited = {pokemon: original.pokemon.map(pokemon => ({...pokemon, skillPoints: {atk: 0}}))};
    const targets = Array.from({length: 40}, (_, i) => meta(`a-${String(i).padStart(2, '0')}`, [
      set('Snorlax', {skillPoints: {hp: i % 33, def: Math.floor(i / 33)}}),
    ]));
    targets.push(meta('z-final', [set('Milotic', {skillPoints: {hp: 32, def: 32}})]));
    const report = compareTeams(original, edited, targets);
    expect(report.counts.omittedBenchmarks).toBeGreaterThan(0);
    const finalRows = report.benchmarks.filter(row => row.opponentTeamId === 'z-final');
    expect(new Set(finalRows.map(row => row.attackerSpecies))).toEqual(new Set(['Sneasler', 'Garchomp']));
    expect(finalRows.some(row => row.beforeBest?.threshold === 'possible-2hko-on-two-hits' && row.afterBest?.threshold === 'below-2hko')).toBe(true);
    expect(report.counts.omittedEvaluatedLosses).toBeGreaterThan(0);
  });

  it('uses explicit Aegislash Shield defense and conditional Blade attacks for published base-name sets', () => {
    const aegislash = set('Aegislash', {ability: 'Stance Change', item: 'Leftovers',
      moves: ['Shadow Ball', 'Flash Cannon'], skillPoints: {hp: 32, spa: 32, spd: 2}});
    const report = compareTeams(before, after, [meta('aegislash', [aegislash])]);
    expect(report.scenarios.every(scenario => scenario.defenderSpecies === 'Aegislash-Shield')).toBe(true);
    expect(report.scenarios[0]!.publishedSet.species).toBe('Aegislash');
    expect(report.benchmarks[0]!.beforeMoves.some(move => move.percentRange[1] > 0)).toBe(true);
    expect(report.scenarios[0]!.conditions.join(' ')).toMatch(/stance.*conditional/i);

    const attacker = {pokemon: [aegislash]};
    const attackReport = compareTeams(attacker, attacker, [meta('target', [set('Milotic', {ability: 'Competitive'})])]);
    expect(attackReport.benchmarks[0]!.beforeMoves.every(move => move.attackerSpecies === 'Aegislash-Blade')).toBe(true);
    expect(attackReport.benchmarks[0]!.beforeMoves[0]!.conditions.join(' ')).toMatch(/Blade.*conditional/i);
    const alreadyBlade = compareTeams(before, after, [meta('blade', [{...aegislash, species: 'Aegislash-Blade'}])]);
    expect(alreadyBlade.scenarios[0]!.defenderSpecies).toBe('Aegislash-Blade');
  });
});
