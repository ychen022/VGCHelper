import {calculateChampionsDamage, hitsAllAdjacent, isDamagingMove, isSpreadMove} from '../../calc/champions.js';
import type {BattleState, DamageRequest, MetaTeam, PokemonBattleState, PokemonPosition, PokemonSet, PokemonTeam, ReplayFinding} from '../../domain/contracts.js';
import {buildOpponentHypotheses} from '../../meta/inference/hypotheses.js';

const base = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/mega(?:x|y|z)?$/, '');
export function position(pokemon: PokemonBattleState, state: BattleState): PokemonPosition {
  const boosts = Object.fromEntries(Object.entries(pokemon.boosts).filter(([key]) => key !== 'accuracy' && key !== 'evasion'));
  return {
    ...(pokemon.species ? {species: pokemon.species} : {}), boosts,
    ...(pokemon.hpPercent !== undefined ? {hpPercent: pokemon.hpPercent} : {}),
    ...(pokemon.status ? {status: pokemon.status} : {}),
    ...(pokemon.itemConsumed || pokemon.itemRemoved ? {item: ''} : pokemon.item ? {item: pokemon.item} : {}),
    ...(pokemon.ability ? {ability: pokemon.ability} : {}),
    alliesFainted: Object.values(state.sides[pokemon.side].pokemon).filter(p => p.fainted).length,
  };
}

export function knownBefore(state: BattleState): string[] {
  return [
    `Field: ${state.field.weather ?? 'no weather'}, ${state.field.terrain ?? 'no terrain'}${state.field.trickRoomTurns ? ', Trick Room active' : ''}.`,
    ...Object.entries(state.sides).flatMap(([side, data]) => [
      `${side} conditions: ${(data.conditions ?? []).join(', ') || 'none revealed'}.`,
      ...Object.values(data.pokemon).filter(p => p.active).map(p => `${p.slot}: ${p.species ?? p.nickname}; HP ${p.hpPercent ?? '?'}%${p.hp && !p.hp.exact ? ' (rounded)' : ''}; status ${p.status ?? 'none'}; boosts ${JSON.stringify(p.boosts)}; item ${p.itemConsumed || p.itemRemoved ? 'no longer held' : p.item ?? 'unknown'}; ability ${p.ability ?? 'unknown'}; known moves ${p.moves.join(', ') || 'none'}.`),
    ]),
  ];
}

function targetSets(target: PokemonBattleState, state: BattleState, meta: MetaTeam[]): Array<{set: PokemonSet; label: string}> {
  const sheet = state.sides[target.side].teamSheet?.find(s => base(s.species) === base(target.species ?? ''));
  const sampled = buildOpponentHypotheses(target, meta).filter(h => h.compatible && (!sheet?.nature || h.set.nature === sheet.nature)).slice(0, 3)
    .map(h => ({set: h.set, label: `sampled set ${h.id}, confidence heuristic ${h.confidence.toFixed(2)}`}));
  if (sampled.length) return sampled;
  if (!sheet) return [];
  return [
    {set: {...sheet, skillPoints: {}}, label: 'open sheet; 0 defensive points sensitivity baseline (not inferred spread)'},
    {set: {...sheet, skillPoints: {hp: 32, def: 32}}, label: 'open sheet; 32 HP / 32 Def sensitivity scenario'},
    {set: {...sheet, skillPoints: {hp: 32, spd: 32}}, label: 'open sheet; 32 HP / 32 SpD sensitivity scenario'},
  ];
}

