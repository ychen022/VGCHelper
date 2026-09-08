import type {MetaTeam,MetaUsageRow,PokemonTeam,ParsedReplay} from '../domain/contracts.js';
import {calculatorVersion} from '../calc/champions.js';
import {sha256} from '../util/hash.js';
import {EngineSession,EngineChoiceError,ENGINE_PROFILE,completePreviewTeam,validateEngineTeam,type EngineCheckpoint,type EngineSeed,type InformationMode,type PlayerSide,type PlayerView} from './engine.js';
import {buildTeamBelief,sampleBeliefTeam,applyKnownToCompletion,type KnownPokemon,type TeamBelief} from './beliefs.js';
import {updateBeliefFromView} from './observe.js';
import {actionDistribution,chooseAction,planningActions,scoreActions,POLICY_VERSION,type PolicyStyle,type ActionSelectionOptions} from './policy.js';
import {reconstructReplayStart} from './replay.js';
import {mixLearnedActionPrior} from './learned-policy.js';
import {isActionPriorAdoptable,type ContextualActionPriorArtifact} from './learning.js';
import {searchDecision,SEARCH_VERSION,type SearchResult} from './search.js';
import {sampleActorWorld} from './worlds.js';
import {readOpenSheet} from '../replay/sheets.js';
import {speciesIdentity} from './identity.js';
import {buildPublicTeamBelief} from './public-priors.js';

export type DecisionPolicy=PolicyStyle|'search';
export interface SearchSettings {iterations:number;budgetMs:number;maxTurns:number;maxDepth:number;candidateCap:number;confirmationSamples:number}
export const DEFAULT_SEARCH:SearchSettings={iterations:24,budgetMs:1500,maxTurns:3,maxDepth:12,candidateCap:8,confirmationSamples:4};

