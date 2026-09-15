import {Generations, Pokemon, toID} from '@smogon/calc';
import {calculateChampionsDamage, calculatorVersion, isDamagingMove} from '../../calc/champions.js';
import {STAT_IDS, type MetaTeam, type PokemonPosition, type PokemonSet, type PokemonTeam, type SourceReference} from '../../domain/contracts.js';

const champions = Generations.get(0);
const MAX_SCENARIOS = 128;
const MAX_BENCHMARKS = 128;
const MAX_ALTERNATES = 6;

export type SpreadKind = 'published' | 'unknown-zero-investment' | 'unknown-physical-bulk' | 'unknown-special-bulk';

export interface ComparisonScenario {
  id: string;
  opponentTeamId: string;
  opponentTeamName: string;
  source: SourceReference;
  sourceUrl?: string;
  publishedSet: PokemonSet;
  defenderSet: PokemonSet;
  defenderSpecies: string;
  defenderAbility: string;
  defenderMegaRequired: boolean;
  spreadKind: SpreadKind;
  weather: 'neutral' | 'Sun';
  attackStage: 0 | -1;
  helpingHand: boolean;
  conditions: string[];
}

export interface MoveBenchmark {
  attackerSpecies: string;
  attackerAbility: string;
  attackerIndex: number;
  move: string;
  megaRequired: boolean;
  damageRange: [number, number];
  percentRange: [number, number];
  /** Conditional on the calculator's hit count connecting at full target HP. */
  ohkoOnHit: number;
  twoHitKoOnHits: number;
  nominalAccuracy: number | null;
  /** Nominal accuracy only; action execution and other accuracy modifiers are unresolved. */
  accuracyAdjustedOhko: number | null;
  threshold: 'guaranteed-ohko-on-hit' | 'possible-ohko-on-hit' | 'guaranteed-2hko-on-two-hits' | 'possible-2hko-on-two-hits' | 'below-2hko';
  conditions: string[];
}

export interface ComparisonBenchmark {
  scenarioId: string;
  opponentTeamId: string;
  attackerSpecies: string;
  defenderSpecies: string;
  weather: ComparisonScenario['weather'];
  attackStage: ComparisonScenario['attackStage'];
  helpingHand: boolean;
  spreadKind: SpreadKind;
  change: 'gain' | 'loss' | 'unchanged';
  beforeMoves: MoveBenchmark[];
  afterMoves: MoveBenchmark[];
  beforeBest: MoveBenchmark | null;
  afterBest: MoveBenchmark | null;
  alternateTeammateAttacks: MoveBenchmark[];
  omittedAlternateAttacks: number;
  conditions: string[];
}

export interface TeamComparisonReport {
  kind: 'same-scenario-damage-benchmarks';
  calculatorVersion: string;
  beforeTeam: PokemonTeam;
  afterTeam: PokemonTeam;
  scenarios: ComparisonScenario[];
  benchmarks: ComparisonBenchmark[];
  counts: {
    totalScenarios: number;
    omittedScenarios: number;
    /** Includes potential rows for scenarios omitted before calculation. */
    totalBenchmarks: number;
    omittedBenchmarks: number;
    evaluatedBenchmarks: number;
    omittedEvaluatedGains: number;
    omittedEvaluatedLosses: number;
    reportedGains: number;
    reportedLosses: number;
  };
  limitations: string[];
}

interface Form {
  species: string;
  ability: string;
  megaRequired: boolean;
}

function forms(set: PokemonSet): Form[] {
  if (toID(set.species) === 'aegislash') {
    return [{species: 'Aegislash-Shield', ability: set.ability ?? 'Stance Change', megaRequired: false}];
  }
  const stone = set.item ? champions.items.get(toID(set.item))?.megaStone : undefined;
  const mapping = stone && Object.entries(stone).find(([base, mega]) => toID(base) === toID(set.species) || toID(mega) === toID(set.species));
  if (mapping) {
    const [base, mega] = mapping;
    const baseAbility = champions.species.get(toID(base))?.abilities?.[0] ?? '';
    const megaAbility = champions.species.get(toID(mega))?.abilities?.[0] ?? '';
    const suppliedBaseAbility = toID(set.species) === toID(base) && set.ability &&
      (set.ability !== megaAbility || megaAbility === baseAbility) ? set.ability : baseAbility;
    return [
      {species: base, ability: suppliedBaseAbility, megaRequired: false},
      {species: mega, ability: megaAbility, megaRequired: true},
    ];
  }
  const isMega = /-Mega(?:-[XYZ])?$/.test(set.species);
  return [{species: set.species, ability: isMega ? champions.species.get(toID(set.species))?.abilities?.[0] ?? '' : set.ability ?? champions.species.get(toID(set.species))?.abilities?.[0] ?? '', megaRequired: isMega}];
}