export function replayAlternatives(state: BattleState, actor: PokemonBattleState, set: PokemonSet, team: PokemonTeam, meta: MetaTeam[], actual?: string): ReplayFinding['alternatives'] {
  const opponentSide = actor.side === 'p1' ? 'p2' : 'p1';
  const opponents = Object.values(state.sides[opponentSide].pokemon).filter(p => p.active && !p.fainted);
  const partner = Object.values(state.sides[actor.side].pokemon).find(p => p.active && !p.fainted && p.nickname !== actor.nickname);
  const partnerSet = team.pokemon.find(s => base(s.species) === base(partner?.species ?? ''));
  const partnerPlan = partnerSet?.moves.find(m => ['Tailwind', 'Trick Room', 'Follow Me', 'Rage Powder', 'Fake Out'].includes(m));
  const partnerText = partner ? `${partner.species ?? partner.nickname}: ${partnerPlan ? `consider ${partnerPlan}` : 'maintain pressure on the other slot'}` : 'no active partner';
  const alternatives: ReplayFinding['alternatives'] = [];
  if (set.moves.includes('Protect') && actual !== 'Protect') alternatives.push({
    action: `${set.species} -> Protect; ${partnerText}`,
    rationale: 'Review preserving this slot while its partner advances the board. Opponent response: attack the partner or use setup. Availability depends on PP, choice lock, Taunt and consecutive Protect; a faint alone does not establish a mistake.',
  });
  const ownBench = Object.values(state.sides[actor.side].pokemon).filter(p => !p.active && !p.fainted && p.species);
  if (ownBench[0]) alternatives.push({action: `${set.species} -> switch to ${ownBench[0].species}; ${partnerText}`,
    rationale: 'This bench Pokémon was already revealed as brought. Review incoming attacks into the switch and the partner; trapping and switch timing require inspection. Unrevealed members of the six are not assumed to have been brought.'});

  const calculated: Array<ReplayFinding['alternatives'][number] & {pressure: number}> = [];
  for (const target of opponents) {
    const candidates = targetSets(target, state, meta);
    for (const move of set.moves.filter(m => m !== actual && isDamagingMove(m))) {
      for (const candidate of candidates) {
        const side = state.sides[opponentSide];
        const field: NonNullable<DamageRequest['field']> = {
          ...state.field,
          isReflect: side.conditions?.includes('Reflect') ?? Boolean(side.reflectTurns),
          isLightScreen: side.conditions?.includes('Light Screen') ?? Boolean(side.lightScreenTurns),
          isAuroraVeil: side.conditions?.includes('Aurora Veil') ?? Boolean(side.auroraVeilTurns),
          isGravity: Boolean(state.field.gravityTurns),
          attackerTailwind: Boolean(state.sides[actor.side].tailwindTurns),
          defenderTailwind: Boolean(side.tailwindTurns),
          isFriendGuard: opponents.some(p => p !== target && p.ability === 'Friend Guard'),
          // allAdjacent attacks can also hit a partner, so only remove the spread penalty if the whole board has one target.
          singleTarget: opponents.length === 1 && (!hitsAllAdjacent(move) || !partner),
        };
        try {
          const damage = calculateChampionsDamage({attacker: set, defender: candidate.set, move, attackerPosition: position(actor, state), defenderPosition: position(target, state), field});
          calculated.push({action: `${set.species} -> ${move} targeting ${target.species}; ${partnerText}`,
            rationale: `${candidate.label}. Compare both slots' choices. Opponent response: ${candidate.set.moves.includes('Protect') ? 'Protect this target or pressure the partner' : 'switch this target or attack before this move'}. Damage assumes the attack executes; speed, redirection, accuracy and survival are not resolved${isSpreadMove(move) ? '; review spread hits and partner damage separately' : ''}.`,
            damage, pressure: damage.percentRange[0]});
        } catch {
          // One unsupported scenario must not erase all replay evidence.
          alternatives.push({action: `${set.species} -> ${move} into ${target.species}`, rationale: 'This scenario could not be calculated with the available set/state. Inspect it manually; no damage claim is made.'});
        }
      }
    }
  }
  // Preserve alternatives against both opposing slots before adding set sensitivities.
  const selected: typeof calculated = [];
  for (const target of opponents) {
    const best = calculated.filter(c => c.action.includes(`targeting ${target.species};`)).sort((a,b)=>b.pressure-a.pressure)[0];
    if (best) selected.push(best);
  }
  for (const entry of calculated.sort((a,b)=>b.pressure-a.pressure)) {
    if (selected.length >= 4) break;
    if (!selected.includes(entry)) selected.push(entry);
  }
  alternatives.push(...selected.map(({pressure: _pressure, ...entry}) => entry));
  return alternatives.slice(0, 6);
}