export interface TeamInput {preview:string[];team?:PokemonTeam;known?:KnownPokemon[];publicKnown?:KnownPokemon[]}
export interface SimulationRequest extends Record<string,unknown> {
  kind:'battle'|'branch'|'comparison';regulationId:string;teams:Record<PlayerSide,TeamInput>;
  metaTeams:MetaTeam[];usageRows:MetaUsageRow[];samples:number;maxTurns:number;budgetMs:number;seed:string;
  informationMode:InformationMode;policies:Record<PlayerSide,DecisionPolicy>;
  actionSelection?:ActionSelectionOptions;
  search?:Partial<SearchSettings>;fixedPlans?:Partial<Record<PlayerSide,string[]>>;compareReselectedPlan?:boolean;
  checkpoint?:EngineCheckpoint;actor?:PlayerSide;branches?:Array<{label:string;command:string}>;
  comparisonTeam?:PokemonTeam;checkpointTurns?:number[];
  replayStart?:{replay:ParsedReplay;userTeam:PokemonTeam;playerSide:PlayerSide;turn:number};
  baselineAction?:{label:string;command:string};
  opponentActionPrior?:ContextualActionPriorArtifact;
}
export interface OutcomeSummary {
  label:string;games:number;wins:number;losses:number;draws:number;unresolved:number;invalid:number;
  winRate:number|null;monteCarlo95:[number,number]|null;
}
export interface SimulationReport {
  method:'imperfect-information-rollouts-v1';status:'completed'|'partial';
  variants:OutcomeSummary[];assumptions:string[];warnings:string[];
  versions:{engine:string;calculator:string;policy:string;belief:string;rules:string;sources:string};
  elapsedMs:number;seed:string;requestedSamples:number;informationMode:InformationMode;
  outcomePerspective:PlayerSide;
  configuration:{samples:number;maxTurns:number;budgetMs:number;teams:Record<PlayerSide,string>;policies:Record<PlayerSide,DecisionPolicy>;startState:string;search:SearchSettings;fixedPlans:Partial<Record<PlayerSide,string[]>>;actionSelection:ActionSelectionOptions};
  search:{version:string;decisions:number;iterations:number;cappedRollouts:number;invalidRollouts:number;fallbacks:number;confirmationSamples:number;confirmationTerminal:number};
  selectedPlans:Array<{side:PlayerSide;variant:string;plan:string;count:number}>;
  rankedActions?:Array<{label:string;estimatedWinRate:number|null}>;
  replayPrior:{adopted:boolean;sourceHash?:string;weight:number;note:string};
  comparison?:{interpretation:string;pairedSamples:number;winDifference:number|null;standardError:number|null};
}
export interface EpisodeTrace {
  episode:number;variant:string;outcome:string;
  /** Final channel-filtered logs, separate from pre-decision evidence. Absent in older saved traces. */
  battleLogs?:Record<PlayerSide,{lines:string[];turn:number;ended:boolean}>;
  decisions:Array<{side:PlayerSide;turn:number;command:string;selectedAction?:{source:'policy'|'search'|'branch'|'fixed-plan';score:number|null;probability:number|null;rank:number|null;candidateCount:number};alternatives:Array<{command:string;probability:number;score:number}>;belief:{candidates:number;effectiveSampleSize:number;known:KnownPokemon[];warnings:string[]};observations:string[];search?:Pick<SearchResult,'rootActions'|'confirmation'|'iterations'|'status'|'warnings'>}>;
  checkpoints:Array<{turn:number;checkpoint:EngineCheckpoint}>;
}
interface Callbacks {progress?:(value:unknown)=>void;trace?:(value:EpisodeTrace)=>void;game?:(value:{episode:number;variant:string;log:string;ended:boolean})=>void}
export function engineSeed(seed:string):EngineSeed {const hash=sha256(seed);return [0,4,8,12].map(start=>parseInt(hash.slice(start,start+4),16)) as EngineSeed;}
type PublicSources=Pick<SimulationRequest,'regulationId'|'metaTeams'|'usageRows'>;
function prior(input:TeamInput,request:PublicSources):TeamBelief {
  const result=buildPublicTeamBelief(input.preview,request,input.publicKnown);
  if(!result.candidates.length)throw new Error(`No legal opponent prior for ${input.preview.join(', ')}. Supply compatible published/completion sets.`);
  return result;
}
/** This factory closes over public source snapshots only, never real teams or checkpoints. */
export function actorPriorFactory(sources:PublicSources,options:{allowEmpty?:boolean}={}):(view:PlayerView)=>TeamBelief {
  return view=>{
    const opponent=view.side==='p1'?'p2':'p1';
    const lines=view.observations.map(line=>line.split('|'));
    const preview=lines.filter(p=>p[1]==='poke'&&p[2]===opponent).map(p=>p[3]!.split(',')[0]!);
    const sheet=lines.findLast(p=>p[1]==='showteam'&&p[2]===opponent);
    const input:TeamInput={preview};
    if(sheet)input.publicKnown=readOpenSheet(sheet.slice(3).join('|')).map(p=>({species:p.species,item:p.item??'',moves:p.moves,...(p.ability?{ability:p.ability}:{}),...(p.nature?{nature:p.nature}:{})}));
    return options.allowEmpty?buildPublicTeamBelief(input.preview,sources,input.publicKnown):prior(input,sources);
  };
}
/** Referee-only scenario sampling. Never supply this result as opposing player evidence. */
export function truth(input:TeamInput,belief:TeamBelief,seed:string):PokemonTeam {
  if(input.team)return structuredClone(input.team);
  if(input.known?.length) {
    const known=[...(input.publicKnown??[]),...input.known];
    let restricted=buildTeamBelief({regulationId:belief.regulationId,preview:input.preview,known,
      completionTeams:belief.candidates.map(c=>c.team),validateTeam:validateEngineTeam});
    if(restricted.candidates.length){
      const weighted=restricted.candidates.map(candidate=>({...candidate,weight:belief.candidates.find(prior=>prior.id===candidate.id)?.weight??0}));
      const mass=weighted.reduce((sum,c)=>sum+c.weight,0);
      if(mass>0)restricted={...restricted,candidates:weighted.map(candidate=>({...candidate,weight:candidate.weight/mass}))};
    }else{
      const templates=belief.candidates.map(c=>c.team);
      try{templates.push(completePreviewTeam(input.preview));}catch{ /* Existing templates may still cover constrained fields. */ }
      restricted=buildTeamBelief({regulationId:belief.regulationId,preview:input.preview,known,
        completionTeams:templates.map(team=>applyKnownToCompletion(team,known)),completionSourceLabel:'Analyst-constrained synthetic completion',validateTeam:validateEngineTeam});
    }
    return sampleBeliefTeam(restricted,seed);
  }
  return sampleBeliefTeam(belief,seed);
}
function summary(label:string):OutcomeSummary {return {label,games:0,wins:0,losses:0,draws:0,unresolved:0,invalid:0,winRate:null,monteCarlo95:null};}
function summarize(row:OutcomeSummary):OutcomeSummary {
  if(row.unresolved||row.invalid||!row.games)return {...row,winRate:null,monteCarlo95:null};
  const n=row.games,p=row.wins/n,z=1.96,d=1+z*z/n;
  const center=(p+z*z/(2*n))/d,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return {...row,winRate:p,monteCarlo95:[Math.max(0,center-half),Math.min(1,center+half)]};
}

