import type {
  LeadMatchup,
  LeadPair,
  MetaTeam,
  MetaUsageRow,
  PokemonSet,
  PokemonTeam,
  SourceReference,
  TeamEvaluation,
  EvaluationContext,
} from '../../domain/contracts.js';
import {
  isDamagingMove,
  isSpreadMove,
  movePriority,
} from '../../calc/champions.js';
import {VgcError} from '../../errors.js';
import {hydrateMetaTeam} from '../../meta/inference/hypotheses.js';
import type {RegulationProfile} from '../../regulation/profile.js';
import {newId} from '../../util/hash.js';
import {buildTeamGuidance, type TeamGuidance} from './guidance.js';
import {battleDamage, battleMaxHp, battleSpeed, buildBattleState, megaChoices, type BattlePokemon} from './positions.js';
import {selectCohort, type CohortCoverage} from './cohort.js';
import {validateEvaluationContext} from './context.js';
import type {EvaluationComparison} from './compare-evaluations.js';

const CONTROL_MOVES = new Set([
  'Tailwind',
  'Trick Room',
  'Fake Out',
  'Follow Me',
  'Rage Powder',
  'Wide Guard',
  'Encore',
  'Taunt',
  'Icy Wind',
  'Electroweb',
]);

export function generateLeadPairs(team: PokemonTeam | MetaTeam): LeadPair[] {
  const species =
    'pokemon' in team && team.pokemon.length
      ? team.pokemon.map((set) => set.species)
      : (team as MetaTeam).roster;
  const pairs: LeadPair[] = [];
  for (let first = 0; first < species.length; first += 1) {
    for (let second = first + 1; second < species.length; second += 1) {
      const firstSpecies = species[first];
      const secondSpecies = species[second];
      if (firstSpecies && secondSpecies) {
        pairs.push({first: firstSpecies, second: secondSpecies});
      }
    }
  }
  return pairs;
}

function placementValue(value?: string): number {
  if (!value) return 0;
  if (/champion|winner|1st/i.test(value)) return 5;
  if (/runner|2nd/i.test(value)) return 4;
  if (/top 4|3rd|4th/i.test(value)) return 3;
  if (/top 8|[5-8](?:th|st|nd|rd)/i.test(value)) return 2;
  if (/top 16/i.test(value)) return 1;
  return 0;
}

