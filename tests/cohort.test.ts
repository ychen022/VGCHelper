import {describe, expect, it} from 'vitest';
import {selectCohort} from '../src/analysis/matchup/cohort.js';
import type {MetaTeam, PokemonSet} from '../src/domain/contracts.js';

function sample(id: string, date: string, species: string, overrides: Partial<PokemonSet> = {}): MetaTeam {
  const pokemon: PokemonSet[] = [
    {species, moves: ['Protect'], skillPoints: {atk: 32, spe: 32}, ivs: {}, level: 50, ...overrides},
    ...['Incineroar', 'Rillaboom', 'Clefairy', 'Garchomp', 'Gengar'].map(name => ({
      species: name, moves: ['Protect'], skillPoints: {}, ivs: {}, level: 50,
    })),
  ];
  return {id, date, name: id, regulationId: 'fixture', roster: pokemon.map(set => set.species), pokemon,
    exactSets: true, source: {provider: 'published-event', retrievedAt: '2026-09-04', url: `https://example.test/${id}`}};
}

describe('source-based threat-aware cohorts', () => {
  it('keeps an older requested threat and a recent team within the cap', () => {
    const teams = [sample('recent', '2026-09-04', 'Dragonite'), sample('runner-up', '2026-09-03', 'Salamence'),
      sample('charizard', '2026-08-01', 'Charizard', {item: 'Charizardite Y'})];
    const result = selectCohort(teams, 2, ['Charizard-Mega-Y']);
    expect(result.teams.map(team => team.id)).toEqual(['charizard', 'recent']);
    expect(result.coverage.testedPriorityThreats).toEqual(['Charizard-Mega-Y']);
    expect(result.coverage.selections[0]?.reasons.some(reason => reason.includes('Charizard-Mega-Y'))).toBe(true);
    expect(result.coverage.selections[0]?.source).toEqual(teams[2]!.source);
  });

  it('distinguishes absent priorities from available threats omitted by the budget', () => {
    const result = selectCohort([sample('dragon', '2026-09-04', 'Dragonite'), sample('fire', '2026-08-01', 'Charizard')],
      1, ['Dragonite', 'Charizard', 'Kyogre']);
    expect(result.coverage.testedPriorityThreats).toEqual(['Dragonite']);
    expect(result.coverage.omittedPriorityThreats).toEqual([
      {threat: 'Charizard', reason: 'budget'}, {threat: 'Kyogre', reason: 'missing-source'},
    ]);
  });

  it('preserves different published bulk spreads for an identical roster and deduplicates replicas', () => {
    const fast = sample('fast', '2026-09-04', 'Charizard', {item: 'Charizardite Y'});
    const duplicate = {...structuredClone(fast), id: 'copy', date: '2026-09-03'};
    const bulky = sample('bulky', '2026-09-01', 'Charizard', {item: 'Charizardite Y', skillPoints: {hp: 32, def: 32}});
    const result = selectCohort([fast, duplicate, bulky], 3);
    expect(result.teams.map(team => team.id)).toEqual(['fast', 'bulky']);
    expect(result.coverage.uniqueCandidates).toBe(2);
    expect(result.coverage.diversity.publishedSpreadVariants.selected).toBeGreaterThan(1);
  });

  it('keeps Charizard X/Y priorities distinct while matching a base priority to Mega sets', () => {
    const x = sample('x', '2026-09-04', 'Charizard', {item: 'Charizardite X'});
    const result = selectCohort([x], 2, ['charizard', 'Charizard-Mega-X', 'Charizard-Mega-Y']);
    expect(result.coverage.testedPriorityThreats).toEqual(['charizard', 'Charizard-Mega-X']);
    expect(result.coverage.omittedPriorityThreats).toEqual([{threat: 'Charizard-Mega-Y', reason: 'missing-source'}]);
    expect(selectCohort([sample('mega', '2026-09-04', 'Gengar-Mega')], 1, ['Gengar']).coverage.testedPriorityThreats).toEqual(['Gengar']);
  });

  it('adds older weather and control sources beyond the newest similar teams', () => {
    const newest = sample('newest', '2026-09-04', 'Dragonite');
    const recent = sample('recent', '2026-09-03', 'Dragonite', {item: 'Life Orb'});
    const rain = sample('rain', '2026-08-01', 'Pelipper', {ability: 'Drizzle', moves: ['Tailwind', 'Protect']});
    const result = selectCohort([recent, rain, newest], 2);
    expect(result.teams.map(team => team.id)).toEqual(['newest', 'rain']);
    expect(result.coverage.diversity.weather.selected).toContain('rain');
    expect(result.coverage.diversity.control.selected).toContain('tailwind');
  });

  it('is independent of input order and does not mutate source teams', () => {
    const teams = [sample('z', 'September 2, 2026', 'Dragonite'), sample('a', '2026-09-02', 'Pelipper'),
      sample('older', 'August 1, 2026', 'Charizard', {item: 'Charizardite Y'})];
    const snapshot = structuredClone(teams);
    expect(selectCohort(teams, 2, ['Charizard'])).toEqual(selectCohort([...teams].reverse(), 2, ['Charizard']));
    expect(teams).toEqual(snapshot);
  });

  it('reports source and budget limitations for empty and zero-sized cohorts', () => {
    expect(selectCohort([], 2, ['Charizard']).coverage.omittedPriorityThreats).toEqual([{threat: 'Charizard', reason: 'missing-source'}]);
    const result = selectCohort([sample('fire', '2026-09-04', 'Charizard')], 0, ['Charizard']);
    expect(result.teams).toEqual([]);
    expect(result.coverage.omittedPriorityThreats).toEqual([{threat: 'Charizard', reason: 'budget'}]);
  });

  it('does not describe inferred moves, abilities, stones or spreads as published diversity', () => {
    const inferred = sample('inferred', '2026-09-04', 'Charizard', {
      item: 'Charizardite Y', ability: 'Drought', moves: ['Tailwind'], skillPoints: {hp: 32, def: 32},
      provenance: Object.fromEntries(['item', 'ability', 'moves', 'skillPoints'].map(field => [field,
        {knowledge: 'inferred', confidence: 0.5, source: 'usage-hypothesis'}])),
    });
    inferred.exactSets = false;
    const coverage = selectCohort([inferred], 1).coverage;
    expect(coverage.diversity.weather.selected).toEqual([]);
    expect(coverage.diversity.control.selected).toEqual([]);
    expect(coverage.diversity.publishedSpreadVariants.selected).toBe(0);
    expect(coverage.diversity.species.selected).not.toContain('charizardmegay');
  });

  it('does not deduplicate older published evidence into a newer numerically identical inferred set', () => {
    const published = sample('published', '2026-08-01', 'Charizard', {item: 'Charizardite Y',
      provenance: {item: {knowledge: 'known', confidence: 1, source: 'published'},
        skillPoints: {knowledge: 'known', confidence: 1, source: 'published'}}});
    const inferred = structuredClone(published);
    inferred.id = 'inferred';
    inferred.date = '2026-09-01';
    inferred.exactSets = false;
    inferred.pokemon[0]!.provenance = {item: {knowledge: 'inferred', confidence: 0.4, source: 'marginal'},
      skillPoints: {knowledge: 'inferred', confidence: 0.4, source: 'marginal'}};
    const result = selectCohort([inferred, published], 1, ['Charizard-Mega-Y']);
    expect(result.teams.map(team => team.id)).toEqual(['published']);
    expect(result.coverage.testedPriorityThreats).toEqual(['Charizard-Mega-Y']);
    expect(result.coverage.diversity.publishedSpreadVariants.available).toBeGreaterThan(0);
    expect(result.coverage.uniqueCandidates).toBe(2);
  });
});