function spreads(set: PokemonSet, exactSets: boolean): Array<{kind: SpreadKind; set: PokemonSet}> {
  const completePublishedSpread = exactSets && !set.provenance?.skillPoints &&
    STAT_IDS.every(stat => typeof set.skillPoints[stat] === 'number' && Number.isFinite(set.skillPoints[stat]));
  if (set.provenance?.skillPoints?.knowledge === 'known' || completePublishedSpread) return [{kind: 'published', set}];
  const assumed = (kind: SpreadKind, skillPoints: PokemonSet['skillPoints']): {kind: SpreadKind; set: PokemonSet} => ({
    kind, set: {...set, skillPoints, provenance: {...set.provenance,
      skillPoints: {knowledge: 'unknown', confidence: 0, source: `${kind}: sensitivity assumption, not a published spread`},
    }},
  });
  return [assumed('unknown-zero-investment', {}), assumed('unknown-physical-bulk', {hp: 32, def: 32, spd: 2}), assumed('unknown-special-bulk', {hp: 32, spd: 32, def: 2})];
}

// The calculator intentionally has no accuracy table. These explicitly supported
// values follow Pokemon Showdown data/moves.ts and data/mods/champions/moves.ts
// (checked 2026-09-04). Unlisted moves stay unknown rather than defaulting to 100%.
const NOMINAL_ACCURACY: Readonly<Record<string, number>> = {
  rockslide: 0.9, direclaw: 1, closecombat: 1, fakeout: 1,
  earthquake: 1, dragonclaw: 1, extremespeed: 1, moonblast: 1,
  poltergeist: 0.9, bulletpunch: 1,
};

function scenariosFor(cohort: MetaTeam[], sunRelevant: boolean): ComparisonScenario[] {
  const result: ComparisonScenario[] = [];
  for (const team of [...cohort].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const [setIndex, publishedSet] of team.pokemon.entries()) {
      for (const spread of spreads(publishedSet, team.exactSets)) {
        for (const form of forms(spread.set)) {
          const weathers: ComparisonScenario['weather'][] = sunRelevant || form.ability === 'Drought' ? ['neutral', 'Sun'] : ['neutral'];
          for (const weather of weathers) for (const attackStage of [0, -1] as const) for (const helpingHand of [false, true]) {
            result.push({
              id: `${team.id}:${setIndex}:${spread.kind}:${form.species}:${weather}:${attackStage}:${helpingHand}`,
              opponentTeamId: team.id, opponentTeamName: team.name, source: team.source,
              ...(team.sourceUrl ? {sourceUrl: team.sourceUrl} : {}),
              publishedSet, defenderSet: spread.set, defenderSpecies: form.species,
              defenderAbility: form.ability, defenderMegaRequired: form.megaRequired,
              spreadKind: spread.kind, weather, attackStage, helpingHand,
              conditions: [
                'Full target HP; a single attacker acts; two opposing targets remain for spread damage.',
                weather === 'neutral' ? 'Neutral weather is an explicit sensitivity state; entry weather activation is not simulated.' : 'Sun is supplied explicitly; weather control and activation order are unresolved.',
                ...(form.megaRequired ? [`Opponent ${form.species} requires its Mega choice.`] : []),
                ...(form.species.startsWith('Aegislash-') ? [`Defense uses ${form.species}; stance is conditional on when Aegislash last acted. Stance changes from turn order are unresolved.`] : []),
                ...(attackStage === -1 ? ['Physical Attack is explicitly at -1; this is a post-drop sensitivity, not an assertion that Intimidate bypasses immunity or triggers no other ability.'] : []),
                ...(helpingHand ? ['Helping Hand damage is conditional on an eligible ally successfully using it; bring-four, partner survival, and action availability are unresolved.'] : []),
                ...(spread.kind !== 'published' ? [`${spread.kind} is a hypothetical bulk sensitivity; the opponent spread is unknown. Supplied nature, item and ability remain conditional evidence.`] : []),
              ],
            });
          }
        }
      }
    }
  }
  return result;
}

