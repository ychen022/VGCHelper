import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {evaluateTeam, selectRepresentativeTeams} from '../src/analysis/matchup/evaluator.js';
import {buildOpeningScenarios} from '../src/analysis/matchup/openings.js';
import type {MetaTeam, MetaUsageRow} from '../src/domain/contracts.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import {parseShowdownTeam} from '../src/teams/parser.js';

const profile = loadRegulationProfile();
const team = parseShowdownTeam(readFileSync('examples/sample-team.txt', 'utf8'), profile);
const meta: MetaTeam = {
  id: 'mirror', regulationId: profile.id, name: 'Mirror', pokemon: team.pokemon,
  roster: team.pokemon.map(set => set.species), exactSets: true,
  source: {provider: 'fixture', retrievedAt: '2026-09-04T00:00:00Z'},
};

describe('V0 matchup guidance', () => {
  it('uses the total ten-hit Population Bomb outcome to preempt a slower attack', () => {
    const slow = structuredClone(team);
    slow.pokemon = slow.pokemon.map(set => ({...set, moves: ['Protect']}));
    slow.pokemon[0] = {...slow.pokemon[0]!, ability: 'Sand Veil', nature: 'Adamant', skillPoints: {atk: 32}, moves: ['Dragon Claw']};
    const opponent = structuredClone(slow);
    opponent.pokemon[0] = {...opponent.pokemon[0]!, species: 'Maushold', item: 'Wide Lens', ability: 'Technician', nature: 'Jolly', skillPoints: {atk: 32, spe: 32}, moves: ['Population Bomb']};
    const result = evaluateTeam(slow, [{...meta, pokemon: opponent.pokemon, roster: opponent.pokemon.map(set => set.species)}], [], profile);
    const row = result.matchups.find(entry => entry.userLead.first === 'Garchomp' && entry.userLead.second === 'Whimsicott' && entry.opponentLead.first === 'Maushold' && entry.opponentLead.second === 'Whimsicott')!;
    expect(row.features.rawOutgoingPressure).toBeGreaterThan(0);
    expect(row.features.outgoingPreemptionRisk).toBeCloseTo(100, 5);
    expect(row.features.outgoingPressure).toBeCloseTo(0, 5);
  });

  it('derives a battle archetype from moves rather than event classification', () => {
    const result = evaluateTeam(team, [{...meta, category: 'In Person Event'}], [], profile);
    expect(result.evaluation.archetypePlans[0]?.archetype).toBe('Tailwind');
  });

  it('keeps a valid target when Fake Out is the only available damaging move', () => {
    const fakeOut = {...team.pokemon[0]!, moves: ['Fake Out']};
    const protectedPartner = {...team.pokemon[1]!, moves: ['Protect']};
    const scenarios = buildOpeningScenarios([fakeOut, protectedPartner], team.pokemon.slice(2, 4), meta.id);
    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios.every(s => s.userActions[0]?.target !== undefined)).toBe(true);
    expect(scenarios.some(s => s.damage.some(hit => hit.move === 'Fake Out'))).toBe(true);
  });

  it('blocks ordinary hits into Protect while retaining the other partner as a target', () => {
    const user = [{...team.pokemon[0]!, moves: ['Dragon Claw']}, {...team.pokemon[1]!, moves: ['Protect']}];
    const foes = [{...team.pokemon[2]!, moves: ['Protect']}, {...team.pokemon[3]!, moves: ['Protect']}];
    const scenarios = buildOpeningScenarios(user, foes, meta.id);
    expect(scenarios.every(s => s.damage.length === 0)).toBe(true);
    const pressure = buildOpeningScenarios(user, foes.map(set => ({...set, moves: ['Tackle']})), meta.id);
    expect(pressure.some(s => s.damage.some(hit => hit.move === 'Dragon Claw'))).toBe(true);
    expect(pressure.every(s => s.damage.every(hit => hit.inputs && hit.inputs.defender.species !== user[1]!.species))).toBe(true);
  });

  it('selects dated representatives chronologically rather than lexically', () => {
    const older = {...meta, id: 'older', date: 'August 31, 2026'};
    const newer = {...meta, id: 'newer', date: 'September 1, 2026'};
    const iso = {...meta, id: 'iso', date: '2026-09-03'};
    expect(selectRepresentativeTeams([older, newer, iso], 1)[0]?.id).toBe('iso');
  });

  it('ignores other regulations and incomplete rosters before applying the cohort limit', () => {
    const result = evaluateTeam(team, [
      {...meta, id: 'wrong', regulationId: 'other', date: '2026-09-04'},
      {...meta, id: 'partial', roster: meta.roster.slice(0, 5), date: '2026-09-03'},
      {...meta, date: '2026-09-01'},
    ], [], {...profile, evaluation: {...profile.evaluation, maxMetaTeams: 1}});
    expect(result.cohort.map(entry => entry.id)).toEqual(['mirror']);
    // Each side has 15 leads plus 5 alternatives activating its Dragonite Mega.
    expect(result.matchups).toHaveLength(400);
  });

  it('rejects contradictory source regulation and refuses to hydrate with unrelated usage', () => {
    expect(() => evaluateTeam(team, [{...meta, source: {...meta.source, regulationId: 'other'}}], [], profile)).toThrow(/No complete representative/);
    const usage: MetaUsageRow[] = meta.roster.map(pokemon => ({pokemon, category: 'move', name: 'Tackle', rank: 1, percentage: 100, source: {...meta.source, regulationId: 'other'}}));
    expect(() => evaluateTeam(team, [{...meta, pokemon: [], exactSets: false}], usage, profile)).toThrow(/No complete representative/);
  });

  it('attributes matching usage snapshots used to fill missing opponent sets', () => {
    const source = {...meta.source, provider: 'usage-fixture', sourceVersion: 'snapshot-1', regulationId: profile.id, regulationVerified: true};
    const usage: MetaUsageRow[] = [{pokemon: meta.roster[5]!, category: 'move', name: 'Extreme Speed', rank: 1, percentage: 100, source}];
    const result = evaluateTeam(team, [{...meta, pokemon: meta.pokemon.slice(0, 5), exactSets: false}], usage, profile);
    expect(result.evaluation.sources).toContainEqual(source);
    expect(result.cohort[0]?.pokemon[0]).toEqual(meta.pokemon[0]);
  });

  it('returns legal bring-four plans, bounded joint support openings and conditional spread evidence', () => {
    const unknown = structuredClone(meta);
    unknown.pokemon[0]!.skillPoints = {};
    unknown.pokemon[0]!.provenance = {skillPoints: {knowledge: 'unknown', confidence: 0, source: 'fixture'}};
    const before = structuredClone(unknown);
    const result = evaluateTeam(team, [unknown], [], profile);
    const report = result.evaluation as typeof result.evaluation & {
      archetypePlans: Array<{bringFour: string[]; lead: {first: string; second: string}; rationale: string[]}>;
      openingScenarios: Array<{
        userActions: Array<{actor: string; move: string}>;
        opponentActions: Array<{actor: string; move: string}>;
        assumptions: string[]; limitations: string[];
        setScenario: {id: string; user: typeof team.pokemon; opponent: typeof team.pokemon};
      }>;
      recommendationDetails: Array<{change: string; tradeoff: string}>;
    };
    expect(report.archetypePlans).toHaveLength(1);
    for (const plan of report.archetypePlans) {
      expect(new Set(plan.bringFour).size).toBe(4);
      expect(plan.bringFour.slice(0, 2)).toEqual([plan.lead.first, plan.lead.second]);
      expect(plan.bringFour.every(species => meta.roster.includes(species))).toBe(true);
      expect(plan.rationale.length).toBeGreaterThan(0);
    }
    expect(report.openingScenarios.length).toBeGreaterThan(0);
    expect(report.openingScenarios.length).toBeLessThanOrEqual(216);
    expect(report.openingScenarios.some(s => s.userActions.some(a => a.move === 'Protect'))).toBe(true);
    expect(report.openingScenarios.some(s => s.userActions.some(a => a.move === 'Tailwind' || a.move === 'Fake Out'))).toBe(true);
    for (const scenario of report.openingScenarios) {
      expect(scenario.userActions).toHaveLength(2);
      expect(scenario.opponentActions).toHaveLength(2);
      expect(scenario.assumptions.length).toBeGreaterThan(0);
      expect(scenario.limitations.length).toBeGreaterThan(0);
      for (const set of [...scenario.setScenario.user, ...scenario.setScenario.opponent]) {
        const original = team.pokemon.find(p => p.species === set.species);
        expect(set.moves).toEqual(original?.moves);
        expect(set.item).toEqual(original?.item);
      }
    }
    expect(report.openingScenarios.some(s => s.setScenario.id === 'bulk-sensitivity')).toBe(true);
    expect(report.recommendationDetails.length).toBeGreaterThan(0);
    expect(report.recommendationDetails.length).toBeLessThanOrEqual(3);
    expect(report.recommendationDetails.every(r => r.tradeoff.length > 0)).toBe(true);
    expect(unknown).toEqual(before);
  }, 30000);
});