export function runSimulation(request:SimulationRequest,callbacks:Callbacks={}):SimulationReport {
  if(request.regulationId!=='champions-vgc-2026-m-b')throw new Error('The pinned simulator supports Champions M-B only.');
  if(!Number.isInteger(request.samples)||request.samples<1||request.samples>10000)throw new Error('Samples must be 1–10000');
  if(!Number.isInteger(request.maxTurns)||request.maxTurns<1||request.maxTurns>200)throw new Error('Turn limit must be 1–200');
  if(!Number.isInteger(request.budgetMs)||request.budgetMs<1||request.budgetMs>900000)throw new Error('Budget must be 1–900000 ms');
  if(Object.values(request.policies).some(p=>!['tactical','damage','search'].includes(p)))throw new Error('Unknown decision policy');
  const searchSettings={...DEFAULT_SEARCH,...request.search};
  for(const [name,max,min] of [['iterations',10000,1],['budgetMs',30000,1],['maxTurns',200,1],['maxDepth',1000,1],['candidateCap',4096,1],['confirmationSamples',10000,0]] as const){const value=searchSettings[name];if(!Number.isInteger(value)||value<min||value>max)throw new Error(`Invalid search ${name}`);}
  const normalize=speciesIdentity;
  for(const side of ['p1','p2'] as const){const plan=request.fixedPlans?.[side];if(plan&&(plan.length!==4||new Set(plan.map(normalize)).size!==4||plan.some(p=>!request.teams[side].preview.some(s=>normalize(s)===normalize(p)))))throw new Error('A fixed plan requires four distinct members of the supplied preview, in lead/reserve order');}
  if(request.compareReselectedPlan&&(!request.fixedPlans?.p1||request.comparisonTeam||request.kind==='branch'))throw new Error('Reselected-plan comparison requires a fixed p1 plan and cannot combine with team or branch comparisons');
  if(request.comparisonTeam&&request.fixedPlans?.p1?.some(p=>!request.comparisonTeam!.pokemon.some(set=>normalize(set.species)===normalize(p))))throw new Error('The fixed p1 plan must also contain four members of the candidate team');
  if(request.opponentActionPrior&&!isActionPriorAdoptable(request.opponentActionPrior))throw new Error('Replay action-prior artifact failed its format/data/evaluation gate.');
  const start=Date.now(),deadline=start+request.budgetMs;
  let lastProgress:Record<string,unknown>={stage:'preparing',requestedSamples:request.samples,elapsedMs:0};
  const progress=(update:Record<string,unknown>)=>{lastProgress={...lastProgress,...update};callbacks.progress?.(lastProgress);};
  progress({});
  for(const input of Object.values(request.teams)) {
    if(input.preview.length!==6)throw new Error('Simulation requires a six-member preview');
    if(input.team){const errors=validateEngineTeam(input.team);if(errors.length)throw new Error(errors.join('; '));}
  }
  if(request.comparisonTeam){const errors=validateEngineTeam(request.comparisonTeam);if(errors.length)throw new Error(errors.join('; '));}
  const priors={p1:prior(request.teams.p2,request),p2:prior(request.teams.p1,request)};
  const opponentBelief=actorPriorFactory({regulationId:request.regulationId,metaTeams:request.metaTeams,usageRows:request.usageRows});
  const searchStats:SimulationReport['search']={version:SEARCH_VERSION,decisions:0,iterations:0,cappedRollouts:0,invalidRollouts:0,fallbacks:0,confirmationSamples:0,confirmationTerminal:0};
  const candidatePrior=request.comparisonTeam?prior({preview:request.comparisonTeam.pokemon.map(p=>p.species)},request):undefined;
  const reconstructionWarnings=new Set<string>();
  request.checkpoint?.reconstruction?.warnings.forEach(w=>reconstructionWarnings.add(w));
  const replayCheckpoints=new Map<number,EngineCheckpoint>();
  let replayCandidatesRejected=0;
  let effectiveInformationMode=request.checkpoint?.options.informationMode??request.informationMode;
  const createGame=(teams:Record<PlayerSide,PokemonTeam>,episode:number):EngineSession=>{
    let checkpoint=request.checkpoint;
    if(request.replayStart){
      const root=request.replayStart,opponent=root.playerSide==='p1'?'p2':'p1';
      checkpoint=replayCheckpoints.get(episode);
      if(!checkpoint){
        let failure:unknown;
        for(let attempt=0;attempt<16&&Date.now()<deadline;attempt++){
          progress({stage:'reconstructing',episode,worldAttempt:attempt+1,elapsedMs:Date.now()-start});
          const candidate=attempt===0?teams[opponent]:truth(request.teams[opponent],priors[root.playerSide],`${request.seed}:replay-world:${episode}:${attempt}`);
          try {
            const reconstructed=reconstructReplayStart(root.replay,root.userTeam,root.playerSide,root.turn,candidate,engineSeed(`${request.seed}:reconstruct:${episode}:${attempt}`),{deadline,maxAttempts:128,particleCap:8});
            reconstructed.reconstruction.warnings.forEach(w=>reconstructionWarnings.add(w));
            checkpoint=reconstructed;replayCheckpoints.set(episode,checkpoint);break;
          }catch(error){failure=error;replayCandidatesRejected++;}
        }
        if(!checkpoint)throw failure??new Error('Public reconstruction exhausted its time budget without a supported state.');
      }
    }
    const game=checkpoint?EngineSession.restore(checkpoint):EngineSession.create({teams,seed:engineSeed(`${request.seed}:battle:${episode}`),informationMode:request.informationMode});
    effectiveInformationMode=game.view('p1').informationMode;
    if(checkpoint)game.reseed(engineSeed(`${request.seed}:future:${episode}`));
    return game;
  };
  let variants=request.kind==='branch'?request.branches?.map(branch=>({label:branch.label,command:branch.command}))
    :request.comparisonTeam?[{label:'baseline',command:undefined},{label:'candidate',command:undefined}]:request.compareReselectedPlan?[{label:'fixed plan',command:undefined},{label:'reselected plan',command:undefined}]:[{label:'battle',command:undefined}];
  if(request.kind==='branch'&&!request.checkpoint&&!request.replayStart)throw new Error('Branch simulation requires a validated checkpoint or public replay prefix');
  if(request.kind==='branch'){
    const firstTeams={p1:truth(request.teams.p1,priors.p2,`${request.seed}:truth:p1:0`),p2:truth(request.teams.p2,priors.p1,`${request.seed}:truth:p2:0`)};
    const side=request.actor??'p1',view=createGame(firstTeams,0).view(side);
    if(view.ended||view.request.wait||!view.legalCommands.length)throw new Error('The selected actor has no decision at this checkpoint; choose a checkpoint where that player acts.');
    const belief=updateBeliefFromView(priors[side],view,{validateTeam:validateEngineTeam});
    const candidates=planningActions(view,belief,4096).filter(action=>!request.replayStart||!action.command.includes('switch '));
    variants??=[...(request.baselineAction?[request.baselineAction]:[]),...candidates.filter(action=>action.command!==request.baselineAction?.command).slice(0,request.baselineAction?2:3).map((action,index)=>({label:`candidate_${index+1}: ${action.command}`,command:action.command}))];
    for(const variant of variants)if(!variant.command||!view.legalCommands.includes(variant.command))throw new Error(`Requested action is not legal at this decision: ${variant.command}`);
  }
  if(!variants?.length||variants.length>8)throw new Error('Branch comparison requires 1–8 named actions');
  if(new Set(variants.map(v=>v.label)).size!==variants.length)throw new Error('Variant labels must be unique');
  if(request.replayStart&&variants.some(v=>v.command?.includes('switch ')))throw new Error('Public replay root switch alternatives require a known selected four; use move alternatives or an exact simulation checkpoint.');
  const rows=variants.map(v=>summary(v.label));const warnings=new Set<string>([...priors.p1.warnings,...priors.p2.warnings]);
  const pairs:number[]=[];let completedRounds=0;
  const perspective=request.kind==='branch'?(request.actor??'p1'):'p1';
  const plans=new Map<string,{side:PlayerSide;variant:string;plan:string;count:number}>();
  progress({stage:'sampling',requestedSamples:request.samples,variants:rows,elapsedMs:Date.now()-start});
  outer:for(let episode=0;episode<request.samples;episode++) {
    const baseTeams={p1:truth(request.teams.p1,priors.p2,`${request.seed}:truth:p1:${episode}`),p2:truth(request.teams.p2,priors.p1,`${request.seed}:truth:p2:${episode}`)};
    const pairedResults:number[]=[];
    for(const [variantIndex,variant] of variants.entries()) {
      if(Date.now()>=deadline)break outer;
      const teams=variantIndex===1&&request.comparisonTeam?{...baseTeams,p1:request.comparisonTeam}:baseTeams;
      const beliefs:Record<PlayerSide,TeamBelief>={p1:structuredClone(priors.p1),p2:structuredClone(variantIndex===1&&candidatePrior?candidatePrior:priors.p2)};
      const row=rows[variantIndex]!;const trace:EpisodeTrace={episode,variant:variant.label,outcome:'unresolved',decisions:[],checkpoints:[]};
      let choices=0,forced=false,retries=0;
      let game:EngineSession|undefined;
      try {
        game=createGame(teams,episode);
        const rootTurn=game.view(request.actor??'p1').turn;
        if(request.kind==='branch'&&game.view(request.actor??'p1').request.wait)throw new Error('The selected actor is waiting at this sampled root.');
        while(!game.view('p1').ended&&game.view('p1').turn<=request.maxTurns&&choices<request.maxTurns*5+20&&Date.now()<deadline) {
          const views={p1:game.view('p1'),p2:game.view('p2')};
          if(episode===0&&trace.checkpoints.length<8&&(request.checkpointTurns??[1,2,3,4,5]).includes(views.p1.turn)&&!trace.checkpoints.some(c=>c.turn===views.p1.turn))trace.checkpoints.push({turn:views.p1.turn,checkpoint:game.snapshot()});
          const commands:Partial<Record<PlayerSide,string>>={};
          for(const side of ['p1','p2'] as const) {
            const view=views[side];
            if(view.request.wait)continue;
            beliefs[side]=updateBeliefFromView(beliefs[side],view,{validateTeam:validateEngineTeam});
            for(const warning of beliefs[side].warnings)warnings.add(warning);
            const tactical=actionDistribution(view,beliefs[side],request.policies[side]==='search'?'tactical':request.policies[side],request.actionSelection);
            const distribution=side==='p2'&&request.opponentActionPrior?mixLearnedActionPrior(view,tactical,request.opponentActionPrior).toSorted((a,b)=>b.probability-a.probability||a.command.localeCompare(b.command)):tactical;
            let command=!forced&&variant.command&&side===(request.actor??'p1')&&view.turn===rootTurn?variant.command
              :chooseAction(distribution,`${request.seed}:policy:${episode}:${side}:${choices}:${retries}`);
            let search:SearchResult|undefined;
            const fixed=request.compareReselectedPlan&&variantIndex===1&&side==='p1'?undefined:request.fixedPlans?.[side];
            const forcedAction=!forced&&variant.command&&side===(request.actor??'p1')&&view.turn===rootTurn;
            if(view.request.teamPreview&&fixed){command='team '+fixed.map(p=>view.request.side.pokemon.findIndex(member=>normalize(member.details.split(',')[0]!)===normalize(p))+1).join('');}
            else if(request.policies[side]==='search'&&!forcedAction){
              searchStats.decisions++;
              const decisionDeadline=Math.min(deadline,Date.now()+searchSettings.budgetMs);
              progress({stage:'searching',episode,side,turn:view.turn,elapsedMs:Date.now()-start,search:searchStats});
              search=searchDecision(view,beliefs[side],{...searchSettings,budgetMs:Math.max(0,decisionDeadline-Date.now()),seed:`${request.seed}:search:${episode}:${side}:${choices}:${retries}`,
                ...(request.actionSelection?{actionSelection:request.actionSelection}:{}),
                confirmationMaxTurns:Math.min(200,Math.max(1,request.maxTurns-view.turn+1)),confirmationMaxDepth:Math.min(1000,request.maxTurns*5+20),
                sampleWorld:(actor,belief,seed,phaseDeadline)=>sampleActorWorld(actor,belief,seed,{deadline:Math.min(decisionDeadline,phaseDeadline),maxAttempts:64,particleCap:4}),opponentBelief});
              searchStats.iterations+=search.iterations;searchStats.cappedRollouts+=search.incompleteRollouts;searchStats.invalidRollouts+=search.invalidRollouts;
              searchStats.confirmationSamples+=search.confirmation.samples;searchStats.confirmationTerminal+=search.confirmation.wins+search.confirmation.losses+search.confirmation.draws;
              search.warnings.forEach(w=>warnings.add(w));
              if(search.rootActions.some(a=>a.meanValue!==null))command=search.command;
              else{searchStats.fallbacks++;warnings.add('No consistent search rollout completed; this decision used the actor-view tactical fallback.');}
            }
            if(!command)throw new Error(`No permitted action for ${side}`);
            if(!view.legalCommands.includes(command))throw new Error(`Requested action is not legal at this decision: ${command}`);
            commands[side]=command;
            if(view.request.teamPreview){
              const plan=[...command.slice(5)].map(index=>view.request.side.pokemon[Number(index)-1]!.details.split(',')[0]).join(' / ');
              const key=`${side}:${variant.label}:${plan}`,entry=plans.get(key)??{side,variant:variant.label,plan,count:0};entry.count++;plans.set(key,entry);
            }
            if(episode===0&&trace.decisions.length<100){
              const source=view.request.teamPreview&&fixed?'fixed-plan':forcedAction?'branch':search?.rootActions.some(a=>a.meanValue!==null)?'search':'policy';
              const rank=distribution.findIndex(action=>action.command===command),selected=distribution[rank];
              const score=selected?.score??scoreActions(view,beliefs[side],request.policies[side]==='damage'?'damage':'tactical').find(action=>action.command===command)?.score??null;
              trace.decisions.push({side,turn:view.turn,command,selectedAction:{source,score,probability:source==='policy'?selected?.probability??null:null,rank:source==='policy'&&rank>=0?rank+1:null,candidateCount:source==='search'?search!.rootActions.length:distribution.length},alternatives:distribution.slice(0,4).map(({command,score,probability})=>({command,score,probability})),
                belief:{candidates:beliefs[side].candidates.length,effectiveSampleSize:beliefs[side].effectiveSampleSize,known:beliefs[side].known,warnings:beliefs[side].warnings},observations:view.observations,...(search?{search:{rootActions:search.rootActions.slice(0,32),confirmation:search.confirmation,iterations:search.iterations,status:search.status,warnings:search.warnings.slice(0,8)}}:{})});
            }
          }
          try {game.step(commands);forced=true;retries=0;choices++;}
          catch(error) {if(error instanceof EngineChoiceError&&error.retryable&&retries++<4)continue;throw error;}
        }
        const final=game.view('p1');row.games++;
        callbacks.game?.({episode,variant:variant.label,log:final.observations.join('\n'),ended:final.ended});
        if(final.ended){if(final.winner===perspective){row.wins++;trace.outcome=final.winner;pairedResults.push(1);}else if(final.winner==='p1'||final.winner==='p2'){row.losses++;trace.outcome=final.winner;pairedResults.push(0);}else{row.draws++;trace.outcome='draw';pairedResults.push(0);}}
        else{row.unresolved++;pairedResults.push(NaN);}
      }catch(error){row.games++;row.invalid++;pairedResults.push(NaN);trace.outcome='invalid';warnings.add(error instanceof Error?error.message:String(error));}
      if(episode===0){
        if(game){
          const log=(side:PlayerSide)=>{const view=game.view(side);return {lines:view.observations,turn:view.turn,ended:view.ended};};
          trace.battleLogs={p1:log('p1'),p2:log('p2')};
        }
        callbacks.trace?.(trace);
      }
      progress({stage:'sampling',requestedSamples:request.samples,variants:rows.map(summarize),elapsedMs:Date.now()-start});
    }
    if(pairedResults.length===2&&pairedResults.every(Number.isFinite))pairs.push(pairedResults[1]!-pairedResults[0]!);
    completedRounds++;
    replayCheckpoints.delete(episode);
  }
  const censored=rows.some(row=>row.unresolved||row.invalid)||rows.some(row=>row.games!==rows[0]!.games);
  const average=!censored&&pairs.length?pairs.reduce((sum,n)=>sum+n,0)/pairs.length:null;
  const standardError=average!==null&&pairs.length>1?Math.sqrt(pairs.reduce((sum,n)=>sum+(n-average)**2,0)/(pairs.length-1)/pairs.length):null;
  return {method:'imperfect-information-rollouts-v1',status:completedRounds===request.samples?'completed':'partial',variants:rows.map(summarize),
    replayPrior:request.opponentActionPrior?{adopted:true,sourceHash:request.opponentActionPrior.sourceHash,weight:0.15,note:'Explicit p2 empirical move-prior mixture; held-out gate is versus marginal replay frequencies, not evidence of tournament-strength play.'}:{adopted:false,weight:0,note:'No adopted replay artifact supplied. Actions use explicit damage/tactical features; no learned-policy strength claim.'},
    search:searchStats,outcomePerspective:perspective,configuration:{samples:request.samples,maxTurns:request.maxTurns,budgetMs:request.budgetMs,teams:{p1:sha256(JSON.stringify(request.teams.p1)),p2:sha256(JSON.stringify(request.teams.p2))},policies:request.policies,search:searchSettings,actionSelection:{topFraction:0.1,...request.actionSelection},fixedPlans:request.fixedPlans??{},startState:request.replayStart?'public-prefix-conditioned':request.checkpoint?'saved-engine-checkpoint':'team-preview'},
    selectedPlans:[...plans.values()].sort((a,b)=>b.count-a.count).slice(0,16),
    ...(request.kind==='branch'?{rankedActions:rows.map(summarize).map(row=>({label:row.label,estimatedWinRate:censored?null:row.winRate})).sort((a,b)=>(b.estimatedWinRate??-1)-(a.estimatedWinRate??-1))}:{}),
    versions:{engine:ENGINE_PROFILE.revision,calculator:calculatorVersion(),policy:POLICY_VERSION,belief:priors.p1.version,rules:sha256(JSON.stringify(ENGINE_PROFILE)),sources:sha256(JSON.stringify({teams:request.metaTeams,usage:request.usageRows}))},
    assumptions:['Outcomes are conditional on the supplied team worlds and actor-view stochastic policies; they are not calibrated ladder win rates.',
      'Preview-only fallback is a synthetic legal set prior, not empirical usage. Published fields and omitted spreads retain source uncertainty.',
      'Policy uses bounded expected damage/tactical features across at most eight weighted candidate teams, with exploration; full-game engine resolution follows both simultaneous choices.',
      'Monte Carlo intervals cover outcome sampling under this model, not uncertainty about human behavior or source bias. Draws count separately; unresolved/invalid games suppress win-rate estimates.',
      'Search selection utilities include capped HP heuristics and are not win probabilities. Independent frozen-policy confirmation is reported separately in traces; unsupported actor worlds fall back explicitly.',
      ...(request.checkpoint?['Continuation is conditional on a particular reconstructed/sampled checkpoint; it does not recover unknown actual private sets.']:[]),
      ...(request.replayStart?['Public replay continuations resample team worlds and mechanically condition on the pre-decision prefix; unsupported samples are invalid, not outcome evidence.']:[]),
      ...(request.replayStart?['Replay world weights are a bounded prefix-consistent approximation: transition matching does not integrate each candidate’s full prefix likelihood, so this is not a calibrated Bayesian posterior.']:[]),
      ...(request.kind==='branch'?['A bounded set of root joint actions is evaluated by full-game stochastic continuation. This is root lookahead, not an equilibrium solver or calibrated human policy.']:[]),
      ...(request.comparisonTeam?[request.fixedPlans?.p1?'Both team versions use the supplied fixed preview plan against paired sampled opponents.':'Both versions select their own preview plan against the same sampled opponents. Paired RNG seeds do not force identical events after paths diverge.']:[])],
    warnings:[...warnings,...reconstructionWarnings,...(replayCandidatesRejected?[`${replayCandidatesRejected} public-prefix world candidates were rejected before a consistent state or the bounded attempt limit.`]:[]),...(censored&&variants.length>1?['Paired estimates suppressed because incomplete/invalid games can bias comparisons.']:[])],elapsedMs:Date.now()-start,seed:request.seed,requestedSamples:request.samples,informationMode:effectiveInformationMode,
    ...(variants.length===2?{comparison:{interpretation:`Paired difference in ${perspective} win indicators: second variant minus first; fixed-policy samples.`,pairedSamples:pairs.length,winDifference:average,standardError}}:{})};
}
