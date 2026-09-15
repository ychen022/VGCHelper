import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {sha256} from '../src/util/hash.js';
import {normalizeCorpusRecord} from '../src/simulation/corpus.js';
import {readOpenSheet} from '../src/replay/sheets.js';
import {loadReplay,parseReplay} from '../src/replay/index.js';
import {buildTeamBelief,sampleBeliefTeam,type TeamBelief} from '../src/simulation/beliefs.js';
import {EngineSession,moveMetadata,validateEngineTeam,type PlayerSide} from '../src/simulation/engine.js';
import {reconstructReplayStart,type ReplayStartCheckpoint} from '../src/simulation/replay.js';
import {runSimulation,engineSeed,type EpisodeTrace} from '../src/simulation/runner.js';
import {actionDistribution} from '../src/simulation/policy.js';
import {speciesIdentity} from '../src/simulation/identity.js';
import type {PokemonTeam,PokemonSet} from '../src/domain/contracts.js';

const output=resolve(process.argv[2]??'.vgc-helper/experiments/m-c');mkdirSync(output,{recursive:true});
const content=readFileSync(join(output,'holidayougi-mc.jsonl'),'utf8');
const split=JSON.parse(readFileSync(join(output,'corpus-split-freeze.json'),'utf8')) as {splitHash:string;splits:{validation:string[]}};
const development=new Set(split.splits.validation);
const all=content.split(/\r?\n/).filter(Boolean).map(line=>normalizeCorpusRecord(JSON.parse(line)));
function sheets(log:string):Record<PlayerSide,PokemonSet[]> {
  const opening=log.split('\n').slice(0,log.split('\n').indexOf('|start'));
  const result={} as Record<PlayerSide,PokemonSet[]>;
  for(const side of ['p1','p2'] as const){
    const line=opening.find(line=>line.startsWith(`|showteam|${side}|`));
    if(!line)throw new Error('Both full sheets must be disclosed before battle start');
    const sets=readOpenSheet(line.split('|').slice(3).join('|'));
    if(sets.length!==6)throw new Error('Both sheets must contain six sets');
    result[side]=sets;
  }
  return result;
}
const eligible=all.filter(record=>development.has(record.id)).filter(record=>{
  const turns=[...record.log.matchAll(/\|turn\|(\d+)/g)].map(match=>Number(match[1]));
  if(!turns.includes(2)||Math.max(...turns)>12)return false;
  try{sheets(record.log);return true;}catch{return false;}
}).sort((a,b)=>a.uploadTime!.localeCompare(b.uploadTime!)||a.id.localeCompare(b.id));
const selected=eligible.slice(0,12);
const protocol={version:'bounded-replay-reconstruction-evaluation-v1',splitHash:split.splitHash,sourceHash:sha256(content),selection:'Earliest chronological development games with both full sheets before start, a turn-2 boundary, and <=12 turns; no outcome or reconstruction-success selection.',selectedIds:selected.map(record=>record.id),maxCandidatePairs:4,maxAttempts:128,particleCap:4,deadlineMs:500,turns:[1,2],candidateScenarios:['32 offense / 32 speed / 2 HP','32 offense / 32 HP / 2 speed'],counterfactual:{samples:4,maxTurns:60,budgetMs:20000,policies:{p1:'tactical',p2:'tactical'},selection:'First successful turn-1 case in the frozen order; top two distinct legal move-only actions under the hypothetical actor tactical policy.'}};
const freezePath=join(output,'reconstruction-selection-freeze.json');
const frozen=JSON.stringify(protocol,null,2)+'\n';
if(existsSync(freezePath)&&readFileSync(freezePath,'utf8')!==frozen)throw new Error('Existing reconstruction selection/protocol differs; no post-outcome reselection permitted');
writeFileSync(freezePath,frozen);
console.log(JSON.stringify({phase:'selection_frozen',eligible:eligible.length,selected:protocol.selectedIds}));

