import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {AppContext} from '../dist/app/context.js';
import {parseShowdownTeam} from '../dist/teams/parser.js';
import {loadRegulationProfile} from '../dist/regulation/profile.js';
import {loadReplay} from '../dist/replay/input.js';

// A separate directory per smoke invocation keeps ordinary project history intact.
const dataDirectory=resolve('.vgc-helper/simulation-smoke',randomUUID());
await mkdir(dataDirectory,{recursive:true});
const team=await readFile('examples/sample-team.txt','utf8');
const profile=loadRegulationProfile(),published=parseShowdownTeam(team,profile);
const fixture=new AppContext({databasePath:resolve(dataDirectory,'vgc-helper.sqlite')});
fixture.repository.activateMetaSnapshot({regulationId:profile.id,sourceSnapshotIds:[],teams:[{id:'smoke-featured',name:'Smoke champion',placement:'Champion',date:'2026-09-07',regulationId:profile.id,pokemon:published.pokemon,roster:published.pokemon.map(p=>p.species),exactSets:true,source:{provider:'vgc-pastes',retrievedAt:'smoke-fixture'}}]});
fixture.close();
const preview=['Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion','Dragonite'];
const terminal=new Set(['completed','partial','failed','cancelled','interrupted']);
const defaults={samples:2,max_turns:100,budget_ms:90000,seed:'compiled-simulation-smoke-v1'};
const summary={dataDirectory,startedAt:new Date().toISOString(),steps:[]};
let connection;
async function connect() {
  const client=new Client({name:'vgc-simulation-smoke',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/index.js')],env:{...process.env,VGC_HELPER_DATA_DIR:dataDirectory},stderr:'pipe'});
  let stderr='';
  transport.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-16000);});
  await client.connect(transport);
  return {client,stderr:()=>stderr};
}
async function tool(name,args={}) {
  const response=await connection.client.callTool({name,arguments:args},undefined,{timeout:30000});
  if(response.isError)throw new Error(`${name}: ${JSON.stringify(response)}`);
  assert.ok(response.structuredContent&&'result' in response.structuredContent,`${name} must return structured output`);
  return response.structuredContent.result;
}
function log(step,details={}) {console.log(JSON.stringify({step,...details}));}
async function waitJob(jobId,timeout=110000) {
  const deadline=Date.now()+timeout;let lastGames=-1;
  while(Date.now()<deadline) {
    const job=await tool('vgc_simulation_get',{job_id:jobId});
    const rows=job.result?.variants??job.progress?.variants??[];
    const games=rows.reduce((sum,row)=>sum+row.games,0);
    if(games!==lastGames){log('progress',{jobId,status:job.status,games});lastGames=games;}
    if(terminal.has(job.status))return job;
    await sleep(250);
  }
  await tool('vgc_simulation_cancel',{job_id:jobId});
  throw new Error(`Job ${jobId} exceeded smoke wait budget`);
}
function requireCompleted(job,variants,samples=defaults.samples) {
  assert.equal(job.status,'completed',JSON.stringify(job));
  assert.equal(job.result.variants.length,variants);
  for(const row of job.result.variants) {
    assert.equal(row.games,samples,JSON.stringify(row));
    assert.equal(row.invalid,0,JSON.stringify(job.result.warnings));
    assert.equal(row.unresolved,0,JSON.stringify(row));
    assert.equal(row.wins+row.losses+row.draws,row.games);
    assert.equal(typeof row.winRate,'number');
  }
}
try {
  connection=await connect();
  const available=await connection.client.listTools();
  for(const name of ['vgc_simulate_battle','vgc_simulate_cohort','vgc_replay_counterfactual','vgc_simulation_get','vgc_simulation_cancel','vgc_simulation_trace','vgc_replay_export_html'])assert.ok(available.tools.some(tool=>tool.name===name),name);
  const request={p1:{team_export:team},p2:{preview},...defaults,p1_policy:'damage',p2_policy:'damage',checkpoint_turns:[1,2]};
  const start=Date.now();
  const first=await tool('vgc_simulate_battle',request);
  assert.ok(['queued','running'].includes(first.status));
  assert.ok(Date.now()-start<10000,'Job creation should return promptly');
  log('exact-versus-preview-started',{jobId:first.id});
  const battle=await waitJob(first.id);requireCompleted(battle,1);
  const trace=await tool('vgc_simulation_trace',{job_id:first.id,perspective:'p1',limit:1});
  assert.ok(trace.items.length);
  assert.ok(trace.items.every(item=>!('checkpoints' in item)&&item.decisions.every(d=>d.side==='p1')));
  assert.ok(!JSON.stringify(trace).includes('engineRevision')&&!JSON.stringify(trace).includes('"prng"'));
  const finalLog=trace.items[0].battleLog;
  assert.equal(finalLog.status,'complete');assert.equal(finalLog.ended,true);
  assert.ok(finalLog.lines.includes(trace.items[0].outcome==='draw'?'|tie':`|win|${trace.items[0].outcome}`));
  assert.ok(finalLog.lines.slice(trace.items[0].decisions.at(-1).observations.length).some(line=>line.startsWith('|move|')));
  summary.steps.push({step:'complete-battle-log',jobId:first.id,turn:finalLog.turn,lines:finalLog.lines.length});
  const exported=await tool('vgc_replay_export_html',{job_id:first.id,perspective:'p1',title:'VGC Helper simulated battle'});
  assert.equal(exported.status,'complete');assert.equal(exported.mimeType,'text/html');
  assert.equal(loadReplay({path:exported.path}).log,finalLog.lines.join('\n'));
  summary.steps.push({step:'replay-html-export',...exported});
  const root=trace.items[0].decisions.find(d=>d.turn===1);
  assert.ok(root,'First-turn trace should accompany its saved private checkpoint');
  const alternatives=[...new Set([root.command,...root.alternatives.map(a=>a.command)])].slice(0,2);
  assert.equal(alternatives.length,2);
  summary.steps.push({step:'exact-versus-preview',jobId:first.id,variants:battle.result.variants});

  const branch=await tool('vgc_replay_counterfactual',{job_id:first.id,trace_index:0,turn:1,actor:'p1',actions:alternatives.map((command,i)=>({label:`root_${i+1}`,command})),...defaults,seed:'compiled-checkpoint-branches-v1'});
  log('checkpoint-branches-started',{jobId:branch.id});
  const branched=await waitJob(branch.id);requireCompleted(branched,2);
  assert.equal(branched.result.comparison.pairedSamples,defaults.samples);
  summary.steps.push({step:'checkpoint-branches',jobId:branch.id,variants:branched.result.variants,comparison:branched.result.comparison});

  const edited=team.replace('Jolly Nature','Adamant Nature');
  assert.notEqual(edited,team);
  const comparison=await tool('vgc_simulate_battle',{...request,comparison_team_export:edited,seed:'compiled-team-pair-v1'});
  log('paired-team-edit-started',{jobId:comparison.id});
  const compared=await waitJob(comparison.id);requireCompleted(compared,2);
  assert.equal(compared.result.comparison.pairedSamples,defaults.samples);
  summary.steps.push({step:'paired-team-edit',jobId:comparison.id,variants:compared.result.variants,comparison:compared.result.comparison});

  const cohort=await tool('vgc_simulate_cohort',{team_export:team,cohort_size:1,policy_profiles:['damage'],player_policy:'search',search:{iterations:2,budgetMs:50,maxTurns:1,maxDepth:2,candidateCap:2,confirmationSamples:1},fixed_plan:preview.slice(0,4),compare_reselected_plan:true,samples:1,max_turns:50,budget_ms:30000,seed:'compiled-cohort'});
  const cohortResult=await waitJob(cohort.id,45000);
  assert.equal(cohortResult.status,'completed');assert.equal(cohortResult.result.matchups.length,1);
  requireCompleted({status:'completed',result:cohortResult.result.matchups[0].report},2,1);
  assert.ok(cohortResult.result.matchups[0].report.search.decisions>0);
  summary.steps.push({step:'search-cohort-paired-plans',jobId:cohort.id,result:cohortResult.result});

  const cohortLong=await tool('vgc_simulate_cohort',{team_export:team,cohort_size:1,policy_profiles:['damage','search'],player_policy:'damage',samples:2,max_turns:50,budget_ms:60000,seed:'compiled-cohort-cancel'});
  let cohortProgress;const cohortCancelDeadline=Date.now()+30000;
  while(Date.now()<cohortCancelDeadline){cohortProgress=await tool('vgc_simulation_get',{job_id:cohortLong.id});if(cohortProgress.progress?.completedResults?.length)break;assert.ok(!terminal.has(cohortProgress.status));await sleep(30);}
  assert.ok(cohortProgress.progress.completedResults.length);
  const cancelledCohort=await tool('vgc_simulation_cancel',{job_id:cohortLong.id});
  assert.equal(cancelledCohort.status,'cancelled');assert.ok(cancelledCohort.progress.completedResults[0].variants[0].games>0);
  summary.steps.push({step:'cohort-cancel-retains-completed-matchups',jobId:cohortLong.id,progress:cancelledCohort.progress});

  const long=await tool('vgc_simulate_battle',{...request,samples:10000,budget_ms:180000,seed:'compiled-cancel-v1'});
  log('cancellation-job-started',{jobId:long.id});
  let progressing;const cancellationDeadline=Date.now()+45000;
  while(Date.now()<cancellationDeadline) {
    progressing=await tool('vgc_simulation_get',{job_id:long.id});
    if((progressing.progress?.variants??[]).some(row=>row.games>0))break;
    if(terminal.has(progressing.status))throw new Error(`Long job ended before cancellation: ${JSON.stringify(progressing)}`);
    await sleep(250);
  }
  assert.ok(progressing.progress?.variants.some(row=>row.games>0),'Cancellation must retain actual completed evidence');
  const cancelled=await tool('vgc_simulation_cancel',{job_id:long.id});
  assert.equal(cancelled.status,'cancelled');
  assert.ok(cancelled.progress.variants.some(row=>row.games>0));
  assert.equal((await tool('vgc_simulation_cancel',{job_id:long.id})).status,'cancelled');
  summary.steps.push({step:'cancelled-with-progress',jobId:long.id,progress:cancelled.progress});

  await connection.client.close();connection=await connect();
  const restored=await tool('vgc_simulation_get',{job_id:first.id});
  const restoredCancelled=await tool('vgc_simulation_get',{job_id:long.id});
  assert.deepEqual(restored.result,battle.result);
  const restoredTrace=await tool('vgc_simulation_trace',{job_id:first.id,perspective:'p1',limit:1});
  assert.deepEqual(restoredTrace,trace);
  assert.equal(restoredCancelled.status,'cancelled');
  assert.deepEqual(restoredCancelled.progress,cancelled.progress);
  summary.steps.push({step:'restart-persistence',completed:restored.status,cancelled:restoredCancelled.status});
  summary.completedAt=new Date().toISOString();
  await writeFile(resolve(dataDirectory,'smoke-result.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
} catch(error) {
  log('failed',{error:error instanceof Error?error.message:String(error),stderr:connection?.stderr()});
  process.exitCode=1;
} finally {await connection?.client.close();}
