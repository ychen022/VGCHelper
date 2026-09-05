import type {EvaluationContext, LeadMatchup, LeadPair, MetaTeam, PokemonTeam} from '../../domain/contracts.js';
import {buildOpeningScenarios, SUPPORT_MOVES, uncertainSpread, type OpeningScenario} from './openings.js';
import {buildModePlans, type ModePlan} from './context.js';

export interface ArchetypePlan {
  opponentTeamId: string;
  archetype: string;
  lead: LeadPair;
  bringFour: string[];
  alternatives: string[];
  rationale: string[];
  worstResponse: LeadPair;
  screeningScore: number;
  userMega: string|null;
}

export interface TeamGuidance {
  archetypePlans: ArchetypePlan[];
  openingScenarios: OpeningScenario[];
  recommendationDetails: Array<{change: string; evidence: string[]; tradeoff: string}>;
  modePlans: ModePlan[];
  assumptions: string[];
  limitations: string[];
}

function leadKey(lead: LeadPair): string { return `${lead.first}|${lead.second}`; }

function archetype(team: MetaTeam): string {
  const moves = team.pokemon.flatMap(set => set.moves);
  if (moves.includes('Trick Room') && moves.includes('Tailwind')) return 'Dual speed control';
  if (moves.includes('Trick Room')) return 'Trick Room';
  if (moves.includes('Tailwind')) return 'Tailwind';
  if (moves.includes('Follow Me') || moves.includes('Rage Powder')) return 'Redirection support';
  return 'Direct pressure';
}

