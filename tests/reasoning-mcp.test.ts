import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {afterEach,expect,it} from 'vitest';
import {AppContext} from '../src/app/context.js';
import {createMcpServer} from '../src/mcp/server.js';
import {EngineSession,completePreviewTeam} from '../src/simulation/engine.js';
import {parseReplay,loadReplay} from '../src/replay/index.js';
const cleanup:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function connect(context:AppContext,playerToken?:string){
  const server=createMcpServer(context,playerToken?{playerToken}:{}),client=new Client({name:'reasoning-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  cleanup.push(async()=>{await client.close();await server.close();});return client;
}
it('offers a bound player-only MCP surface and rejects credential overrides and coordinator calls',async()=>{
  const context=new AppContext({databasePath:':memory:'});cleanup.push(()=>context.close());
  const coordinator=await connect(context),preview=['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion'];
  const response=await coordinator.callTool({name:'vgc_reasoning_battle_start',arguments:{p1:{preview},p2:{preview},max_turns:2}});
  expect(response.isError).not.toBe(true);
  const start=(response.structuredContent as {result:unknown}).result as {adminToken:string;players:{p1:{playerToken:string};p2:{playerToken:string}}};
  const p1=await connect(context,start.players.p1.playerToken);
  expect((await p1.listTools()).tools.map(t=>t.name).sort()).toEqual(['vgc_player_evaluate','vgc_player_submit','vgc_player_view']);
  expect((await p1.callTool({name:'vgc_player_view',arguments:{}})).isError).not.toBe(true);
  const view=context.reasoning.playerView(start.players.p1.playerToken);
  expect((await p1.callTool({name:'vgc_player_submit',arguments:{decision_id:view.decisionId,command:'team 1234',summary:'test',private_plan:'must not be silently discarded'}})).isError).toBe(true);
  expect(context.reasoning.playerView(start.players.p1.playerToken).status).toBe('decision');
  expect((await p1.callTool({name:'vgc_player_view',arguments:{player_token:start.players.p2.playerToken}})).isError).toBe(true);
  expect((await p1.callTool({name:'vgc_reasoning_battle_get',arguments:{admin_token:start.adminToken}})).isError).toBe(true);
  expect((await coordinator.callTool({name:'vgc_player_view',arguments:{}})).isError).toBe(true);
});
it('starts external players from a saved replay prefix and excludes future events',async()=>{
  const context=new AppContext({databasePath:':memory:'});cleanup.push(()=>context.close());
  const client=await connect(context),names=['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion'];
  const team=completePreviewTeam(names),game=EngineSession.create({teams:{p1:team,p2:team},seed:[4,3,2,1]});
  game.step({p1:'team 1234',p2:'team 1234'});
  const replay=parseReplay(loadReplay({content:game.view('p1').observations.join('\n')+'\n|turn|2\n|-message|FUTURE_SENTINEL'}));
  const saved=context.repository.saveReplay(replay),analysis=context.repository.saveAnalysis({type:'replay',replayId:saved.id,
    analysis:{replayId:saved.id,userTeam:team,playerSide:'p1',regulationId:'champions-vgc-2026-m-b'}});
  const response=await client.callTool({name:'vgc_reasoning_battle_continue',arguments:{analysis_id:analysis.id,turn:1,max_turns:2,seed:'prefix-test'}});
  expect(response.isError,JSON.stringify(response.content)).not.toBe(true);
  const start=(response.structuredContent as {result:unknown}).result as {players:{p1:{playerToken:string}}};
  const view=context.reasoning.playerView(start.players.p1.playerToken);
  expect(view.turn).toBe(1);expect(view.evidence.informationMode).toBe('replay_observed');
  expect(JSON.stringify(view)).not.toContain('FUTURE_SENTINEL');
  // A public turn-1 prefix reveals the leads but not the two selected reserves.
  expect(view.evidence.request.active).toEqual(game.view('p1').request.active);
  expect(view.evidence.request.side.pokemon.filter(p=>p.active)).toEqual(game.view('p1').request.side.pokemon.filter(p=>p.active));
});