export function selectRepresentativeTeams(
  teams: MetaTeam[],
  maximum: number,
): MetaTeam[] {
  const distinct = new Map<string, MetaTeam>();
  const timestamp = (value?: string): number => {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  for (const team of [...teams].sort((left, right) => {
    const dateOrder = timestamp(right.date) - timestamp(left.date);
    return dateOrder || placementValue(right.placement) - placementValue(left.placement) || left.id.localeCompare(right.id);
  })) {
    const key = [...team.roster].sort().join('|').toLowerCase();
    if (!distinct.has(key)) distinct.set(key, team);
  }
  return [...distinct.values()].slice(0, maximum);
}

function findSet(team: PokemonSet[], species: string): PokemonSet | undefined {
  return team.find((set) => set.species === species);
}

function controlScore(lead: PokemonSet[]): number {
  return lead.reduce(
    (total, set) =>
      total + set.moves.filter((move) => CONTROL_MOVES.has(move)).length * 4,
    0,
  );
}

type CalculatedDamage = ReturnType<typeof battleDamage>;

interface DamageOption {
  attackerIndex: number;
  move: string;
  priority: number;
  hits: Array<{defenderIndex: number; result: CalculatedDamage}>;
}

interface DamagePressure {
  average: number;
  rawAverage: number;
  preemptionRisk: number;
  results: CalculatedDamage[];
}

interface DamageOutcome {
  damage: number;
  probability: number;
}

interface PlanOutcome {
  outgoing: DamagePressure;
  incoming: DamagePressure;
  userPlan: DamageOption[];
  opponentPlan: DamageOption[];
}

function average(values: number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function damageOptions(
  attackers: BattlePokemon[],
  defenders: BattlePokemon[],
  weather?: string,
): DamageOption[] {
  const options: DamageOption[] = [];
  for (const [attackerIndex, attacker] of attackers.entries()) {
    for (const move of attacker.moves) {
      if (!isDamagingMove(move)) continue;
      const priority = movePriority(move);
      if (isSpreadMove(move)) {
        options.push({
          attackerIndex,
          move,
          priority,
          hits: defenders.map((defender, defenderIndex) => ({
            defenderIndex,
            result: battleDamage(attacker, defender, move, weather),
          })),
        });
        continue;
      }
      for (const [defenderIndex, defender] of defenders.entries()) {
        options.push({
          attackerIndex,
          move,
          priority,
          hits: [{
            defenderIndex,
            result: battleDamage(attacker, defender, move, weather),
          }],
        });
      }
    }
  }
  const strongest = new Map<string, DamageOption>();
  for (const option of options) {
    const targets = option.hits.map((hit) => hit.defenderIndex).join(',');
    const key = `${option.attackerIndex}|${option.priority}|${targets}`;
    const pressure = average(
      option.hits.map((hit) => hit.result.percentRange[1]),
    );
    const current = strongest.get(key);
    const currentPressure = current
      ? average(current.hits.map((hit) => hit.result.percentRange[1]))
      : -1;
    if (pressure > currentPressure) strongest.set(key, option);
  }
  return [...strongest.values()];
}

function plans(
  options: DamageOption[],
  attackerCount: number,
): DamageOption[][] {
  let result: DamageOption[][] = [[]];
  for (let attackerIndex = 0; attackerIndex < attackerCount; attackerIndex += 1) {
    const choices = options.filter(
      (option) => option.attackerIndex === attackerIndex,
    );
    if (choices.length === 0) continue;
    result = result.flatMap((plan) =>
      choices.map((choice) => [...plan, choice]),
    );
  }
  return result;
}

function compareActionOrder(
  leftPriority: number,
  leftSpeed: number,
  rightPriority: number,
  rightSpeed: number,
): number {
  if (leftPriority !== rightPriority) {
    return leftPriority > rightPriority ? 1 : -1;
  }
  if (leftSpeed !== rightSpeed) {
    return leftSpeed > rightSpeed ? 1 : -1;
  }
  return 0;
}

function moveOutcomes(
  result: CalculatedDamage,
  occursBefore: number,
): DamageOutcome[] {
  const distribution = result.damageDistribution ?? result.damage.map(damage => ({
    damage, probability: 1 / result.damage.length,
  }));
  const outcomes = distribution.map(({damage, probability}) => ({
    damage, probability: occursBefore * probability,
  }));
  if (occursBefore < 1) {
    outcomes.push({damage: 0, probability: 1 - occursBefore});
  }
  return outcomes;
}

function knockoutProbability(
  hits: Array<{result: CalculatedDamage; occursBefore: number}>,
  maxHp: number,
): number {
  let totals: DamageOutcome[] = [{damage: 0, probability: 1}];
  for (const {result, occursBefore} of hits) {
    const outcomes = moveOutcomes(result, occursBefore);
    totals = totals.flatMap((total) =>
      outcomes.map((outcome) => ({
        damage: total.damage + outcome.damage,
        probability: total.probability * outcome.probability,
      })),
    );
  }
  return totals
    .filter((outcome) => outcome.damage >= maxHp)
    .reduce((sum, outcome) => sum + outcome.probability, 0);
}

interface PlannedAction {
  side: 'user' | 'opponent';
  option: DamageOption;
  actor: BattlePokemon;
  speed: number;
  survival: number;
}

function calculateSurvival(actions: PlannedAction[]): void {
  const ordered = [...actions].sort((left, right) =>
    compareActionOrder(
      right.option.priority,
      right.speed,
      left.option.priority,
      left.speed,
    ),
  );
  for (const action of ordered) {
    const opposingHits: Array<{
      result: CalculatedDamage;
      occursBefore: number;
    }> = [];
    for (const opposing of actions) {
      if (opposing.side === action.side) continue;
      const hit = opposing.option.hits.find(
        (candidate) =>
          candidate.defenderIndex === action.option.attackerIndex,
      );
      if (!hit) continue;
      const order = compareActionOrder(
        opposing.option.priority,
        opposing.speed,
        action.option.priority,
        action.speed,
      );
      if (order < 0) continue;
      opposingHits.push({
        result: hit.result,
        occursBefore: opposing.survival * (order === 0 ? 0.5 : 1),
      });
    }
    action.survival =
      1 - knockoutProbability(opposingHits, battleMaxHp(action.actor));
  }
}

function pressure(
  actions: PlannedAction[],
  side: PlannedAction['side'],
  defenderCount: number,
): DamagePressure {
  const selected = actions.filter((action) => action.side === side);
  const raw = selected.flatMap((action) =>
    action.option.hits.map((hit) => hit.result.percentRange[1]),
  );
  const adjusted = selected.flatMap((action) =>
    action.option.hits.map(
      (hit) => hit.result.percentRange[1] * action.survival,
    ),
  );
  return {
    average: adjusted.reduce((sum, value) => sum + value, 0) / defenderCount,
    rawAverage: raw.reduce((sum, value) => sum + value, 0) / defenderCount,
    preemptionRisk: average(
      selected.map((action) => 1 - action.survival),
    ),
    results: selected.flatMap((action) =>
      action.option.hits.map((hit) => hit.result),
    ),
  };
}

function evaluatePlanPair(
  user: BattlePokemon[],
  opponent: BattlePokemon[],
  userPlan: DamageOption[],
  opponentPlan: DamageOption[],
): PlanOutcome {
  const actions: PlannedAction[] = [
    ...userPlan.map((option) => ({
      side: 'user' as const,
      option,
      actor: user[option.attackerIndex]!,
      speed: battleSpeed(user[option.attackerIndex]!),
      survival: 1,
    })),
    ...opponentPlan.map((option) => ({
      side: 'opponent' as const,
      option,
      actor: opponent[option.attackerIndex]!,
      speed: battleSpeed(opponent[option.attackerIndex]!),
      survival: 1,
    })),
  ];
  calculateSurvival(actions);
  return {
    outgoing: pressure(actions, 'user', opponent.length),
    incoming: pressure(actions, 'opponent', user.length),
    userPlan,
    opponentPlan,
  };
}

function planScore(outcome: PlanOutcome): number {
  return outcome.outgoing.average - outcome.incoming.average;
}

function selectPlanOutcome(
  user: BattlePokemon[],
  opponent: BattlePokemon[],
  outgoingOptions: DamageOption[],
  incomingOptions: DamageOption[],
): PlanOutcome {
  const userPlans = plans(outgoingOptions, user.length);
  const opponentPlans = plans(incomingOptions, opponent.length);
  let selected: PlanOutcome | undefined;
  for (const userPlan of userPlans) {
    let worstResponse: PlanOutcome | undefined;
    for (const opponentPlan of opponentPlans) {
      const outcome = evaluatePlanPair(
        user,
        opponent,
        userPlan,
        opponentPlan,
      );
      if (
        !worstResponse ||
        planScore(outcome) < planScore(worstResponse)
      ) {
        worstResponse = outcome;
      }
    }
    if (
      worstResponse &&
      (!selected || planScore(worstResponse) > planScore(selected))
    ) {
      selected = worstResponse;
    }
  }
  if (!selected) {
    throw new VgcError(
      'CALCULATION_FAILED',
      'Could not construct damaging turn-one plans for both leads',
    );
  }
  return selected;
}

function describePlan(
  plan: DamageOption[],
  attackers: PokemonSet[],
  defenders: PokemonSet[],
): string {
  return plan
    .map((option) => {
      const attacker = attackers[option.attackerIndex]!.species;
      const targets = option.hits
        .map((hit) => defenders[hit.defenderIndex]!.species)
        .join(' + ');
      return `${attacker} ${option.move} -> ${targets}`;
    })
    .join('; ');
}

function matchup(
  userTeam: PokemonSet[],
  opponentTeam: MetaTeam,
  userLead: LeadPair,
  opponentLead: LeadPair,
  userMega: string|null,
  opponentMega: string|null,
): LeadMatchup {
  const userSets = [findSet(userTeam, userLead.first), findSet(userTeam, userLead.second)].filter(
    (set): set is PokemonSet => Boolean(set),
  );
  const opponentSets = [
    findSet(opponentTeam.pokemon, opponentLead.first),
    findSet(opponentTeam.pokemon, opponentLead.second),
  ].filter((set): set is PokemonSet => Boolean(set));
  if (userSets.length !== 2 || opponentSets.length !== 2) {
    throw new VgcError(
      'SOURCE_SCHEMA_CHANGED',
      `Could not resolve both sets for ${opponentTeam.name}`,
      {userLead, opponentLead},
    );
  }

  const state=buildBattleState(userSets,opponentSets,userMega,opponentMega);
  const {user,opponent}=state;
  const outgoingOptions = damageOptions(user, opponent, state.weather);
  const incomingOptions = damageOptions(opponent, user, state.weather);
  const selected = selectPlanOutcome(
    user,
    opponent,
    outgoingOptions,
    incomingOptions,
  );
  const {outgoing, incoming} = selected;
  const userSpeed = user.reduce((sum, set) => sum + battleSpeed(set), 0) / 2;
  const opponentSpeed =
    opponent.reduce((sum, set) => sum + battleSpeed(set), 0) / 2;
  const speedEdge = userSpeed === opponentSpeed ? 0 : userSpeed > opponentSpeed ? 8 : -8;
  const controlEdge = controlScore(user) - controlScore(opponent);
  const rawScore = outgoing.average - incoming.average + controlEdge;
  const score = Number(Math.max(-100, Math.min(100, rawScore)).toFixed(2));
  const notes = [
    ...state.notes,
    `Mega choices: user ${userMega ?? 'held'}; opponent ${opponentMega ?? 'held'}; weather ${state.weather ?? 'none'}.`,
    `${outgoing.average.toFixed(1)}% speed-adjusted immediate pressure (${outgoing.rawAverage.toFixed(1)}% before turn order)`,
    `${incoming.average.toFixed(1)}% speed-adjusted incoming pressure (${incoming.rawAverage.toFixed(1)}% before turn order)`,
    `${(outgoing.preemptionRisk * 100).toFixed(1)}% average user action preemption risk`,
    `modeled user actions: ${describePlan(selected.userPlan, user, opponent)}`,
    `modeled opponent response: ${describePlan(selected.opponentPlan, opponent, user)}`,
    userSpeed > opponentSpeed
      ? 'user lead is faster on average'
      : userSpeed < opponentSpeed
        ? 'opponent lead is faster on average'
        : 'average raw speed is tied',
  ];

  return {
    userLead,
    opponentLead,
    opponentTeamId: opponentTeam.id,
    userMega, opponentMega,
    score,
    features: {
      outgoingPressure: Number(outgoing.average.toFixed(2)),
      incomingPressure: Number(incoming.average.toFixed(2)),
      rawOutgoingPressure: Number(outgoing.rawAverage.toFixed(2)),
      rawIncomingPressure: Number(incoming.rawAverage.toFixed(2)),
      outgoingPreemptionRisk: Number(
        (outgoing.preemptionRisk * 100).toFixed(2),
      ),
      incomingPreemptionRisk: Number(
        (incoming.preemptionRisk * 100).toFixed(2),
      ),
      speedEdge,
      controlEdge,
    },
    notes,
    damage: [...outgoing.results, ...incoming.results],
  };
}

function aggregateLeads(
  matchups: LeadMatchup[],
): Array<{lead: LeadPair; score: number; notes: string[]}> {
  const grouped = new Map<string, {lead: LeadPair; mega:string|null; scores: number[]}>();
  for (const entry of matchups) {
    const key = `${entry.userLead.first}|${entry.userLead.second}|${entry.userMega ?? 'held'}`;
    const current = grouped.get(key) ?? {lead: entry.userLead, mega:entry.userMega??null, scores: []};
    current.scores.push(entry.score);
    grouped.set(key, current);
  }
  return [...grouped.values()].map(({lead, mega, scores}) => ({
    lead,
    score: Number(
      (scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(2),
    ),
    notes: [`Mega: ${mega??'held'}; aggregated across ${scores.length} opposing lead/Mega states; a general pressure screen, not a recommendation for every matchup`],
  }));
}

function uniqueSources(teams: MetaTeam[], usage: MetaUsageRow[]): SourceReference[] {
  const seen = new Set<string>();
  return [...teams.map((team) => team.source), ...usage.map(row => row.source)]
    .filter((source) => {
      const key = `${source.provider}|${source.sourceVersion ?? ''}|${source.retrievedAt}|${source.url ?? ''}|${source.contentHash ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export interface EvaluationResult {
  evaluation: TeamEvaluation & TeamGuidance & {context: EvaluationContext; coverage:CohortCoverage; methodologyVersion:string};
  matchups: LeadMatchup[];
  cohort: MetaTeam[];
  comparison?:EvaluationComparison;
}

export function evaluateTeam(
  userTeam: PokemonTeam,
  metaTeams: MetaTeam[],
  usageRows: MetaUsageRow[],
  profile: RegulationProfile,
  suppliedContext: EvaluationContext = {},
): EvaluationResult {
  const context=validateEvaluationContext(userTeam,suppliedContext);
  if (userTeam.pokemon.length !== profile.teamSize) {
    throw new VgcError('INVALID_TEAM', 'Team evaluation requires six Pokemon');
  }
  const matchingUsage = usageRows.filter(row => row.source.regulationId === profile.id && row.source.regulationVerified === true);
  const eligible = metaTeams
    .filter((team) => team.regulationId === profile.id &&
      (!team.source.regulationId || team.source.regulationId === profile.id) &&
      team.source.regulationVerified !== false &&
      team.roster.length === profile.teamSize && new Set(team.roster).size === profile.teamSize)
    .map((team) => hydrateMetaTeam(team, matchingUsage, profile.level))
    .filter((team) => team.pokemon.length === profile.teamSize && team.pokemon.every(set => set.moves.length > 0));
  const priorities=[...new Set([...(context.priorityThreats??[]),...(context.roles??[]).flatMap(r=>r.target?[r.target]:[]),...(context.modes??[]).flatMap(m=>m.targets??[])])];
  const selection=selectCohort(eligible,profile.evaluation.maxMetaTeams,priorities);
  const cohort = selection.teams;
  if (cohort.length === 0) {
    throw new VgcError(
      'SOURCE_UNAVAILABLE',
      'No complete representative meta teams are available; refresh meta data first',
    );
  }

  const userLeads = generateLeadPairs(userTeam);
  const matchups: LeadMatchup[] = [];
  for (const opponentTeam of cohort) {
    for (const userLead of userLeads) {
      for (const opponentLead of generateLeadPairs(opponentTeam)) {
        const activeUser=userTeam.pokemon.filter(s=>[userLead.first,userLead.second].includes(s.species));
        const activeOpponent=opponentTeam.pokemon.filter(s=>[opponentLead.first,opponentLead.second].includes(s.species));
        for(const userMega of megaChoices(activeUser)) for(const opponentMega of megaChoices(activeOpponent)) {
          matchups.push(matchup(userTeam.pokemon, opponentTeam, userLead, opponentLead,userMega,opponentMega));
        }
      }
    }
  }

  const aggregated = aggregateLeads(matchups).sort((a, b) => b.score - a.score);
  const bestLeads = aggregated.slice(0, 3);
  const worstLeads = [...aggregated].reverse().slice(0, 3);
  const worstMatchups = [...matchups].sort((a, b) => a.score - b.score).slice(0, 8);
  const threats = [
    ...new Set(
      worstMatchups.flatMap((entry) => [
        entry.opponentLead.first,
        entry.opponentLead.second,
      ]),
    ),
  ].slice(0, 8);
  const strengths = bestLeads.map(
    (entry) =>
      `${entry.lead.first} + ${entry.lead.second} averaged ${entry.score.toFixed(1)}`,
  );
  const guidance = buildTeamGuidance(userTeam, cohort, matchups, profile.battleTeamSize,context);
  const recommendations = guidance.recommendationDetails.map(entry => `${entry.change} Tradeoff: ${entry.tradeoff}`);

  return {
    evaluation: {
      id: newId('team'),
      regulationId: profile.id,
      createdAt: new Date().toISOString(),
      metaTeamCount: cohort.length,
      matchupCount: matchups.length,
      bestLeads,
      worstLeads,
      threats,
      strengths,
      recommendations,
      sources: uniqueSources(cohort, matchingUsage.filter(row => cohort.some(team => team.roster.includes(row.pokemon)))),
      context,coverage:selection.coverage,methodologyVersion:'contextual-v1',
      ...guidance,
    },
    matchups,
    cohort,
  };
}
