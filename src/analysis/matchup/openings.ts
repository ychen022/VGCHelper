import {Generations, toID} from '@smogon/calc';
import {hitsAllAdjacent, isDamagingMove, isSpreadMove, movePriority} from '../../calc/champions.js';
import type {DamageResult, PokemonSet} from '../../domain/contracts.js';
import {battleDamage, battleSpeed, buildBattleState, type BattlePokemon} from './positions.js';

export interface OpeningAction {
  actor: string;
  move: string;
  kind: 'attack' | 'protect' | 'fake-out' | 'speed-control' | 'redirection' | 'support';
  target?: string;
}

export interface OpeningScenario {
  opponentTeamId: string;
  userMega: string | null;
  opponentMega: string | null;
  userActions: OpeningAction[];
  opponentActions: OpeningAction[];
  setScenario: {id: string; user: PokemonSet[]; opponent: PokemonSet[]};
  damage: OpeningDamage[];
  speedEvidence: Array<{side: 'user' | 'opponent'; species: string; speed: number}>;
  support: string[];
  assumptions: string[];
  limitations: string[];
}

export interface OpeningDamage extends DamageResult {
  attackerSide: 'user' | 'opponent';
  targetSide: 'user' | 'opponent';
  targetRelation: 'ally' | 'opponent';
}

const SPEED = new Set(['Tailwind', 'Trick Room', 'Icy Wind', 'Electroweb']);
const REDIRECTION = new Set(['Follow Me', 'Rage Powder']);
export const SUPPORT_MOVES = new Set(['Protect', 'Detect', 'Fake Out', ...SPEED, ...REDIRECTION, 'Wide Guard', 'Taunt', 'Encore',
  'Helping Hand', 'Haze', 'Destiny Bond']);

export function uncertainSpread(set: PokemonSet): boolean {
  return set.provenance?.skillPoints?.knowledge === 'unknown' ||
    set.provenance?.skillPoints?.knowledge === 'inferred' ||
    (set.provenance?.skillPoints?.knowledge !== 'known' && Object.keys(set.skillPoints).length === 0);
}

function action(set: PokemonSet, move: string, target?: string): OpeningAction {
  const kind = move === 'Protect' || move === 'Detect' ? 'protect'
    : move === 'Fake Out' ? 'fake-out'
      : SPEED.has(move) ? 'speed-control'
        : REDIRECTION.has(move) ? 'redirection'
          : isDamagingMove(move) ? 'attack' : 'support';
  return {actor: set.species, move, kind, ...(target ? {target} : {})};
}

// Six joint templates per side: baseline pressure plus support with a partner action.
// This is deliberately a small response menu, not an exhaustive battle-tree search.
function jointPlans(sets: BattlePokemon[], foes: BattlePokemon[], weather?: string): OpeningAction[][] {
  const baseline = sets.map(set => {
    const choices = set.moves.filter(move => isDamagingMove(move) && move !== 'Fake Out')
      .flatMap(move => foes.map(foe => ({move, foe, result: battleDamage(set, foe, move, weather)})))
      .sort((a, b) => b.result.percentRange[1] - a.result.percentRange[1]);
    const best = choices[0];
    const fallback = set.moves[0]!;
    return best ? action(set, best.move, best.foe.species)
      : action(set, fallback, ['Fake Out', 'Taunt', 'Encore'].includes(fallback) ? foes[0]!.species : undefined);
  });
  const result = [baseline];
  const supports = sets.flatMap((set, index) => set.moves.filter(move => SUPPORT_MOVES.has(move))
    .map(move => ({set, index, move})));
  // Reserve the support hypotheses before repeated Protect/redirection templates can exhaust the menu.
  supports.sort((a, b) => {
    const rank = (move: string) => ['Helping Hand', 'Haze', 'Destiny Bond'].includes(move) ? 0
      : move === 'Fake Out' ? 1 : SPEED.has(move) ? 2 : REDIRECTION.has(move) ? 3 : 4;
    return rank(a.move) - rank(b.move);
  });
  const seenMoves = new Set<string>();
  const diverse = supports.filter(entry => {
    if (seenMoves.has(entry.move)) return false;
    seenMoves.add(entry.move);
    return true;
  });
  const seenPlans = new Set([JSON.stringify(baseline)]);
  for (const {set, index, move} of [...diverse, ...supports]) {
    if (result.length >= 6) break;
    const plan = [...baseline];
    plan[index] = action(set, move, move === 'Helping Hand' ? sets.find(partner => partner !== set)?.species
      : ['Fake Out', 'Taunt', 'Encore', 'Icy Wind', 'Electroweb'].includes(move) ? foes[0]!.species : undefined);
    const key = JSON.stringify(plan);
    if (seenPlans.has(key)) continue;
    seenPlans.add(key);
    result.push(plan);
  }
  // A second damage target is useful when neither lead offers support options.
  if (foes.length > 1 && result.length === 1 && baseline[0]?.kind === 'attack' && !isSpreadMove(baseline[0].move)) {
    const alternative = {...baseline[0], target: foes.find(set => set.species !== baseline[0]!.target)!.species};
    result.push([alternative, ...baseline.slice(1)]);
  }
  return result;
}