function defenderKey(scenario: ComparisonScenario): string {
  const set = scenario.defenderSet;
  return JSON.stringify([scenario.defenderSpecies, scenario.defenderAbility, set.item, set.nature,
    set.level, STAT_IDS.map(stat => set.skillPoints[stat] ?? 0), STAT_IDS.map(stat => set.ivs[stat] ?? 31), scenario.spreadKind]);
}

function boundedScenarios(scenarios: ComparisonScenario[]): ComparisonScenario[] {
  // Round-robin across distinct defensive sets/forms before spending more budget
  // on weather, support, or repeated sources of the same set. Stable source order
  // inside each bucket preserves reproducibility without letting old duplicates
  // exclude a later threat simply because its source ID sorts last.
  const groups = new Map<string, ComparisonScenario[]>();
  for (const scenario of scenarios) {
    const key = defenderKey(scenario);
    const bucket = groups.get(key) ?? [];
    bucket.push(scenario);
    groups.set(key, bucket);
  }
  const selected: ComparisonScenario[] = [];
  const buckets = [...groups.values()];
  for (let round = 0; selected.length < Math.min(MAX_SCENARIOS, scenarios.length); round += 1) {
    for (const bucket of buckets) {
      const scenario = bucket[round];
      if (scenario) selected.push(scenario);
      if (selected.length === MAX_SCENARIOS) break;
    }
  }
  return selected;
}

function compareCoverage(a: MoveBenchmark, b: MoveBenchmark): number {
  return b.ohkoOnHit - a.ohkoOnHit || b.twoHitKoOnHits - a.twoHitKoOnHits ||
    b.percentRange[0] - a.percentRange[0] || b.percentRange[1] - a.percentRange[1];
}

function compareMoves(a: MoveBenchmark, b: MoveBenchmark): number {
  return compareCoverage(a, b) ||
    Number(a.megaRequired) - Number(b.megaRequired) || a.move.localeCompare(b.move);
}

function threshold(ohko: number, twoHit: number): MoveBenchmark['threshold'] {
  if (ohko >= 1 - 1e-10) return 'guaranteed-ohko-on-hit';
  if (ohko > 0) return 'possible-ohko-on-hit';
  if (twoHit >= 1 - 1e-10) return 'guaranteed-2hko-on-two-hits';
  return twoHit > 0 ? 'possible-2hko-on-two-hits' : 'below-2hko';
}

function benchmarkImportance(a: ComparisonBenchmark, b: ComparisonBenchmark): number {
  const rank = (move: MoveBenchmark | null): number => move === null ? -1 : [
    'below-2hko', 'possible-2hko-on-two-hits', 'guaranteed-2hko-on-two-hits',
    'possible-ohko-on-hit', 'guaranteed-ohko-on-hit',
  ].indexOf(move.threshold);
  const thresholdChange = (row: ComparisonBenchmark): number => Math.abs(rank(row.afterBest) - rank(row.beforeBest));
  return Number(a.change === 'unchanged') - Number(b.change === 'unchanged') ||
    thresholdChange(b) - thresholdChange(a) ||
    Math.abs((b.afterBest?.ohkoOnHit ?? 0) - (b.beforeBest?.ohkoOnHit ?? 0)) - Math.abs((a.afterBest?.ohkoOnHit ?? 0) - (a.beforeBest?.ohkoOnHit ?? 0)) ||
    Math.abs((b.afterBest?.twoHitKoOnHits ?? 0) - (b.beforeBest?.twoHitKoOnHits ?? 0)) - Math.abs((a.afterBest?.twoHitKoOnHits ?? 0) - (a.beforeBest?.twoHitKoOnHits ?? 0)) ||
    Number(b.change === 'loss') - Number(a.change === 'loss') ||
    Math.abs((b.afterBest?.percentRange[0] ?? 0) - (b.beforeBest?.percentRange[0] ?? 0)) - Math.abs((a.afterBest?.percentRange[0] ?? 0) - (a.beforeBest?.percentRange[0] ?? 0)) ||
    a.scenarioId.localeCompare(b.scenarioId) || a.attackerSpecies.localeCompare(b.attackerSpecies);
}

