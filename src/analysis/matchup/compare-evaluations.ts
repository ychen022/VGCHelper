import type {EvaluationContext, MetaUsageRow, PokemonTeam} from '../../domain/contracts.js';
import type {RegulationProfile} from '../../regulation/profile.js';
import {compareTeams, type TeamComparisonReport} from './comparison.js';
import {evaluateTeam, type EvaluationResult} from './evaluator.js';
import {megaChoices} from './positions.js';

export interface EvaluationComparison extends TeamComparisonReport {
  cohortTeamIds: string[];
  matchupChanges: Array<{opponentTeamId:string;beforeScore:number;afterScore:number;delta:number;beforeFour:string[];afterFour:string[];beforeMega:string|null;afterMega:string|null}>;
  modeChanges: Array<{opponentTeamId:string;modeId:string;beforeScore:number;afterScore:number;delta:number}>;
  contextChanges: string[];
}

export function compareEvaluations(before:PokemonTeam,after:PokemonTeam,baseline:EvaluationResult,usage:MetaUsageRow[],profile:RegulationProfile):EvaluationComparison {
  const context=baseline.evaluation.context;
  const removedModes=(context.modes??[]).filter(m=>m.bringFour.some(s=>!after.pokemon.some(p=>p.species===s)) || !megaChoices(after.pokemon).includes(m.mega));
  const removedRoles=(context.roles??[]).filter(r=>!after.pokemon.some(p=>p.species===r.pokemon && (!r.move || p.moves.includes(r.move))));
  const candidateContext:EvaluationContext={...context,modes:(context.modes??[]).filter(m=>!removedModes.includes(m)),roles:(context.roles??[]).filter(r=>!removedRoles.includes(r))};
  // Passing the selected cohort, at its exact size, preserves every source/set on both sides.
  const candidate=evaluateTeam(after,baseline.cohort,usage,{...profile,evaluation:{...profile.evaluation,maxMetaTeams:baseline.cohort.length}},candidateContext);
  return {...compareTeams(before,after,baseline.cohort),cohortTeamIds:baseline.cohort.map(t=>t.id),
    matchupChanges:baseline.evaluation.archetypePlans.map(b=>{
      const a=candidate.evaluation.archetypePlans.find(p=>p.opponentTeamId===b.opponentTeamId)!;
      return {opponentTeamId:b.opponentTeamId,beforeScore:b.screeningScore,afterScore:a.screeningScore,delta:Number((a.screeningScore-b.screeningScore).toFixed(2)),beforeFour:b.bringFour,afterFour:a.bringFour,beforeMega:b.userMega,afterMega:a.userMega};
    }),
    modeChanges:baseline.evaluation.modePlans.filter(m=>m.origin==='user').flatMap(b=>{
      const a=candidate.evaluation.modePlans.find(m=>m.origin==='user' && m.modeId===b.modeId && m.opponentTeamId===b.opponentTeamId);
      return a?[{opponentTeamId:b.opponentTeamId,modeId:b.modeId,beforeScore:b.screeningScore,afterScore:a.screeningScore,delta:Number((a.screeningScore-b.screeningScore).toFixed(2))}]:[];
    }),
    contextChanges:[...removedModes.map(m=>`Candidate cannot execute mode ${m.id}; its four or Mega is absent.`),...removedRoles.map(r=>`Candidate removes role hypothesis: ${r.pokemon} ${r.move??''} — ${r.purpose}`),
      'Matchup deltas compare each version’s best fixed opening on the same cohort. They are pressure heuristics, not win-rate changes. Declared modes are reported separately; unsupported battle trees remain unresolved.'],
  };
}
