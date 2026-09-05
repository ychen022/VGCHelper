import {Teams} from '@pkmn/sets';
import {Generations, toID} from '@smogon/calc';
import type {PokemonSet} from '../domain/contracts.js';
import {VgcError} from '../errors.js';

const gen = Generations.get(0);
export function readOpenSheet(packed: string): PokemonSet[] {
  const unpacked = Teams.unpackTeam(packed);
  if (!unpacked?.team.length || unpacked.team.length > 6) throw new VgcError('INVALID_REPLAY', 'Malformed open team sheet');
  return unpacked.team.map(set => {
    const known = {knowledge: 'known' as const, confidence: 1, source: 'open-team-sheet', observedAtTurn: 0};
    return {
      species: gen.species.get(toID(set.species))?.name ?? set.species,
      item: gen.items.get(toID(set.item))?.name ?? set.item,
      ability: gen.abilities.get(toID(set.ability))?.name ?? set.ability,
      ...(set.nature ? {nature: set.nature} : {}),
      moves: set.moves.map(move => gen.moves.get(toID(move))?.name ?? move),
      level: set.level || 50, skillPoints: {}, ivs: {},
      provenance: {species: known, item: known, ability: known, moves: known,
        ...(set.nature ? {nature: known} : {}),
        skillPoints: {knowledge: 'unknown', confidence: 0, source: 'not-in-open-team-sheet'}},
    };
  });
}
