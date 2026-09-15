#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

// A fresh agent can use this bridge when its host cannot attach a per-agent MCP configuration.
const args=process.argv.slice(2),value=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const tokenFile=value('--token-file'),database=value('--database');
const humanBattle=args.includes('--human-battle');
let client;
try{
  if(!tokenFile||!database)throw new Error('Usage: node scripts/reasoning-player.mjs --token-file <this-player-only.txt> --database <shared.sqlite>; pass {tool,arguments} JSON on stdin');
  const playerToken=(await readFile(tokenFile,'utf8')).trim();
  if(!/^[A-Za-z0-9_-]{43}$/.test(playerToken))throw new Error('Token file must contain only this player’s credential');
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>24000)throw new Error('Input exceeds 24 KB');}
  const call=JSON.parse(input);
  const allowed=humanBattle?['vgc_battle_agent_view','vgc_battle_agent_submit']:['vgc_player_view','vgc_player_evaluate','vgc_player_submit'];
  if(!allowed.includes(call.tool))throw new Error('Only the selected player tools are permitted');
  const root=fileURLToPath(new URL('../',import.meta.url));
  const environment={...process.env,VGC_HELPER_DATABASE:resolve(database)};
  delete environment.VGC_PLAYER_TOKEN;delete environment.VGC_BATTLE_AGENT_TOKEN;
  environment[humanBattle?'VGC_BATTLE_AGENT_TOKEN':'VGC_PLAYER_TOKEN']=playerToken;
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve(root,'dist/index.js')],cwd:root,
    env:environment,stderr:'pipe'});
  client=new Client({name:'isolated-reasoning-player',version:'1'});await client.connect(transport);
  const response=await client.callTool({name:call.tool,arguments:call.arguments??{}},undefined,{timeout:30000});
  if(response.isError)throw new Error(JSON.stringify(response.structuredContent??response.content));
  process.stdout.write(JSON.stringify(response.structuredContent?.result??response.content));
}catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
finally{await client?.close();}