export function buildTeamGuidance(user: PokemonTeam, cohort: MetaTeam[], matchups: LeadMatchup[], _battleTeamSize: number, context:EvaluationContext={}): TeamGuidance {
  const archetypePlans: ArchetypePlan[] = [];
  const openingScenarios: OpeningScenario[] = [];
  const modePlans:ModePlan[]=[];
  for (const team of cohort) {
    const rows = matchups.filter(row => row.opponentTeamId === team.id);
    const byLead = new Map<string, LeadMatchup[]>();
    for (const row of rows) {
      const key = `${leadKey(row.userLead)}|${row.userMega ?? 'held'}`;
      byLead.set(key, [...(byLead.get(key) ?? []), row]);
    }
    // Robust lead guidance uses each lead's worst screened response; the public
    // legacy aggregate scores remain intact for compatibility and comparison.
    const robust = [...byLead.values()].map(entries => [...entries].sort((a, b) => a.score - b.score)[0]!)
      .sort((a, b) => b.score - a.score);
    const teamModes=buildModePlans(user,team,rows,context);
    modePlans.push(...teamModes);
    const bestMode=[...teamModes].sort((a,b)=>b.screeningScore-a.screeningScore)[0]!;
    const selected = rows.find(r=>r.userLead.first===bestMode.lead.first && r.userLead.second===bestMode.lead.second &&
      (r.userMega??null)===(bestMode.userMega && [r.userLead.first,r.userLead.second].includes(bestMode.userMega)?bestMode.userMega:null) &&
      r.opponentLead.first===bestMode.worstResponse.first && r.opponentLead.second===bestMode.worstResponse.second &&
      (r.opponentMega??null)===bestMode.worstOpponentMega) ?? robust[0]!;
    const lead = selected.userLead;
    const remaining = user.pokemon.filter(set => set.species !== lead.first && set.species !== lead.second)
      .map(set => {
        const related = rows.filter(row => row.userLead.first === set.species || row.userLead.second === set.species);
        return {species: set.species, score: related.reduce((total, row) => total + row.score, 0) / related.length};
      }).sort((a, b) => b.score - a.score);
    const reserves = bestMode.bringFour.filter(s=>![lead.first,lead.second].includes(s));
    archetypePlans.push({
      opponentTeamId: team.id, archetype: archetype(team), lead,
      userMega: bestMode.userMega,
      bringFour: [lead.first, lead.second, ...reserves],
      alternatives: remaining.filter(s=>!reserves.includes(s.species)).map(set => set.species),
      worstResponse: selected.opponentLead, screeningScore: selected.score,
      rationale: [
        `${lead.first} + ${lead.second} has the highest worst-response screening score against ${team.name} (${selected.score.toFixed(1)}); this is a pressure heuristic, not a win rate.`,
        ...bestMode.evidence,
        `Prepare for ${selected.opponentLead.first} + ${selected.opponentLead.second}; use the conditional opening menu to compare protection, disruption and partner pressure.`,
        'The reserve ranking is a preview starting point; switching synergy, endgames and a full bring-four game tree are not modeled.',
      ],
    });
    const worst = [...rows].sort((a, b) => a.score - b.score)[0]!;
    const supportLead = [...byLead.values()].sort((a, b) => {
      const count = (entry: LeadMatchup) => user.pokemon.filter(set => [entry.userLead.first, entry.userLead.second].includes(set.species))
        .reduce((total, set) => total + set.moves.filter(move => SUPPORT_MOVES.has(move) && move !== 'Protect' && move !== 'Detect').length, 0);
      return count(b[0]!) - count(a[0]!);
    })[0]!;
    const uncertain = team.pokemon.filter(uncertainSpread).map(set => set.species);
    const support = [...supportLead].sort((a, b) => {
      const touchesUnknown = (row: LeadMatchup) => Number([row.opponentLead.first, row.opponentLead.second].some(species => uncertain.includes(species)));
      return touchesUnknown(b) - touchesUnknown(a) || a.score - b.score;
    })[0]!;
    const unique = new Map([selected, worst, support].map(row => [`${leadKey(row.userLead)}:${row.userMega??'held'}:${leadKey(row.opponentLead)}:${row.opponentMega??'held'}`, row]));
    for (const row of unique.values()) {
      const userLead = [row.userLead.first, row.userLead.second].map(species => user.pokemon.find(set => set.species === species)!);
      const opponentLead = [row.opponentLead.first, row.opponentLead.second].map(species => team.pokemon.find(set => set.species === species)!);
      openingScenarios.push(...buildOpeningScenarios(userLead, opponentLead, team.id, row.userMega ?? null, row.opponentMega ?? null));
    }
  }
  const vulnerable = [...archetypePlans].sort((a, b) => a.screeningScore - b.screeningScore)[0]!;
  const speedTools = user.pokemon.flatMap(set => set.moves.filter(move => ['Tailwind', 'Trick Room', 'Icy Wind', 'Electroweb'].includes(move)).map(move => `${set.species} ${move}`));
  const protect = user.pokemon.filter(set => set.moves.includes('Protect') || set.moves.includes('Detect'));
  const recommendationDetails: TeamGuidance['recommendationDetails'] = [{
    change: `Test ${vulnerable.lead.first} + ${vulnerable.lead.second} with ${vulnerable.bringFour.slice(2).join(' + ')} in reserve against ${vulnerable.archetype}.`,
    evidence: vulnerable.rationale.slice(0, 2),
    tradeoff: 'This targets the weakest representative matchup; it may give up stronger average pressure against other archetypes and needs endgame validation.',
  }];
  if (speedTools.length) recommendationDetails.push({
    change: `Practice a partner-pressure opening with ${speedTools.join(' or ')} and compare it with attacking immediately.`,
    evidence: ['The conditional scenario menu includes control plus a partner action and opposing disruption.'],
    tradeoff: 'Spending an action on control loses immediate damage; Fake Out, Taunt, opposing control or a KO can prevent the intended benefit.',
  });
  else recommendationDetails.push({
    change: 'Test a legal speed-control option on the roster and rerun the weakest archetype matchup before changing the team.',
    evidence: ['No Tailwind, Trick Room, Icy Wind or Electroweb appears in the supplied moves.'],
    tradeoff: 'A control move or roster replacement costs coverage or a team slot; species learnset legality and matchup gains require a separate check.',
  });
  if (protect.length) recommendationDetails.push({
    change: `Use ${protect.map(set => set.species).join(', ')} protection turns to compare partner pressure with opponent setup or retargeting.`,
    evidence: ['Protect responses block ordinary damage to that slot in the conditional menu.'],
    tradeoff: 'A protected slot contributes no damage that turn and can leave its partner exposed; repeated Protect success is not modeled.',
  });
  else recommendationDetails.push({
    change: 'Test a legal Protect or Detect slot on the most exposed attacker before investing in extra bulk.',
    evidence: ['No Protect or Detect appears in the supplied moves.'],
    tradeoff: 'Protection costs move coverage and an action; confirm learnset legality and whether the remaining partner can exploit the turn.',
  });
  return {
    archetypePlans, modePlans, openingScenarios, recommendationDetails,
    assumptions: ['All screening starts at full HP with fresh entry abilities and one explicit Mega choice per side; supplied sets remain unchanged.',
      'Published set fields are retained. Unknown spreads use the source baseline and one separately labeled bulk sensitivity scenario in selected openings.',
      ...cohort.filter(team => team.pokemon.some(set => set.moves.length < 4)).map(team => `Team ${team.id} lists fewer than four moves on at least one Pokemon; unlisted actions are not modeled.`)],
    limitations: ['Scores are pressure heuristics, never calibrated win probabilities.',
      'The 15-by-15 matrix screens damaging plans with a static control bonus; it is not an exact turn simulator.',
      'Detail is capped at three key lead matchups per representative, six joint templates per side and two spread scenarios (216 conditional openings per team).',
      'Archetype labels derive from supplied moves. Bring-four reserves use lead coverage, not a full four-Pokemon battle search.',
      'Damage lines remain conditional. Fake Out, redirection and speed-control consequences are described but not resolved as exact mechanics.'],
  };
}
