import {
  calculate,
  Field,
  Generations,
  Move,
  Pokemon,
  toID,
} from '@smogon/calc';
import type {State, StatsTable} from '@smogon/calc';

import type {
  DamageRequest,
  DamageResult,
  PokemonSet,
  PokemonPosition,
  Stats,
} from '../domain/contracts.js';
import {VgcError} from '../errors.js';
import {errorMessage} from '../errors.js';

const CALCULATOR_VERSION = 'smogon/damage-calc@e7fd7e5+seed-description.1';
const champions = Generations.get(0);
const megaTargets = new Set(
  [...champions.items].flatMap((item) =>
    item.megaStone ? Object.values(item.megaStone) : [],
  ),
);

function sameName(left: string, right: string): boolean {
  return left.toLowerCase().replace(/[^a-z0-9]/g, '') ===
    right.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolvedSpecies(set: PokemonSet, move?: string): string {
  if (sameName(set.species, 'Aegislash')) {
    return move && set.ability === 'Stance Change' && isDamagingMove(move) ? 'Aegislash-Blade' : 'Aegislash-Shield';
  }
  const item = set.item ? champions.items.get(toID(set.item)) : undefined;
  if (item?.megaStone) {
    for (const [base, mega] of Object.entries(item.megaStone)) {
      if (sameName(set.species, base) || sameName(set.species, mega)) {
        return mega;
      }
    }
  }
  return Pokemon.getForme(champions, set.species, undefined, move);
}

function calcStats(stats: Stats): Partial<StatsTable> {
  return stats;
}

function pokemonOptions(
  set: PokemonSet,
  resolvedSpecies: string,
): NonNullable<ConstructorParameters<typeof Pokemon>[2]> {
  const transformed =
    !sameName(resolvedSpecies, set.species) ||
    [...megaTargets].some((target) => sameName(target, resolvedSpecies));
  return {
    level: set.level,
    ...(set.item ? {item: set.item} : {}),
    ...(!transformed && set.ability ? {ability: set.ability} : {}),
    ...(set.nature ? {nature: set.nature} : {}),
    moves: set.moves,
    evs: calcStats(set.skillPoints),
    ivs: calcStats(set.ivs),
  };
}

function weather(value?: string): State.Field['weather'] {
  if (!value) return undefined;
  const aliases: Record<string, NonNullable<State.Field['weather']>> = {
    rain: 'Rain',
    sun: 'Sun',
    sand: 'Sand',
    hail: 'Hail',
    snow: 'Snow',
    harshsunshine: 'Harsh Sunshine',
    heavyrain: 'Heavy Rain',
    strongwinds: 'Strong Winds',
  };
  const selected = aliases[value.toLowerCase().replace(/[^a-z]/g, '')];
  if (!selected) {
    throw new VgcError('INVALID_INPUT', `Unknown weather "${value}"`);
  }
  return selected;
}

function terrain(value?: string): State.Field['terrain'] {
  if (!value) return undefined;
  const aliases: Record<string, NonNullable<State.Field['terrain']>> = {
    electric: 'Electric',
    grassy: 'Grassy',
    psychic: 'Psychic',
    misty: 'Misty',
  };
  const selected = aliases[value.toLowerCase().replace(/[^a-z]/g, '')];
  if (!selected) {
    throw new VgcError('INVALID_INPUT', `Unknown terrain "${value}"`);
  }
  return selected;
}

function totalDamageDistribution(value: number | number[] | number[][]): Array<{damage:number;probability:number}> {
  if (typeof value === 'number') return [{damage:value,probability:1}];
  // The upstream result represents fixed two-hit damage as [number, number].
  const hits = typeof value[0] === 'number'
    ? value.length === 2 ? (value as number[]).map(v=>[v]) : [value as number[]]
    : value as number[][];
  let totals = new Map<number,number>([[0,1]]);
  for (const hit of hits) {
    const next = new Map<number,number>();
    for (const [total,probability] of totals) for (const roll of hit) {
      next.set(total+roll,(next.get(total+roll)??0)+probability/hit.length);
    }
    totals = next;
  }
  return [...totals].sort(([a],[b])=>a-b).map(([damage,probability])=>({damage,probability}));
}

function assumptionList(request: DamageRequest): string[] {
  const assumptions: string[] = [];
  if (request.defender.species.startsWith('Aegislash') && !request.defenderPosition?.species) {
    assumptions.push('Aegislash defense defaults to its supplied stance, or Shield for the base export. It may be in Blade stance after acting; turn-order stance changes are not simulated.');
  }
  for (const [role, set] of [
    ['attacker', request.attacker],
    ['defender', request.defender],
  ] as const) {
    if (!set.item) assumptions.push(`${role} item is unknown`);
    if (!set.ability) assumptions.push(`${role} ability is unknown`);
    if (!set.nature) assumptions.push(`${role} nature defaults to Serious`);
    if (
      set.provenance?.skillPoints?.knowledge === 'inferred' ||
      set.provenance?.skillPoints?.knowledge === 'unknown'
    ) {
      assumptions.push(`${role} skill points are not directly known`);
    }
  }
  for (const [role, position] of [['attacker', request.attackerPosition], ['defender', request.defenderPosition]] as const) {
    if (position?.hpPercent !== undefined) assumptions.push(`${role} HP uses the supplied percentage; public replay HP may be rounded.`);
  }
  if (!request.attackerPosition?.species || !request.defenderPosition?.species) {
    assumptions.push('Without an explicit current species, a held Mega Stone selects its Mega form. This does not simulate Mega activation or entry abilities.');
  }
  return assumptions;
}

function positionedPokemon(set: PokemonSet, position?: PokemonPosition, move?: string): Pokemon {
  let species = position?.species ?? resolvedSpecies(set, move);
  if (sameName(species, 'Aegislash')) species = 'Aegislash-Shield';
  if (species.startsWith('Aegislash') && (position?.ability ?? set.ability) === 'Stance Change' && move && isDamagingMove(move)) species = 'Aegislash-Blade';
  const options = pokemonOptions(set, species);
  if (position?.item !== undefined) options.item = position.item;
  if (position?.ability !== undefined) options.ability = position.ability;
  if (position?.boosts) options.boosts = position.boosts;
  if (position?.status !== undefined) {
    if (!['', 'brn', 'par', 'slp', 'frz', 'psn', 'tox'].includes(position.status)) throw new Error('Unknown status');
    options.status = position.status as NonNullable<State.Pokemon['status']>;
  }
  if (position?.alliesFainted !== undefined) options.alliesFainted = position.alliesFainted;
  const pokemon = new Pokemon(champions, species, options);
  if (position?.hpPercent !== undefined) {
    if (position.hpPercent <= 0 || position.hpPercent > 100) throw new Error('Calculation HP must be greater than zero and at most 100 percent');
    const maximumHp = pokemon.maxHP();
    // Preserve integer HP when its percentage has made a floating-point round trip.
    pokemon.originalCurHP = Math.max(1, Math.floor(maximumHp * position.hpPercent / 100 + 8 * Number.EPSILON * maximumHp));
  }
  return pokemon;
}

export function calculateChampionsDamage(
  request: DamageRequest,
): DamageResult {
  try {
    const attacker = positionedPokemon(request.attacker, request.attackerPosition, request.move);
    const defender = positionedPokemon(request.defender, request.defenderPosition);
    const move = new Move(champions, request.move, {
      isCrit: request.field?.isCritical ?? false,
      ...(request.field?.singleTarget ? {overrides: {target: 'normal' as const}} : {}),
    });
    const selectedWeather = weather(request.field?.weather);
    const selectedTerrain = terrain(request.field?.terrain);
    const field = new Field({
      gameType: 'Doubles',
      isGravity: request.field?.isGravity ?? false,
      ...(selectedWeather ? {weather: selectedWeather} : {}),
      ...(selectedTerrain ? {terrain: selectedTerrain} : {}),
      attackerSide: {
        isHelpingHand: request.field?.isHelpingHand ?? false,
        isTailwind: request.field?.attackerTailwind ?? false,
      },
      defenderSide: {
        isReflect: request.field?.isReflect ?? false,
        isLightScreen: request.field?.isLightScreen ?? false,
        isFriendGuard: request.field?.isFriendGuard ?? false,
        isProtected: request.field?.isProtected ?? false,
        isAuroraVeil: request.field?.isAuroraVeil ?? false,
        isTailwind: request.field?.defenderTailwind ?? false,
      },
    });

    const result = calculate(champions, attacker, defender, move, field);
    const damageDistribution = totalDamageDistribution(result.damage);
    const damage = Array.isArray(result.damage) && typeof result.damage[0] === 'number' && result.damage.length !== 2
      ? result.damage as number[]
      : damageDistribution.map(outcome=>outcome.damage);
    const [minimum, maximum] = result.range();
    const maxHp = defender.maxHP();
    const description =
      maximum === 0
        ? `${attacker.name} ${result.move.name} vs. ${defender.name}: 0 damage`
        : result.fullDesc('%', false);

    return {
      move: result.move.name,
      damage,
      damageDistribution,
      range: [minimum, maximum],
      percentRange: [
        Number(((minimum / maxHp) * 100).toFixed(1)),
        Number(((maximum / maxHp) * 100).toFixed(1)),
      ],
      description,
      assumptions: [...assumptionList(request), ...(result.move.hits > 1 ? [`Damage distribution is conditional on ${result.move.hits} hits connecting; accuracy and variable hit-count probabilities are not included.`] : [])],
      calculatorVersion: CALCULATOR_VERSION,
      inputs: structuredClone(request),
    };
  } catch (error) {
    throw new VgcError(
      'CALCULATION_FAILED',
      `Champions damage calculation failed: ${errorMessage(error)}`,
      {
        attacker: request.attacker.species,
        defender: request.defender.species,
        move: request.move,
      },
      {cause: error},
    );
  }
}

export function pokemonSpeed(set: PokemonSet): number {
  const species = resolvedSpecies(set);
  return new Pokemon(champions, species, pokemonOptions(set, species)).stats.spe;
}

export function pokemonMaxHp(set: PokemonSet): number {
  const species = resolvedSpecies(set);
  return new Pokemon(champions, species, pokemonOptions(set, species)).maxHP();
}

export function movePriority(moveName: string): number {
  return new Move(champions, moveName).priority;
}

export function isSpreadMove(moveName: string): boolean {
  const target = new Move(champions, moveName).target;
  return target === 'allAdjacentFoes' || target === 'allAdjacent';
}

export function hitsAllAdjacent(moveName: string): boolean {
  return new Move(champions, moveName).target === 'allAdjacent';
}

export function isDamagingMove(moveName: string): boolean {
  return new Move(champions, moveName).category !== 'Status';
}

export function calculatorVersion(): string {
  return CALCULATOR_VERSION;
}
