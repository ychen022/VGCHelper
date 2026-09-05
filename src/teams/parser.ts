import {Teams} from '@pkmn/sets';
import {Generations, toID} from '@smogon/calc';

import type {PokemonSet, PokemonTeam, Stats} from '../domain/contracts.js';
import {STAT_IDS} from '../domain/contracts.js';
import {VgcError} from '../errors.js';
import type {RegulationProfile} from '../regulation/profile.js';

const champions = Generations.get(0);

function copyStats(
  values: Partial<Record<string, number | undefined>> | undefined,
  defaultValue: number,
): Stats {
  return Object.fromEntries(
    STAT_IDS.map((stat) => [stat, values?.[stat] ?? defaultValue]),
  ) as Stats;
}

function canonicalName(
  kind: 'species' | 'items' | 'abilities' | 'moves' | 'natures',
  value: string,
  context: string,
): string {
  // Showdown exports the default Shield stance under the base species name.
  if (kind === 'species' && toID(value) === 'aegislash') return 'Aegislash';
  const table = champions[kind];
  const entry = table.get(toID(value));
  if (!entry) {
    throw new VgcError(
      'INVALID_TEAM',
      `Unknown Champions ${kind === 'species' ? 'Pokemon' : kind.slice(0, -1)} "${value}"`,
      {context},
    );
  }
  return entry.name;
}

export interface ParseTeamOptions {
  requireFullTeam?: boolean;
  allowIncompleteSets?: boolean;
}

export function parseShowdownTeam(
  sourceText: string,
  profile: RegulationProfile,
  options: ParseTeamOptions = {},
): PokemonTeam {
  if (!sourceText.trim()) {
    throw new VgcError('INVALID_TEAM', 'Team export cannot be empty');
  }

  const imported = Teams.importTeam(sourceText);
  if (!imported || imported.team.length === 0) {
    throw new VgcError(
      'INVALID_TEAM',
      'Could not parse the Pokemon Showdown team export',
    );
  }

  const requireFullTeam = options.requireFullTeam ?? true;
  if (requireFullTeam && imported.team.length !== profile.teamSize) {
    throw new VgcError(
      'INVALID_TEAM',
      `Expected ${profile.teamSize} Pokemon, found ${imported.team.length}`,
    );
  }

  if (imported.team.length > profile.teamSize) {
    throw new VgcError(
      'INVALID_TEAM',
      `A ${profile.name} team cannot contain more than ${profile.teamSize} Pokemon`,
    );
  }

  const pokemon = imported.team.map((set, index): PokemonSet => {
    const context = `Pokemon ${index + 1}`;
    if (!set.species) {
      throw new VgcError('INVALID_TEAM', `${context} is missing a species`);
    }

    const species = canonicalName('species', set.species, context);
    const moves = (set.moves ?? []).map((move) =>
      canonicalName('moves', move, context),
    );
    if (!options.allowIncompleteSets && moves.length !== 4) {
      throw new VgcError(
        'INVALID_TEAM',
        `${species} must have exactly four moves for V0 analysis`,
        {moveCount: moves.length},
      );
    }
    if (moves.length > 4) {
      throw new VgcError(
        'INVALID_TEAM',
        `${species} cannot have more than four moves`,
      );
    }

    const item = set.item
      ? canonicalName('items', set.item, context)
      : undefined;
    const ability = set.ability
      ? canonicalName('abilities', set.ability, context)
      : undefined;
    const nature = canonicalName(
      'natures',
      set.nature || 'Serious',
      context,
    );
    const skillPoints = copyStats(set.evs, 0);
    for (const [stat, value] of Object.entries(skillPoints)) {
      if (!Number.isInteger(value) || value < 0 || value > 32) {
        throw new VgcError(
          'INVALID_TEAM',
          `${species} has an invalid ${stat} skill-point value; Champions allows 0-32 per stat`,
          {value},
        );
      }
    }
    const totalSkillPoints = Object.values(skillPoints).reduce(
      (total, value) => total + (value ?? 0),
      0,
    );
    if (totalSkillPoints > 66) {
      throw new VgcError(
        'INVALID_TEAM',
        `${species} has ${totalSkillPoints} total skill points; Champions allows at most 66`,
      );
    }

    return {
      species,
      ...(set.name ? {nickname: set.name} : {}),
      ...(item ? {item} : {}),
      ...(ability ? {ability} : {}),
      nature,
      moves,
      skillPoints,
      ivs: copyStats(set.ivs, 31),
      level: profile.level,
      ...(set.gender ? {gender: set.gender} : {}),
      ...(set.shiny ? {shiny: true} : {}),
      provenance: {
        species: {knowledge: 'known', confidence: 1, source: 'user-team'},
        item: {
          knowledge: item ? 'known' : 'unknown',
          confidence: item ? 1 : 0,
          source: 'user-team',
        },
        ability: {
          knowledge: ability ? 'known' : 'unknown',
          confidence: ability ? 1 : 0,
          source: 'user-team',
        },
        nature: {knowledge: 'known', confidence: 1, source: 'user-team'},
        moves: {knowledge: 'known', confidence: 1, source: 'user-team'},
        skillPoints: {
          knowledge: set.evs ? 'known' : 'unknown',
          confidence: set.evs ? 1 : 0,
          source: 'user-team',
        },
      },
    };
  });

  const duplicate = pokemon.find(
    (set, index) =>
      pokemon.findIndex((candidate) => candidate.species === set.species) !==
      index,
  );
  if (duplicate) {
    throw new VgcError(
      'INVALID_TEAM',
      `Species Clause violation: ${duplicate.species} appears more than once`,
    );
  }

  return {
    ...(imported.format ? {format: imported.format} : {}),
    ...(imported.name ? {name: imported.name} : {}),
    pokemon,
    sourceText,
  };
}

export function parsePartialShowdownTeam(
  sourceText: string,
  profile: RegulationProfile,
): PokemonTeam {
  return parseShowdownTeam(sourceText, profile, {
    requireFullTeam: false,
    allowIncompleteSets: true,
  });
}
