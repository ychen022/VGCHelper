import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {readFileSync} from 'node:fs';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {AppContext} from '../src/app/context.js';
import {createMcpServer} from '../src/mcp/server.js';
import {parseShowdownTeam} from '../src/teams/parser.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';

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
      'vgc_damage_calculate',
      'vgc_matchup_detail',
      'vgc_meta_query',
      'vgc_refresh_meta',
      'vgc_replay_analyze',
      'vgc_replay_get',
      'vgc_replay_trends',
      'vgc_replay_turn',
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
        regulation: {id: 'champions-vgc-2026-m-b'},
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
        calculatorVersion: 'smogon/damage-calc@2c50a89',
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
      'champions-vgc-2026-m-b',
    );
  });
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
