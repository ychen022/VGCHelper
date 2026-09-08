import type {MetaTeam,MetaUsageRow,PokemonTeam} from '../domain/contracts.js';
import {sha256} from '../util/hash.js';
import {runSimulation,type EpisodeTrace,type SimulationReport,type SimulationRequest,type DecisionPolicy,type SearchSettings} from './runner.js';
import type {InformationMode} from './engine.js';
import type {ActionSelectionOptions} from './policy.js';

const key=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/mega[xy]?$/,'');
function placement(value:string|undefined):number {
  if(/^champion$/i.test(value??''))return 1;
  if(/^runner[ -]?up$/i.test(value??''))return 2;
  const match=value?.match(/(?:^|\s)(\d+)(?:st|nd|rd|th)?(?:\s|$)/i);
  return match?Number(match[1]):Number.POSITIVE_INFINITY;
}
export function selectFeaturedCohort(teams:MetaTeam[],limit=4):{teams:MetaTeam[];selection:string;excluded:number} {
  if(!Number.isInteger(limit)||limit<1||limit>8)throw new Error('Cohort size must be 1–8');
  const eligible=teams.filter(t=>t.regulationId==='champions-vgc-2026-m-b'&&t.roster.length===6&&t.pokemon.length===6&&Number.isFinite(placement(t.placement)));
  eligible.sort((a,b)=>placement(a.placement)-placement(b.placement)||(Date.parse(b.date??'')||0)-(Date.parse(a.date??'')||0)||a.id.localeCompare(b.id));
  const selected:MetaTeam[]=[];const rosters=new Set<string>();
  for(const team of eligible){const roster=team.roster.map(key).sort().join('|');if(rosters.has(roster))continue;selected.push(structuredClone(team));rosters.add(roster);if(selected.length===limit)break;}
  return {teams:selected,selection:'Ascending reported placement, then latest source date, distinct six-species rosters; no population usage weighting.',excluded:teams.length-selected.length};
}
export interface CohortRequest extends Record<string,unknown> {
  actionSelection?:ActionSelectionOptions;
  kind:'cohort';regulationId:string;team:PokemonTeam;opponents:MetaTeam[];metaTeams:MetaTeam[];usageRows:MetaUsageRow[];
  samples:number;maxTurns:number;budgetMs:number;seed:string;informationMode:InformationMode;
  policyProfiles:DecisionPolicy[];playerPolicy:DecisionPolicy;comparisonTeam?:PokemonTeam;
  fixedPlan?:string[];compareReselectedPlan?:boolean;search?:Partial<SearchSettings>;opponentActionPrior?:SimulationRequest['opponentActionPrior'];
}
export interface CohortReport {
  method:'cohort-policy-sensitivity-v1';status:'completed'|'partial';
  matchups:Array<{opponentId:string;opponentName:string;source:MetaTeam['source'];policy:DecisionPolicy;report:SimulationReport}>;
  aggregate:{conditionalWinRate:number|null;interpretation:string;games:number;unresolved:number;invalid:number};
  sensitivity:Array<{opponentId:string;minimum:number|null;maximum:number|null}>;
  requestedMatchups:number;elapsedMs:number;sourceHash:string;warnings:string[];
}
export function runCohortExperiment(request:CohortRequest,callbacks:{progress?:(value:unknown)=>void;trace?:(trace:EpisodeTrace)=>void;game?:(value:{episode:number;variant:string;log:string;ended:boolean})=>void}={}):CohortReport {
  if(!request.opponents.length||request.opponents.length>8)throw new Error('Cohort must contain 1–8 opponents');
  if(new Set(request.opponents.map(t=>t.id)).size!==request.opponents.length)throw new Error('Cohort opponent IDs must be unique');
  if(!request.policyProfiles.length||request.policyProfiles.length>3||new Set(request.policyProfiles).size!==request.policyProfiles.length)throw new Error('Choose 1–3 distinct policy profiles');
  const start=Date.now(),deadline=start+request.budgetMs;
  const jobs=request.opponents.flatMap(opponent=>request.policyProfiles.map(policy=>({opponent,policy})));
  const matchups:CohortReport['matchups']=[];const warnings:string[]=[];
  const completedResults=()=>matchups.map(m=>({opponentId:m.opponentId,policy:m.policy,status:m.report.status,variants:m.report.variants,search:m.report.search,comparison:m.report.comparison}));
  callbacks.progress?.({stage:'cohort',completedMatchups:0,requestedMatchups:jobs.length,completedResults:[]});
  for(const [index,{opponent,policy}] of jobs.entries()){
    const remaining=deadline-Date.now();if(remaining<=0)break;
    // Minimum equal allocation protects later opponents from starvation.
    const budget=Math.max(1,Math.floor(remaining/(jobs.length-index)));
    const sim:SimulationRequest={kind:request.comparisonTeam?'comparison':'battle',regulationId:request.regulationId,
      teams:{p1:{team:request.team,preview:request.team.pokemon.map(p=>p.species)},p2:{preview:opponent.pokemon.map(p=>p.species),known:opponent.pokemon.map(p=>({species:p.species,moves:p.moves,...(p.item!==undefined?{item:p.item}:{}),...(p.ability?{ability:p.ability}:{}),...(p.nature?{nature:p.nature}:{}),...(Object.keys(p.skillPoints).length?{skillPoints:p.skillPoints}:{})}))}},
      metaTeams:[opponent,...request.metaTeams.filter(t=>t.id!==opponent.id)],usageRows:request.usageRows,samples:request.samples,maxTurns:request.maxTurns,budgetMs:budget,seed:`${request.seed}:${opponent.id}`,informationMode:request.informationMode,policies:{p1:request.playerPolicy,p2:policy},
      ...(request.comparisonTeam?{comparisonTeam:request.comparisonTeam}:{}),...(request.fixedPlan?{fixedPlans:{p1:request.fixedPlan}}:{}),...(request.compareReselectedPlan?{compareReselectedPlan:true}:{}),...(request.search?{search:request.search}:{}),...(request.actionSelection?{actionSelection:request.actionSelection}:{}),...(request.opponentActionPrior?{opponentActionPrior:request.opponentActionPrior}:{})};
    const report=runSimulation(sim,{progress:value=>callbacks.progress?.({stage:'cohort',completedMatchups:index,requestedMatchups:jobs.length,completedResults:completedResults(),opponentId:opponent.id,policy,current:value}),
      ...(callbacks.game?{game:callbacks.game}:{}),...(index===0&&callbacks.trace?{trace:callbacks.trace}:{})});
    matchups.push({opponentId:opponent.id,opponentName:opponent.name,source:opponent.source,policy,report});
    callbacks.progress?.({stage:'cohort',completedMatchups:matchups.length,requestedMatchups:jobs.length,completedResults:completedResults()});
    if(report.status==='partial')warnings.push(`${opponent.id}/${policy} exhausted its allocated budget.`);
  }
  const rows=matchups.map(m=>m.report.variants[0]!);
  const games=rows.reduce((s,r)=>s+r.games,0),unresolved=rows.reduce((s,r)=>s+r.unresolved,0),invalid=rows.reduce((s,r)=>s+r.invalid,0);
  const complete=matchups.length===jobs.length&&matchups.every(m=>m.report.status==='completed');
  const mean=!complete||unresolved||invalid||rows.some(r=>r.winRate===null)?null:rows.reduce((sum,r)=>sum+r.winRate!,0)/rows.length;
  return {method:'cohort-policy-sensitivity-v1',status:complete?'completed':'partial',matchups,
    aggregate:{conditionalWinRate:mean,interpretation:'Equal-matchup descriptive mean over the selected source cohort and policy profiles; not a population metagame win rate.',games,unresolved,invalid},
    sensitivity:request.opponents.map(opponent=>{const matches=matchups.filter(m=>m.opponentId===opponent.id),values=matches.map(m=>m.report.variants[0]!.winRate);const valid=values.length===request.policyProfiles.length&&matches.every(m=>m.report.status==='completed')&&values.every(v=>v!==null);return {opponentId:opponent.id,minimum:valid?Math.min(...values as number[]):null,maximum:valid?Math.max(...values as number[]):null};}),
    requestedMatchups:jobs.length,elapsedMs:Date.now()-start,sourceHash:sha256(JSON.stringify({opponents:request.opponents,meta:request.metaTeams,usage:request.usageRows})),warnings};
}
