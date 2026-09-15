import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {runCohortExperiment,type CohortRequest,type CohortReport} from '../src/simulation/experiment.js';
import type {MetaTeam} from '../src/domain/contracts.js';
import {sha256} from '../src/util/hash.js';
import {DEFAULT_SEARCH} from '../src/simulation/runner.js';

const directory='.vgc-helper/experiments/m-c';mkdirSync(directory,{recursive:true});
const source=JSON.parse(readFileSync(`${directory}/featured-cohort.json`,'utf8')) as {csvHash:string;selection:string;teams:MetaTeam[]};
if (!source.teams.length || source.teams.some(team=>team.regulationId!=='champions-vgc-2026-m-c')) throw new Error('Supply a fresh M-C cohort; historical cohorts cannot be relabeled.');
const mode=process.argv[2]??'baseline';
if(!['baseline','search','search-detailed','plans','spreads'].includes(mode))throw new Error('Choose baseline, search, search-detailed, plans or spreads');
const searching=mode.startsWith('search');
const samples=searching?3:mode==='spreads'?4:8;
const results:Array<{teamId:string;report:CohortReport}>=[],games:unknown[]=[];
const inputs=mode==='baseline'?source.teams:source.teams.slice(0,1);
const frozen={mode,samples,teamIds:source.teams.map(t=>t.id),csvHash:source.csvHash,selection:source.selection,seed:'featured-evaluation-v1',settings:{search:mode==='search-detailed'?DEFAULT_SEARCH:{iterations:4,budgetMs:150,maxTurns:2,maxDepth:6,candidateCap:4,confirmationSamples:1}},frozenAt:new Date().toISOString()};
writeFileSync(`${directory}/${mode}-configuration.json`,JSON.stringify(frozen,null,2));
for(const player of inputs){
  const opponents=source.teams.filter(t=>t.id!==player.id).map(team=>mode==='spreads'?{...team,pokemon:team.pokemon.map(p=>({...p,skillPoints:{},provenance:{...p.provenance,skillPoints:{knowledge:'unknown' as const,confidence:0,source:'deliberately masked for uncertainty sensitivity'}}}))}:team);
  const request:CohortRequest={kind:'cohort',regulationId:'champions-vgc-2026-m-c',team:{name:player.name,pokemon:player.pokemon},opponents,metaTeams:mode==='spreads'?[player,...opponents]:source.teams,usageRows:[],samples,maxTurns:60,budgetMs:mode==='spreads'?90000:180000,seed:frozen.seed,informationMode:'closed',playerPolicy:searching?'search':'tactical',policyProfiles:searching||mode==='spreads'?['tactical']:['tactical','damage'],search:frozen.settings.search,
    ...(mode==='plans'?{fixedPlan:player.pokemon.slice(0,4).map(p=>p.species),compareReselectedPlan:true}:{})};
  console.log(JSON.stringify({stage:'starting',mode,teamId:player.id,opponents:opponents.map(t=>t.id),samples}));
  let last=0;
  const report=runCohortExperiment(request,{progress:value=>{if(Date.now()-last>5000){last=Date.now();const p=value as Record<string,unknown>;console.log(JSON.stringify({teamId:player.id,completedMatchups:p.completedMatchups,opponentId:p.opponentId,policy:p.policy}));}},game:value=>games.push({teamId:player.id,...value})});
  results.push({teamId:player.id,report});
  console.log(JSON.stringify({stage:'completed',teamId:player.id,status:report.status,aggregate:report.aggregate,sensitivity:report.sensitivity}));
  writeFileSync(`${directory}/${mode}-evaluation.json`,JSON.stringify({configuration:frozen,configurationHash:sha256(JSON.stringify(frozen)),results},null,2));
  writeFileSync(`${directory}/${mode}-games.jsonl`,games.map(game=>JSON.stringify(game)).join('\n')+'\n');
}