function scenarioBelief(sets:PokemonSet[],recordId:string,side:PlayerSide):TeamBelief {
  const canonical=sets.map(set=>({...structuredClone(set),species:speciesIdentity(set.species)==='floetteeternal'?'Floette-Eternal':set.species}));
  const completions=[false,true].map(bulky=>({pokemon:canonical.map(set=>{
    const physical=set.moves.reduce((sum,move)=>sum+(moveMetadata(move).category==='Physical'?moveMetadata(move).basePower:0),0);
    const special=set.moves.reduce((sum,move)=>sum+(moveMetadata(move).category==='Special'?moveMetadata(move).basePower:0),0);
    const offensive=physical>special?'atk':'spa';
    return {...structuredClone(set),skillPoints:{[offensive]:32,hp:bulky?32:2,spe:bulky?2:32},ivs:{}};
  })}));
  return buildTeamBelief({regulationId:'champions-vgc-2026-m-c',preview:canonical.map(set=>set.species),known:canonical.map(({species,item,ability,moves,nature})=>({species,item:item??'',ability:ability??'',moves,...(nature?{nature}:{})})),completionTeams:completions,completionSourceLabel:`Hypothetical spreads derived from public sheet ${recordId} ${side}; not actual private investments`,validateTeam:validateEngineTeam,maxCandidates:2});
}
const results:Array<unknown>=[];
let supported:undefined|{record:typeof selected[number];teams:Record<PlayerSide,PokemonTeam>;beliefs:Record<PlayerSide,TeamBelief>;checkpoint:ReplayStartCheckpoint;pair:number};
for(const record of selected){
  const start=Date.now();
  try{
    const revealed=sheets(record.log),beliefs={p1:scenarioBelief(revealed.p1,record.id,'p1'),p2:scenarioBelief(revealed.p2,record.id,'p2')};
    const pairs:Array<Record<PlayerSide,PokemonTeam>>=[],seen=new Set<string>();
    for(let seed=0;seed<32&&pairs.length<4;seed++){
      const pair={p1:sampleBeliefTeam(beliefs.p1,`${record.id}:p1:${seed}`),p2:sampleBeliefTeam(beliefs.p2,`${record.id}:p2:${seed}`)};
      const key=sha256(JSON.stringify(pair));if(!seen.has(key)){seen.add(key);pairs.push(pair);}
    }
    const replay=parseReplay(loadReplay({content:record.log}));
    const attempts:Array<unknown>=[];
    for(const [pairIndex,pair] of pairs.entries())for(const turn of [1,2]){
      const began=Date.now();
      try{
        const checkpoint=reconstructReplayStart(replay,pair.p1,'p1',turn,pair.p2,engineSeed(`${record.id}:pair:${pairIndex}:turn:${turn}`),{maxAttempts:128,particleCap:4,deadline:began+500});
        attempts.push({pair:pairIndex,turn,status:'supported',elapsedMs:Date.now()-began,reconstruction:checkpoint.reconstruction,ownScenario:pair.p1,opponentScenario:pair.p2});
        if(turn===1&&!supported)supported={record,teams:pair,beliefs,checkpoint,pair:pairIndex};
      }catch(error){
        const reason=error instanceof Error?error.message:String(error);
        attempts.push({pair:pairIndex,turn,status:'unsupported',elapsedMs:Date.now()-began,reason,conditioningAttempts:reason.match(/\((\d+)\/128\)/)?.[1]?Number(reason.match(/\((\d+)\/128\)/)![1]):null,attemptLimit:128});
      }
    }
    results.push({id:record.id,uploadTime:record.uploadTime,elapsedMs:Date.now()-start,candidateCounts:{p1:beliefs.p1.candidates.length,p2:beliefs.p2.candidates.length},candidatePairs:pairs.length,beliefWarnings:{p1:beliefs.p1.warnings,p2:beliefs.p2.warnings},attempts});
    console.log(JSON.stringify({phase:'game_attempted',id:record.id,elapsedMs:Date.now()-start,attempts:attempts.map(value=>{const row=value as {pair:number;turn:number;status:string;reason?:string};return {pair:row.pair,turn:row.turn,status:row.status,reason:row.reason};})}));
  }catch(error){results.push({id:record.id,status:'candidate_coverage_unavailable',elapsedMs:Date.now()-start,reason:error instanceof Error?error.message:String(error)});}
}
let counterfactual:unknown={status:'unavailable',reason:'No supported turn-1 candidate among frozen selected cases.'};
if(supported){
  const choice=supported,view=EngineSession.restore(choice.checkpoint).view('p1');
  const alternatives=actionDistribution(view,choice.beliefs.p2,'tactical').filter(action=>!action.command.includes('switch ')).slice(0,2);
  if(alternatives.length===2){
    const traces:EpisodeTrace[]=[],games:Array<{episode:number;variant:string;log:string;ended:boolean}>=[];
    try{
      const report=runSimulation({kind:'branch',regulationId:'champions-vgc-2026-m-c',teams:{p1:{preview:choice.teams.p1.pokemon.map(p=>p.species),team:choice.teams.p1,publicKnown:sheets(choice.record.log).p1},p2:{preview:choice.teams.p2.pokemon.map(p=>p.species),team:choice.teams.p2,publicKnown:sheets(choice.record.log).p2}},metaTeams:[],usageRows:[],samples:4,maxTurns:60,budgetMs:20000,seed:`${choice.record.id}:bounded-counterfactual`,informationMode:'open_sheet',policies:{p1:'tactical',p2:'tactical'},actor:'p1',checkpoint:choice.checkpoint,branches:alternatives.map((action,index)=>({label:`alternative_${index+1}: ${action.command}`,command:action.command}))},{trace:trace=>traces.push(trace),game:game=>games.push(game)});
      counterfactual={status:'executed',replayId:choice.record.id,decisionTurn:1,pair:choice.pair,checkpointOrigin:'Mechanically reconstructed from the real public prefix; conditioning on this one hypothetical sheet-derived spread/selection scenario.',alternatives:alternatives.map(({command,score,probability})=>({command,score,probability})),report,traces,games};
    }catch(error){counterfactual={status:'failed',replayId:choice.record.id,reason:error instanceof Error?error.message:String(error)};}
  }else counterfactual={status:'unavailable',replayId:choice.record.id,reason:'Fewer than two distinct legal move-only joint actions at the supported root.'};
}
const artifact={protocol,eligibleDevelopmentGames:eligible.length,results,counterfactual,limitations:['All own and opposing hidden stat investments are hypothetical scenarios, not recovered actual private sets.','The engine reconstructs HP, PP and counters by matching the prefix; no observed outcome after each decision boundary is used to construct that boundary.','Per-attempt deadlines are checked between synchronous engine operations and may overshoot by one engine operation.','A failed 128-attempt/500ms search is bounded coverage failure, not proof that the replay is impossible.','Four samples per counterfactual branch illustrate adaptive continuations only, not reliable action rankings or human win probabilities.','No learned-policy parameters or final-test split were changed.']};
writeFileSync(join(output,'reconstruction-evaluation.json'),JSON.stringify(artifact,null,2)+'\n');
console.log(JSON.stringify({phase:'complete',selected:selected.length,counterfactualStatus:(counterfactual as {status:string}).status,replayId:(counterfactual as {replayId?:string}).replayId}));