function boundedBenchmarks(rows: ComparisonBenchmark[], scenarios: ComparisonScenario[]): ComparisonBenchmark[] {
  if (rows.length <= MAX_BENCHMARKS) return [...rows].sort(benchmarkImportance);
  const scenarioById = new Map(scenarios.map(scenario => [scenario.id, scenario]));
  const groups = new Map<string, ComparisonBenchmark[]>();
  for (const row of rows) {
    // Reserve an actual gain/loss for each distinct target and changed attacker;
    // a second weather/source row must not crowd out another target's evidence.
    const key = JSON.stringify([defenderKey(scenarioById.get(row.scenarioId)!), row.attackerSpecies, row.change]);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const byAttacker = new Map<string, ComparisonBenchmark[][]>();
  for (const bucket of groups.values()) {
    bucket.sort(benchmarkImportance);
    const actorBuckets = byAttacker.get(bucket[0]!.attackerSpecies) ?? [];
    actorBuckets.push(bucket);
    byAttacker.set(bucket[0]!.attackerSpecies, actorBuckets);
  }
  const attackerBuckets = [...byAttacker.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, buckets]) =>
    buckets.sort((a, b) => benchmarkImportance(a[0]!, b[0]!)));
  const selected: ComparisonBenchmark[] = [];
  for (let round = 0; selected.length < Math.min(groups.size, MAX_BENCHMARKS); round += 1) {
    for (const buckets of attackerBuckets) {
      if (buckets[round]) selected.push(buckets[round]![0]!);
      if (selected.length === MAX_BENCHMARKS) break;
    }
  }
  const included = new Set(selected);
  selected.push(...rows.filter(row => !included.has(row)).sort(benchmarkImportance).slice(0, MAX_BENCHMARKS - selected.length));
  return selected;
}

function matchedAttackers(before: PokemonTeam, after: PokemonTeam): Array<{before?: number; after?: number}> {
  const taken = new Set<number>();
  const pairs: Array<{before?: number; after?: number}> = [];
  const unchanged: Array<{before?: number; after?: number}> = [];
  for (const [index, set] of before.pokemon.entries()) {
    const match = after.pokemon.findIndex((candidate, i) => !taken.has(i) && toID(candidate.species) === toID(set.species));
    if (match !== -1) {
      taken.add(match);
      if (JSON.stringify(set) !== JSON.stringify(after.pokemon[match])) pairs.push({before: index, after: match});
      else unchanged.push({before: index, after: match});
    } else pairs.push({before: index});
  }
  for (const index of after.pokemon.keys()) if (!taken.has(index)) pairs.push({after: index});
  // An unchanged comparison still provides a small reproducible benchmark screen.
  return pairs.length ? pairs : unchanged;
}