interface TimedAction {selected: OpeningAction; actor: BattlePokemon}

function priority(entry: TimedAction): number {
  return movePriority(entry.selected.move) + (entry.actor.position.ability === 'Prankster' && !isDamagingMove(entry.selected.move) ? 1 : 0);
}

function before(left: TimedAction, right: TimedAction): boolean {
  return priority(left) > priority(right) || (priority(left) === priority(right) && battleSpeed(left.actor) > battleSpeed(right.actor));
}

function conditionalDamage(
  actions: OpeningAction[], responses: OpeningAction[], attackers: BattlePokemon[], defenders: BattlePokemon[],
  attackerSide: OpeningDamage['attackerSide'], weather?: string,
): OpeningDamage[] {
  const timed = [...actions.map(selected => ({selected, actor: attackers.find(set => set.species === selected.actor)!})),
    ...responses.map(selected => ({selected, actor: defenders.find(set => set.species === selected.actor)!}))];
  return actions.flatMap(selected => {
    if (!isDamagingMove(selected.move)) return [];
    const attacker = attackers.find(set => set.species === selected.actor)!;
    const attack = {selected, actor: attacker};
    const hazeBefore = timed.some(entry => entry.selected.move === 'Haze' && before(entry, attack));
    const helpingHand = actions.some(help => help.move === 'Helping Hand' && help.actor !== selected.actor &&
      before({selected: help, actor: attackers.find(set => set.species === help.actor)!}, attack));
    const opposingTargets = isSpreadMove(selected.move) ? defenders : defenders.filter(set => set.species === selected.target);
    const targets = [
      ...opposingTargets.map(defender => ({defender, targetRelation: 'opponent' as const})),
      ...(hitsAllAdjacent(selected.move) ? attackers.filter(ally => ally !== attacker)
        .map(defender => ({defender, targetRelation: 'ally' as const})) : []),
    ];
    return targets.flatMap(({defender, targetRelation}) => {
      const targetActions = targetRelation === 'ally' ? actions : responses;
      if (targetActions.some(response => response.actor === defender.species && response.kind === 'protect')) return [];
      const clearBoosts = (set: BattlePokemon): BattlePokemon => ({...set, position: {...set.position, boosts: {}}});
      const damage = battleDamage(hazeBefore ? clearBoosts(attacker) : attacker, hazeBefore ? clearBoosts(defender) : defender,
        selected.move, weather, {isHelpingHand: helpingHand});
      if (hazeBefore) damage.assumptions.push('An earlier selected Haze is conditional on its actor executing; it resets both positive and negative entry stat stages before this hit.');
      if (helpingHand) damage.assumptions.push('The selected partner Helping Hand must execute before this hit; its damage modifier is applied.');
      if (targetRelation === 'ally') damage.assumptions.push(`Friendly fire: ${attacker.species} ${selected.move} also targets ally ${defender.species}; this is a separate conditional hit, not opposing pressure.`);
      return [{...damage, attackerSide, targetRelation,
        targetSide: targetRelation === 'ally' ? attackerSide : attackerSide === 'user' ? 'opponent' as const : 'user' as const}];
    });
  });
}

