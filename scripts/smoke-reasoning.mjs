import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

// Scripted protocol regression, intentionally not presented as an LLM-quality evaluation.
const directory=resolve('.vgc-helper','reasoning-smoke',randomUUID());await mkdir(directory,{recursive:true});
const database=resolve(directory,'match.sqlite'),clients=[];
async function connect(playerToken){
  const client=new Client({name:'external-reasoning-smoke',version:'1'});
  const env={...process.env,VGC_HELPER_DATABASE:database};delete env.VGC_PLAYER_TOKEN;
  if(playerToken)env.VGC_PLAYER_TOKEN=playerToken;
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/index.js')],env,stderr:'pipe'}));
  clients.push(client);return client;
}
async function call(client,name,args={}){
  const response=await client.callTool({name,arguments:args},undefined,{timeout:30000});
  assert.ok(!response.isError,JSON.stringify(response.content));return response.structuredContent.result;
}
try{
  const coordinator=await connect();const names=['Forretress','Glalie','Metagross','Garbodor','Vanilluxe','Glimmora'];
  const exported=names.map(name=>`${name}\nLevel: 50\nEVs: 32 HP / 32 Atk / 2 SpD\nAdamant Nature\n- Explosion\n- Protect\n- Substitute\n- Rest`).join('\n\n');
  const start=await call(coordinator,'vgc_reasoning_battle_start',{p1:{team_export:exported},p2:{team_export:exported},max_turns:12,budget_ms:180000,seed:'external-protocol-smoke'});
  const p1=await connect(start.players.p1.playerToken),p2=await connect(start.players.p2.playerToken);
  assert.deepEqual((await p1.listTools()).tools.map(t=>t.name).sort(),['vgc_player_evaluate','vgc_player_submit','vgc_player_view']);
  const tokenPath=resolve(directory,'p1.token');await writeFile(tokenPath,start.players.p1.playerToken);
  const bridge=spawn(process.execPath,['scripts/reasoning-player.mjs','--token-file',tokenPath,'--database',database],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',errors='';bridge.stdout.on('data',chunk=>output+=chunk);bridge.stderr.on('data',chunk=>errors+=chunk);
  bridge.stdin.end(JSON.stringify({tool:'vgc_player_view',arguments:{}}));
  const code=await new Promise((done,reject)=>{bridge.once('error',reject);bridge.once('exit',done);});assert.equal(code,0,errors);assert.equal(JSON.parse(output).side,'p1');
  const before=await call(p2,'vgc_player_view');
  await call(p1,'vgc_player_submit',{decision_id:before.decisionId,command:'team 1234',summary:'Scripted protocol test only',plan:'private smoke sentinel',agent:'scripted-smoke'});
  assert.deepEqual(await call(p2,'vgc_player_view'),before);
  assert.ok(!JSON.stringify(await call(coordinator,'vgc_reasoning_battle_get',{admin_token:start.adminToken})).includes('private smoke sentinel'));
  await call(p2,'vgc_player_submit',{decision_id:before.decisionId,command:'team 1234',summary:'Scripted protocol test only',agent:'scripted-smoke'});
  const view=await call(p1,'vgc_player_view');
  const evaluation=await call(p1,'vgc_player_evaluate',{decision_id:view.decisionId,plans:[{label:'Explosion',command:view.evidence.legalCommands[0]}],samples:1,max_turns:1,budget_ms:1000});
  for(let phase=0;phase<40;phase++){
    if((await call(coordinator,'vgc_reasoning_battle_get',{admin_token:start.adminToken})).status!=='active')break;
    for(const player of [p1,p2]){
      const state=await call(player,'vgc_player_view');if(state.status!=='decision')continue;
      await call(player,'vgc_player_submit',{decision_id:state.decisionId,command:state.evidence.legalCommands[0],summary:'Scripted protocol test only',agent:'scripted-smoke'});
    }
  }
  const final=await call(coordinator,'vgc_reasoning_battle_get',{admin_token:start.adminToken});assert.equal(final.status,'completed');
  assert.ok(final.result.battleLogs.p1.lines.some(line=>/^\|(win|tie)\|?/.test(line)));
  await writeFile(resolve(directory,'result.json'),JSON.stringify(final,null,2));
  const replay=await call(coordinator,'vgc_replay_export_html',{battle_log:final.result.battleLogs.p1,output_path:resolve(directory,'replay.html'),title:'External-player protocol smoke'});
  assert.equal(replay.status,'complete');
  console.log(JSON.stringify({status:final.status,turns:final.turn,decisions:final.result.decisions.length,scenarioStatus:evaluation.result.status,
    isolation:'separate bound stdio MCP processes',driver:'scripted protocol check; no LLM-quality claim',report:resolve(directory,'result.json')}));
}finally{for(const client of clients.reverse())await client.close();}
