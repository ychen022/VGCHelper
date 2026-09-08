import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {behaviorSummary,normalizeCorpusRecord} from '../src/simulation/corpus.js';
import {readOpenSheet} from '../src/replay/sheets.js';
import {speciesIdentity} from '../src/simulation/identity.js';
import type {MetaTeam} from '../src/domain/contracts.js';
import type {CohortReport} from '../src/simulation/experiment.js';
const dir='.vgc-helper/experiments/stages-4-6';
const read=(name:string)=>JSON.parse(readFileSync(`${dir}/${name}`,'utf8'));
const cohort=read('featured-cohort.json') as {teams:MetaTeam[]};
const corpus=read('corrected-corpus/corpus-evaluation.json');
const records=readFileSync(`${dir}/holidayougi-mb.jsonl`,'utf8').trim().split('\n').map(line=>normalizeCorpusRecord(JSON.parse(line)));
const modes:Record<string,unknown>={};
for(const mode of ['baseline','search','search-detailed','plans','spreads']){
  if(!existsSync(`${dir}/${mode}-evaluation.json`))continue;
  const evaluation=read(`${mode}-evaluation.json`) as {results:Array<{teamId:string;report:CohortReport}>};
  const games=readFileSync(`${dir}/${mode}-games.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {log:string});
  const matchups=evaluation.results.flatMap(r=>r.report.matchups);
  const variants=matchups.flatMap(m=>m.report.variants);
  modes[mode]={totalGames:variants.reduce((n,v)=>n+v.games,0),invalid:variants.reduce((n,v)=>n+v.invalid,0),unresolved:variants.reduce((n,v)=>n+v.unresolved,0),behavior:behaviorSummary(games.map(g=>g.log)),
    teams:evaluation.results.map(r=>({teamId:r.teamId,status:r.report.status,aggregate:r.report.aggregate,sensitivity:r.report.sensitivity})),
    search:Object.fromEntries(['decisions','iterations','cappedRollouts','invalidRollouts','fallbacks','confirmationSamples','confirmationTerminal'].map(key=>[key,matchups.reduce((n,m)=>n+Number(m.report.search[key as keyof typeof m.report.search]),0)])),
    comparisons:matchups.filter(m=>m.report.comparison).map(m=>({opponentId:m.opponentId,policy:m.policy,variants:m.report.variants,comparison:m.report.comparison})),
  };
}
const roster=(names:string[])=>names.map(speciesIdentity).sort().join(',');
const teamKeys=new Set(cohort.teams.map(t=>roster(t.pokemon.map(p=>p.species))));
const id=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]/g,'');
let directlyMatchedBattles=0;
const appearances=cohort.teams.map(team=>({id:team.id,name:team.name,rosterAppearances:0,wins:0,losses:0,unresolved:0,matchingPublishedSheet:0,differentPublishedSheet:0,noFullSheet:0}));
for(const record of records){
  const lines=record.log.split('\n').map(line=>line.split('|'));
  const keys=['p1','p2'].map(side=>roster(lines.filter(p=>p[1]==='poke'&&p[2]===side).map(p=>p[3]!.split(',')[0]!)));
  if(keys.every(key=>teamKeys.has(key)))directlyMatchedBattles++;
  for(const side of ['p1','p2'] as const){
    const index=cohort.teams.findIndex(t=>roster(t.pokemon.map(p=>p.species))===keys[side==='p1'?0:1]);if(index<0)continue;
    const team=cohort.teams[index]!,out=appearances[index]!;out.rosterAppearances++;
    const winner=lines.find(p=>p[1]==='win')?.[2],player=lines.find(p=>p[1]==='player'&&p[2]===side)?.[3];
    if(winner&&player){if(winner===player)out.wins++;else out.losses++;}else out.unresolved++;
    const sheet=lines.find(p=>p[1]==='showteam'&&p[2]===side);
    const sets=sheet?readOpenSheet(sheet.slice(3).join('|')):[];
    if(sets.length!==6)out.noFullSheet++;
    else if(sets.every(set=>{const actual=team.pokemon.find(p=>speciesIdentity(p.species)===speciesIdentity(set.species));return actual&&['item','ability','nature'].every(field=>{const f=field as 'item'|'ability'|'nature';return set[f]===undefined||id(set[f]!)===id(actual[f]??'');})&&set.moves.map(id).sort().join(',')===actual.moves.map(id).sort().join(',');}))out.matchingPublishedSheet++;
    else out.differentPublishedSheet++;
  }
}
const result={generatedAt:new Date().toISOString(),modes,real:{overall:corpus.distributions,development:corpus.splitDistributions.validation,heldoutRecheck:corpus.splitDistributions.test,appearances,directlyMatchedBattles},learning:{evaluationUse:corpus.evaluationUse,audit:corpus.audit,metrics:corpus.evaluation.test,adoption:corpus.artifactAdoption},
  limitations:['Published cohort performance is conditional bot-versus-bot evidence, not a human metagame ranking.','Replay roster appearances usually face different opponents and need not share published sets or hidden investment; their outcomes are not direct validation of the cohort win estimates.','Behavior frequency differences combine team composition, opponent strength, selection bias and policy differences. Do not tune a policy merely to match aggregate rates.','Corrected corpus results reuse a previously inspected holdout to verify feature and metric correctness; a new holdout is required before claiming independent final calibration.']};
writeFileSync(`${dir}/evaluation-summary.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({modes:Object.fromEntries(Object.entries(modes).map(([key,value])=>{const v=value as any;return [key,{games:v.totalGames,invalid:v.invalid,unresolved:v.unresolved,meanTurns:v.behavior.turns.mean,protectPer100:v.behavior.protectPer100ExecutedMoves,controlPer100:v.behavior.controlPer100ExecutedMoves,voluntarySwitchesPerGame:v.behavior.voluntarySwitchesPerGame.mean,search:v.search}];})),real:{games:corpus.distributions.games,meanTurns:corpus.distributions.turns.mean,protectPer100:corpus.distributions.protectPer100ExecutedMoves,controlPer100:corpus.distributions.controlPer100ExecutedMoves,voluntarySwitchesPerGame:corpus.distributions.voluntarySwitchesPerGame.mean,appearances,directlyMatchedBattles}},null,2));