export function buildOpeningScenarios(user: PokemonSet[], opponent: PokemonSet[], opponentTeamId: string, userMega: string|null=null, opponentMega: string|null=null): OpeningScenario[] {
  const variants = [{id: 'source-baseline', user: structuredClone(user), opponent: structuredClone(opponent)}];
  if ([...user, ...opponent].some(uncertainSpread)) {
    const bulk = (sets: PokemonSet[]) => sets.map(set => uncertainSpread(set)
      ? {...structuredClone(set), skillPoints: {hp: 32, def: 32, spd: 2}} : structuredClone(set));
    variants.push({id: 'bulk-sensitivity', user: bulk(user), opponent: bulk(opponent)});
  }
  return variants.flatMap(setScenario => {
    const battle = buildBattleState(setScenario.user, setScenario.opponent, userMega, opponentMega);
    const userPlans = jointPlans(battle.user, battle.opponent, battle.weather);
    const opponentPlans = jointPlans(battle.opponent, battle.user, battle.weather);
    return userPlans.flatMap(userActions => opponentPlans.map(opponentActions => {
      const support: string[] = [];
      const assumptions = [
        'Conditional opening from full HP with no prior setup; both leads are on their first active turn. Entry abilities and the selected Mega are applied.',
        'Damage lines are individual potential hits conditional on the actor executing its move, not a resolved joint-turn total.',
        'Protect is assumed to succeed and block ordinary incoming damage; bypass interactions require separate review.',
        ...battle.notes,
        ...(battle.weather ? [`Entry and selected Mega abilities establish ${battle.weather}; weather-dependent damage uses that field.`] : []),
      ];
      for (const [actions, foes, allies, opposing] of [
        [userActions, opponentActions, battle.user, battle.opponent],
        [opponentActions, userActions, battle.opponent, battle.user],
      ] as const) {
        for (const selected of actions) {
          const actor = allies.find(set => set.species === selected.actor)!;
          if (selected.kind === 'fake-out') {
            const target = opposing.find(set => set.species === selected.target)!;
            const response = foes.find(entry => entry.actor === target.species)!;
            const earlier = before({selected, actor}, {selected: response, actor: target});
            support.push(`${actor.species} Fake Out targets ${target.species}: ${target.protectedByArmorTail ? 'blocked by Armor Tail or an equivalent ally priority-blocking ability' : earlier && response.kind !== 'protect' ? 'may deny its action if it connects and flinch is permitted' : 'does not establish action denial before the selected response'}.`);
            assumptions.push('Fake Out denial is conditional on immunity, terrain, ability, item, priority and redirection checks; damage lines do not assume the target flinched.');
          } else if (selected.kind === 'speed-control') {
            support.push(`${selected.actor} ${selected.move} trades immediate pressure for speed control if it resolves; assess its partner against interruption and opposing control.`);
            if (selected.move === 'Trick Room') support.push(`${selected.actor} Trick Room has base priority -7; it normally resolves after ordinary attacks and cannot retroactively protect its setter. Prankster, if active, raises it to -6.`);
          } else if (selected.kind === 'redirection') {
            support.push(`${selected.actor} ${selected.move} can cover its partner from eligible single-target moves; spread moves and bypass interactions still threaten the partner.`);
          } else if (selected.kind === 'protect') {
            support.push(`${selected.actor} ${selected.move} covers that slot while its partner takes the other joint action; the opponent can target the partner or set up.`);
          } else if (selected.move === 'Helping Hand') {
            support.push(`${selected.actor} Helping Hand increases its partner's conditional damage when the partner attacks after it; the calculator applies the modifier, conditional on both actions executing.`);
          } else if (selected.move === 'Haze') {
            support.push(`${selected.actor} Haze conditionally clears all positive and negative stat stages before slower hits in the same priority bracket. This also removes its own side's Competitive, Defiant or Contrary gains as well as Intimidate drops; faster hits retain their entry stages.`);
            assumptions.push('Haze ordering uses action priority and entry Speed. Equal-priority Speed ties retain entry stages in displayed damage; the unresolved alternate order requires a separate branch.');
          } else if (selected.move === 'Destiny Bond') {
            support.push(`${selected.actor} Destiny Bond is conditional: it must resolve before a direct opposing attack causes the user's KO and remain active until that hit. An opponent may avoid attacking or target the partner; repeated-use failure and move timing require separate verification. No revenge KO is assumed.`);
          } else if (selected.move === 'Taunt' || selected.move === 'Encore') {
            const target = opposing.find(set => set.species === selected.target);
            const prankster = actor.position.ability === 'Prankster';
            const dark = target && Generations.get(0).species.get(toID(target.position.species ?? target.species))?.types.includes('Dark');
            support.push(`${selected.actor} ${selected.move} targets ${selected.target}: ${prankster && target?.protectedByArmorTail ? 'its Prankster priority is blocked by Armor Tail or an equivalent ally ability' : prankster && dark ? 'Prankster-boosted opposing status targeting fails into a Dark type' : 'conditional disruption only; timing, prior moves, immunity and move failure are not simulated'}.`);
          } else if (selected.move === 'Wide Guard') {
            support.push(`${selected.actor} Wide Guard may block eligible spread moves if it resolves; this interaction remains unmodeled in the displayed damage.`);
          }
        }
      }
      const uncertain = [...user, ...opponent].filter(uncertainSpread);
      if (uncertain.length) assumptions.push(`${setScenario.id}: ${uncertain.map(set => set.species).join(', ')} have unconfirmed spreads. ${setScenario.id === 'bulk-sensitivity' ? 'Uses a legal 32 HP / 32 Def / 2 SpD sensitivity spread, not a predicted set.' : 'Uses source/default spread assumptions, not confirmed opponent investment.'}`);
      const damage = [
        ...conditionalDamage(userActions, opponentActions, battle.user, battle.opponent, 'user', battle.weather),
        ...conditionalDamage(opponentActions, userActions, battle.opponent, battle.user, 'opponent', battle.weather),
      ];
      for (const hit of damage.filter(hit => hit.targetRelation === 'ally')) {
        support.push(`${hit.attackerSide} ${hit.inputs!.attacker.species} ${hit.move} also targets ally ${hit.inputs!.defender.species}: ${hit.percentRange[0]}–${hit.percentRange[1]}% conditional friendly-fire damage. Partner positioning, immunity or Protect determines this cost.`);
      }
      return {
        opponentTeamId, userMega, opponentMega, userActions, opponentActions, setScenario,
        damage,
        speedEvidence: [...battle.user.map(set => ({side: 'user' as const, species: set.species, speed: battleSpeed(set)})),
          ...battle.opponent.map(set => ({side: 'opponent' as const, species: set.species, speed: battleSpeed(set)}))],
        support, assumptions,
        limitations: [
          'Bounded support templates, not exact turn simulation or calibrated win probabilities; conditional damage is not summed or ranked as a battle outcome.',
          'All-adjacent attacks include separately side-labeled ally hits and their costs. They are not opposing pressure; each actor-target hit is listed once per selected action.',
          'No switch search, residual damage, joint KO suppression, shared RNG, target redirection, or dynamic same-turn speed/control resolution.',
          'Fake Out action denial, speed control and redirection are evidence only. Armor Tail damaging-priority blocking is calculated; targeted Prankster/Dark status failures are identified, while other ability, terrain, item, Protect bypass and control interactions need verification.',
          'Helping Hand and earlier Haze modify conditional hits; action denial, KO before support execution, and Haze Speed ties are not resolved. Destiny Bond does not receive a guaranteed KO or score bonus.',
          'The six-template menu prioritizes distinct support moves including Helping Hand, Haze and Destiny Bond; excess support options and targets can be omitted.',
          'Unknown spread sensitivity is illustrative, not exhaustive; source moves, items, abilities and known spreads remain unchanged.',
        ],
      };
    }));
  });
}
