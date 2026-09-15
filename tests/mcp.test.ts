import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {readFileSync,unlinkSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {AppContext} from '../src/app/context.js';
import {createMcpServer} from '../src/mcp/server.js';
import {parseShowdownTeam} from '../src/teams/parser.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import {EngineSession,completePreviewTeam} from '../src/simulation/engine.js';
import {parseReplay,loadReplay} from '../src/replay/index.js';

describe('MCP server', () => {
  let context: AppContext;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    context = new AppContext({databasePath: ':memory:'});
    server = createMcpServer(context);
    client = new Client({name: 'vgc-helper-test', version: '1.0.0'});
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    context.close();
  });

  it('advertises the complete V0 MCP surface', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'vgc_battle_agent_submit',
      'vgc_battle_agent_view',
      'vgc_battle_cancel',
      'vgc_battle_get',
      'vgc_battle_open',
      'vgc_battle_rematch',
      'vgc_battle_rules',
      'vgc_battle_start',
      'vgc_damage_calculate',
      'vgc_matchup_detail',
      'vgc_meta_query',
      'vgc_player_evaluate',
      'vgc_player_submit',
      'vgc_player_view',
      'vgc_reasoning_battle_cancel',
      'vgc_reasoning_battle_continue',
      'vgc_reasoning_battle_get',
      'vgc_reasoning_battle_start',
      'vgc_refresh_meta',
      'vgc_replay_analyze',
      'vgc_replay_counterfactual',
      'vgc_replay_export_html',
      'vgc_replay_get',
      'vgc_replay_trends',
      'vgc_replay_turn',
      'vgc_simulate_battle',
      'vgc_simulate_cohort',
      'vgc_simulation_cancel',
      'vgc_simulation_get',
      'vgc_simulation_trace',
      'vgc_status',
      'vgc_team_evaluate',
    ]);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual([
      'replay-coach',
      'team-builder',
    ]);

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri).sort()).toEqual([
      'vgc://methodology/v0',
      'vgc://regulation/active',
      'vgc://sources/status',
    ]);
  });

  it('returns status and runs a structured Champions damage tool', async () => {
    const status = await client.callTool({name: 'vgc_status', arguments: {}});
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      result: {
        regulation: {id: 'champions-vgc-2026-m-c'},
        ready: false,
      },
    });

    const damage = await client.callTool({
      name: 'vgc_damage_calculate',
      arguments: {
        attacker_set: `Garchomp @ Life Orb
Ability: Rough Skin
EVs: 20 Atk / 20 Spe
Jolly Nature
- Earthquake`,
        defender_set: `Kingambit @ Black Glasses
Ability: Defiant
EVs: 20 HP / 20 Atk
Adamant Nature
- Kowtow Cleave`,
        move: 'Earthquake',
      },
    });
    expect(damage.isError).not.toBe(true);
    expect(damage.structuredContent).toMatchObject({
      result: {
        move: 'Earthquake',
        calculatorVersion: 'smogon/damage-calc@e7fd7e5+seed-description.1',
      },
    });
  });

  it('serves the active regulation as a resource', async () => {
    const resource = await client.readResource({
      uri: 'vgc://regulation/active',
    });
    expect(resource.contents[0]).toMatchObject({
      uri: 'vgc://regulation/active',
      mimeType: 'application/json',
    });
    const content = resource.contents[0];
    expect(content && 'text' in content ? content.text : '').toContain(
      'champions-vgc-2026-m-c',
    );
  });

  it('exports direct logs and only the requested perspective of saved battle logs',async()=>{
    const now=new Date().toISOString();
    const lines=['|player|p1|Alice|','|player|p2|Bob|','|tier|[Gen 9] OU','|start','|turn|1','|-damage|p2a: Pikachu|50/100','|win|Alice'];
    const p2Lines=lines.map(line=>line.replace('50/100','120/240'));
    context.repository.database.prepare('INSERT INTO simulation_jobs (id,owner_pid,owner_id,status,created_at,updated_at,request_json) VALUES (?,?,?,?,?,?,?)').run('export-fixture',process.pid,'fixture','completed',now,now,'{}');
    context.repository.database.prepare('INSERT INTO simulation_traces VALUES (?,?,?)').run('export-fixture',0,JSON.stringify({episode:0,variant:'battle',outcome:'p1',decisions:[],checkpoints:[{secret:'private-checkpoint-sentinel'}],battleLogs:{p1:{lines,ended:true,turn:1},p2:{lines:p2Lines,ended:true,turn:1}}}));
    for(const input of [{battle_log:{lines,status:'complete'}},{job_id:'export-fixture',perspective:'p1'},{job_id:'export-fixture',perspective:'p2'}]){
      const path=resolve('.vgc-helper',`mcp-export-test-${randomUUID()}.html`);
      try{
        const response=await client.callTool({name:'vgc_replay_export_html',arguments:{...input,output_path:path}});
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({result:{path,status:'complete',mimeType:'text/html'}});
        const exported=loadReplay({path}).log;
        expect(exported).toBe(('perspective' in input&&input.perspective==='p2'?p2Lines:lines).join('\n'));
        expect(readFileSync(path,'utf8')).not.toContain('private-checkpoint-sentinel');
      }finally{if(existsSync(path))unlinkSync(path);}
    }
    for(const input of [{},{job_id:'export-fixture',battle_log:lines},{job_id:'missing'},{job_id:'export-fixture',trace_index:1},{battle_log:{lines:[],status:'unavailable'}}]){
      const response=await client.callTool({name:'vgc_replay_export_html',arguments:input});
      expect(response.isError).toBe(true);
    }
  });

  it('runs a real worker and exposes only the selected player trace', async()=>{
    const team_export=readFileSync('examples/sample-team.txt','utf8');
    const preview=parseShowdownTeam(team_export,loadRegulationProfile()).pokemon.map(p=>p.species);
    const started=await client.callTool({name:'vgc_simulate_battle',arguments:{p1:{team_export},p2:{preview},samples:1,max_turns:35,budget_ms:30000,seed:'mcp-test',action_selection:{topFraction:0.2,maxScoreGap:18}}});
    expect(started.isError).not.toBe(true);
    const id=(started.structuredContent as {result:{id:string}}).result.id;
    let job:Record<string,unknown>={status:'running'};
    const deadline=Date.now()+20000;
    while(['queued','running'].includes(String(job.status))&&Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,30));
      job=((await client.callTool({name:'vgc_simulation_get',arguments:{job_id:id}})).structuredContent as {result:Record<string,unknown>}).result;
    }
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({variants:[{games:1,invalid:0}],configuration:{actionSelection:{topFraction:0.2,maxScoreGap:18}}});
    const trace=await client.callTool({name:'vgc_simulation_trace',arguments:{job_id:id,perspective:'p1'}});
    const page=(trace.structuredContent as {result:{items:Array<{decisions:Array<{side:string}>}>}}).result;
    expect(page.items[0]!.decisions.every(d=>d.side==='p1')).toBe(true);
    expect(JSON.stringify(page)).not.toContain('checkpoint');
    for(const perspective of ['p1','p2']){
      const response=await client.callTool({name:'vgc_simulation_trace',arguments:{job_id:id,perspective}});
      const item=(response.structuredContent as any).result.items[0];
      expect(item.battleLog).toMatchObject({status:'complete',ended:true});
      expect(item.battleLog.lines).toContain(`|win|${item.outcome}`);
      expect(item.decisions.every((d:any)=>d.side===perspective)).toBe(true);
      expect(item).not.toHaveProperty('battleLogs');
      const opponent=perspective==='p1'?'p2':'p1';
      const opponentHp=item.battleLog.lines.filter((line:string)=>new RegExp(`^\\|(switch|drag|-damage|-heal)\\|${opponent}`).test(line)).map((line:string)=>line.split('|')[line.startsWith('|switch|')||line.startsWith('|drag|')?4:3]);
      expect(opponentHp.some((hp:string)=>hp.includes('/100'))).toBe(true);
      expect(opponentHp.every((hp:string)=>/^(\d+\/100|0 fnt)( |$)/.test(hp))).toBe(true);
    }
    const cancelled=await client.callTool({name:'vgc_simulation_cancel',arguments:{job_id:id}});
    expect(cancelled.structuredContent).toMatchObject({result:{status:'completed'}});
  },30000);

  it('marks legacy stored traces as missing a battle log instead of presenting decision observations as complete',async()=>{
    const now=new Date().toISOString();
    context.repository.database.prepare('INSERT INTO simulation_jobs (id,owner_pid,owner_id,status,created_at,updated_at,request_json) VALUES (?,?,?,?,?,?,?)').run('legacy-trace',process.pid,'old-server','completed',now,now,'{}');
    context.repository.database.prepare('INSERT INTO simulation_traces VALUES (?,?,?)').run('legacy-trace',0,JSON.stringify({episode:0,variant:'battle',outcome:'p1',decisions:[{side:'p1',turn:3,observations:['|turn|3']}],checkpoints:[]}));
    const response=await client.callTool({name:'vgc_simulation_trace',arguments:{job_id:'legacy-trace'}});
    const item=(response.structuredContent as any).result.items[0];
    expect(item.battleLog).toMatchObject({status:'unavailable',lines:[],reason:expect.stringMatching(/rerun/i)});
    expect(item.decisions[0].observations).toEqual(['|turn|3']);
  });

  it('starts sampled counterfactuals from a saved public replay analysis',async()=>{
    const own=parseShowdownTeam(readFileSync('examples/sample-team.txt','utf8'),loadRegulationProfile());
    const foe=completePreviewTeam(own.pokemon.map(p=>p.species));
    const game=EngineSession.create({teams:{p1:own,p2:foe},seed:[4,3,2,1]});
    game.step({p1:'team 1234',p2:'team 1234'});
    const replay=parseReplay(loadReplay({content:game.view('p1').observations.join('\n')}));
    const saved=context.repository.saveReplay(replay);
    const analysis=context.repository.saveAnalysis({type:'replay',replayId:saved.id,analysis:{replayId:saved.id,userTeam:own,playerSide:'p1',regulationId:loadRegulationProfile().id}});
    const result=await client.callTool({name:'vgc_replay_counterfactual',arguments:{analysis_id:analysis.id,turn:1,samples:1,max_turns:2,budget_ms:30000,seed:'public-mcp'}});
    expect(result.isError).not.toBe(true);
    const jobId=(result.structuredContent as {result:{id:string}}).result.id;
    let job=context.simulations.get(jobId);const deadline=Date.now()+20000;
    while(['queued','running'].includes(job.status)&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,25));job=context.simulations.get(jobId);}
    expect(job.status,job.error).toBe('completed');
    expect(job.result).toMatchObject({outcomePerspective:'p1',configuration:{startState:'public-prefix-conditioned'},variants:[{invalid:0},{invalid:0},{invalid:0}]});
  },30000);
  it('executes an automatic Featured Teams cohort through the worker with search and paired plans',async()=>{
    const team_export=readFileSync('examples/sample-team.txt','utf8'),profile=loadRegulationProfile(),team=parseShowdownTeam(team_export,profile);
    context.repository.activateMetaSnapshot({regulationId:profile.id,sourceSnapshotIds:[],teams:[{id:'cohort-fixture',name:'Champion fixture',placement:'Champion',date:'2026-09-07',regulationId:profile.id,pokemon:team.pokemon,roster:team.pokemon.map(p=>p.species),exactSets:true,source:{provider:'vgc-pastes',retrievedAt:'2026-09-07'}}]});
    const started=await client.callTool({name:'vgc_simulate_cohort',arguments:{team_export,cohort_size:1,policy_profiles:['damage'],player_policy:'search',search:{iterations:1,budgetMs:100,maxTurns:1,maxDepth:1,candidateCap:1,confirmationSamples:0},fixed_plan:team.pokemon.slice(0,4).map(p=>p.species),compare_reselected_plan:true,samples:1,max_turns:1,budget_ms:10000,seed:'cohort-worker'}});
    expect(started.isError).not.toBe(true);
    const id=(started.structuredContent as {result:{id:string}}).result.id;
    let job=context.simulations.get(id);const deadline=Date.now()+15000;
    while(['queued','running'].includes(job.status)&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,25));job=context.simulations.get(id);}
    expect(job.status,job.error).toBe('completed');
    expect(job.result).toMatchObject({method:'cohort-policy-sensitivity-v1',matchups:[{opponentId:'cohort-fixture',report:{variants:[{label:'fixed plan',games:1,invalid:0},{label:'reselected plan',games:1,invalid:0}]}}]});
    expect(job.progress).toMatchObject({completedMatchups:1,completedResults:[{opponentId:'cohort-fixture'}]});
  },30000);
  it('persists contextual modes and same-cohort comparisons and retrieves bounded details', async()=>{
    const teamExport=readFileSync('examples/sample-team.txt','utf8');
    const profile=loadRegulationProfile();
    const parsed=parseShowdownTeam(teamExport,profile);
    context.repository.activateMetaSnapshot({regulationId:profile.id,sourceSnapshotIds:[],teams:[{
      id:'fixture',name:'fixture',regulationId:profile.id,pokemon:parsed.pokemon,roster:parsed.pokemon.map(s=>s.species),exactSets:true,
      source:{provider:'fixture',retrievedAt:'2026-09-04'},
    }]});
    const response=await client.callTool({name:'vgc_team_evaluate',arguments:{team_export:teamExport,
      evaluation_context:{priorityThreats:['Charizard-Mega-Y'],roles:[{pokemon:'Garchomp',move:'Rock Slide',purpose:'Charizard coverage',target:'Charizard-Mega-Y'}],
        modes:[{id:'fixed-four',bringFour:['Garchomp','Whimsicott','Kingambit','Sneasler'],mega:null}]},
      comparison_team_export:teamExport.replace('- Rock Slide','- Poison Jab'),
    }});
    expect(response.isError).not.toBe(true);
    const result=(response.structuredContent as {result:Record<string,any>}).result;
    expect(result.context.roles[0].purpose).toBe('Charizard coverage');
    expect(result.sources.some((s:{provider:string})=>s.provider==='fixture')).toBe(true);
    expect(result.coverage.omittedPriorityThreats[0].threat).toBe('Charizard-Mega-Y');
    expect(result.comparison.kind).toBe('same-scenario-damage-benchmarks');
    expect(result.comparison.matchupChanges[0].opponentTeamId).toBe('fixture');
    const detail=await client.callTool({name:'vgc_matchup_detail',arguments:{analysis_id:result.id,limit:1}});
    expect(detail.structuredContent).toMatchObject({result:{context:{priorityThreats:['Charizard-Mega-Y']}}});
    const details=(detail.structuredContent as {result:Record<string,any>}).result;
    expect(details.comparison.benchmarks.length).toBeLessThanOrEqual(1);
    expect(details.modePlans.some((p:{modeId:string})=>p.modeId==='fixed-four')).toBe(true);
    const end=await client.callTool({name:'vgc_matchup_detail',arguments:{analysis_id:result.id,opening_offset:1000000,limit:1}});
    expect(end.structuredContent).toMatchObject({result:{openingScenarios:[],nextOpeningOffset:null}});
  },30000);
  it('analyzes offline and retrieves the actual pre-turn evidence', async () => {
    const response = await client.callTool({name:'vgc_replay_analyze',arguments:{
      replay_content:readFileSync('examples/sample-replay.log','utf8'),
      team_export:readFileSync('examples/sample-team.txt','utf8'),player_name:'Alice',
    }});
    expect(response.isError).not.toBe(true);
    const result = (response.structuredContent as {result:{id:string;teamVersion:string;calculatorVersion:string}}).result;
    expect(result.teamVersion).toBeTruthy();
    const turn = await client.callTool({name:'vgc_replay_turn',arguments:{analysis_id:result.id,turn:1}});
    expect(turn.isError).not.toBe(true);
    expect(turn.structuredContent).toMatchObject({result:{turn:1,beforeEvents:{sides:{p1:{activeSlots:['p1a','p1b']}}}}});
    const trends = await client.callTool({name:'vgc_replay_trends',arguments:{team_version:result.teamVersion}});
    expect(trends.structuredContent).toMatchObject({result:{analysisCount:1}});
  });
});