/** Compare isolated, conditional direct-damage options against exactly the same evidence. */
export function compareTeams(before: PokemonTeam, after: PokemonTeam, cohort: MetaTeam[]): TeamComparisonReport {
  const sunRelevant = [...before.pokemon, ...after.pokemon, ...cohort.flatMap(team => team.pokemon)]
    .some(set => forms(set).some(form => form.ability === 'Drought') || set.moves.some(move => champions.moves.get(toID(move))?.type === 'Fire'));
  const allScenarios = scenariosFor(cohort, sunRelevant);
  const selectedScenarios = boundedScenarios(allScenarios);
  const pairs = matchedAttackers(before, after);
  const cache = new Map<string, Omit<MoveBenchmark, 'attackerIndex'>>();
  const attackOptions = (team: PokemonTeam, index: number | undefined, scenario: ComparisonScenario): MoveBenchmark[] => {
    const attacker = index === undefined ? undefined : team.pokemon[index];
    if (!attacker || index === undefined) return [];
    const results: MoveBenchmark[] = [];
    for (const candidateForm of forms(attacker)) for (const move of attacker.moves.filter(isDamagingMove)) {
      // Match the adapter's damaging Stance Change transition explicitly so the
      // reported attack form agrees with the actual calculator form.
      const form = candidateForm.species.startsWith('Aegislash-') && candidateForm.ability === 'Stance Change'
        ? {...candidateForm, species: 'Aegislash-Blade'} : candidateForm;
      const attackerPosition: PokemonPosition = {species: form.species, ability: form.ability, boosts: {atk: scenario.attackStage}};
      const defenderPosition: PokemonPosition = {species: scenario.defenderSpecies, ability: scenario.defenderAbility};
      const request = {attacker, defender: scenario.defenderSet, move, attackerPosition, defenderPosition,
        field: {isHelpingHand: scenario.helpingHand, ...(scenario.weather === 'Sun' ? {weather: 'Sun'} : {})}};
      const key = JSON.stringify(request);
      let value = cache.get(key);
      if (!value) {
        const damage = calculateChampionsDamage(request);
        const hp = new Pokemon(champions, scenario.defenderSpecies, {
          level: scenario.defenderSet.level, evs: scenario.defenderSet.skillPoints,
          ivs: scenario.defenderSet.ivs, nature: scenario.defenderSet.nature ?? 'Serious',
        }).maxHP();
        const distribution = damage.damageDistribution ?? damage.damage.map(amount => ({damage: amount, probability: 1 / damage.damage.length}));
        const ohkoOnHit = Math.min(1, distribution.filter(outcome => outcome.damage >= hp).reduce((sum, outcome) => sum + outcome.probability, 0));
        let twoHitKoOnHits = 0;
        for (const left of distribution) for (const right of distribution) {
          if (left.damage + right.damage >= hp) twoHitKoOnHits += left.probability * right.probability;
        }
        twoHitKoOnHits = Math.min(1, twoHitKoOnHits);
        const nominalAccuracy = NOMINAL_ACCURACY[toID(move)] ?? null;
        value = {
          attackerSpecies: form.species, attackerAbility: form.ability, move, megaRequired: form.megaRequired,
          damageRange: damage.range, percentRange: damage.percentRange, ohkoOnHit, twoHitKoOnHits,
          nominalAccuracy, accuracyAdjustedOhko: nominalAccuracy === null ? null : nominalAccuracy * ohkoOnHit,
          threshold: threshold(ohkoOnHit, twoHitKoOnHits),
          conditions: [
            ...(form.megaRequired ? [`Mega ${form.species} is a conditional option requiring this attacker to receive the team's sole Mega choice.`] : []),
            ...(form.species === 'Aegislash-Blade' && form.ability === 'Stance Change' ? ['Blade-form attack damage is conditional on executing this damaging move with Stance Change; earlier incoming hits and stance timing are unresolved.'] : []),
            ...(nominalAccuracy === null ? ['Nominal move accuracy is unavailable; no accuracy-adjusted estimate is supplied.'] : []),
            ...damage.assumptions,
          ],
        };
        cache.set(key, value);
      }
      results.push({...value, attackerIndex: index});
    }
    return results.sort(compareMoves);
  };
  const allRows: ComparisonBenchmark[] = [];
  for (const scenario of selectedScenarios) {
    const afterOptions = after.pokemon.map((_, index) => attackOptions(after, index, scenario));
    for (const pair of pairs) {
      const beforeMoves = attackOptions(before, pair.before, scenario);
      const afterMoves = pair.after === undefined ? [] : afterOptions[pair.after] ?? [];
      const beforeBest = beforeMoves[0] ?? null;
      const afterBest = afterMoves[0] ?? null;
      const direction = beforeBest && afterBest ? compareCoverage(afterBest, beforeBest) : beforeBest ? 1 : afterBest ? -1 : 0;
      const alternates = afterOptions.flatMap((moves, index) => index === pair.after ? [] : moves).filter(move => move.percentRange[1] > 0).sort(compareMoves);
      allRows.push({
        scenarioId: scenario.id, opponentTeamId: scenario.opponentTeamId,
        attackerSpecies: (pair.before === undefined ? undefined : before.pokemon[pair.before]?.species) ?? after.pokemon[pair.after!]?.species ?? 'unknown',
        defenderSpecies: scenario.defenderSpecies, weather: scenario.weather, attackStage: scenario.attackStage,
        helpingHand: scenario.helpingHand, spreadKind: scenario.spreadKind,
        change: direction < 0 ? 'gain' : direction > 0 ? 'loss' : 'unchanged',
        beforeMoves, afterMoves, beforeBest, afterBest,
        alternateTeammateAttacks: alternates.slice(0, MAX_ALTERNATES), omittedAlternateAttacks: Math.max(0, alternates.length - MAX_ALTERNATES),
        conditions: [...scenario.conditions, 'Alternate teammate attacks are separate conditional options; they are not guaranteed backups or a jointly executable plan.'],
      });
    }
  }
  const rows = boundedBenchmarks(allRows, selectedScenarios);
  return structuredClone({
    kind: 'same-scenario-damage-benchmarks', calculatorVersion: calculatorVersion(), beforeTeam: before, afterTeam: after,
    scenarios: selectedScenarios, benchmarks: rows,
    counts: {
      totalScenarios: allScenarios.length, omittedScenarios: allScenarios.length - selectedScenarios.length,
      totalBenchmarks: allScenarios.length * pairs.length, omittedBenchmarks: allScenarios.length * pairs.length - rows.length,
      evaluatedBenchmarks: allRows.length,
      omittedEvaluatedGains: allRows.filter(row => row.change === 'gain').length - rows.filter(row => row.change === 'gain').length,
      omittedEvaluatedLosses: allRows.filter(row => row.change === 'loss').length - rows.filter(row => row.change === 'loss').length,
      reportedGains: rows.filter(row => row.change === 'gain').length, reportedLosses: rows.filter(row => row.change === 'loss').length,
    },
    limitations: [
      'These are single-attacker damage benchmarks, not battle win probabilities or guarantees that an action is available.',
      'Gain/loss compares the strongest direct damage option for each changed Pokemon. Per-move options retain coverage changes even when another teammate can attack the same target.',
      'Base and Mega options are mutually exclusive; every Mega attack requires that Pokemon to receive the sole team Mega choice. Alternatives are not combined into one plan.',
      'Only spreads explicitly marked known, or fully specified across six stats in a published exact-set source with no contrary provenance, use published benchmarks. Other spreads use labeled zero-investment, physical-bulk and special-bulk sensitivities; they are not inferred opponent facts.',
      'All supplied sets and source provenance are preserved. Nature, item, ability and IV uncertainty remains conditional; unknown fields may use calculator defaults.',
      'OHKO-on-hit uses the full weighted damage distribution. Accuracy-adjusted OHKO multiplies nominal move accuracy only and remains conditional on execution and the modeled hit count. Ability/item/evasion/weather accuracy modifiers are unresolved.',
      'Nominal accuracy for explicitly supported moves follows https://github.com/smogon/pokemon-showdown/blob/master/data/moves.ts and data/mods/champions/moves.ts, checked 2026-09-04. Other moves are labeled unknown.',
      'Two-hit thresholds assume independent rolls and ignore intervening recovery, recoil, stat changes, item consumption and secondary effects. Survival effects outside direct calculator damage, move side effects and support reliability are unresolved.',
      `At most ${MAX_SCENARIOS} scenarios and ${MAX_BENCHMARKS} benchmark rows are reported; scenarios are selected round-robin across distinct defensive sets/forms, with stable source-ID order. Omitted evidence can contain additional gains and losses.`,
      'The row cap reserves distinct target/attacker gain and loss evidence before repeated source/weather rows, alternating changed attackers and prioritizing both OHKO and two-hit threshold changes. Omitted evaluated gains/losses are counted separately; changes in uncalculated scenarios remain unknown.',
    ],
  } satisfies TeamComparisonReport);
}
