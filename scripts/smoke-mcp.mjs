import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const client=new Client({name:'vgc-smoke',version:'1.0.0'});
const transport=new StdioClientTransport({command:'node',args:[resolve('dist/index.js')],env:{...process.env,VGC_HELPER_DATA_DIR:resolve('.vgc-helper/smoke')},stderr:'pipe'});
await client.connect(transport);
try {
  const result=async(name,args={})=>{const response=await client.callTool({name,arguments:args},undefined,{timeout:300000});if(response.isError)throw new Error(JSON.stringify(response));return response.structuredContent.result;};
  const status=await result('vgc_status');console.log(JSON.stringify({step:'status',replayReady:status.replayReady,teamReady:status.teamReady}));
  const report=await result('vgc_replay_analyze',{replay_content:await readFile('examples/sample-replay.log','utf8'),team_export:await readFile('examples/sample-team.txt','utf8'),player_name:'Alice'});
  const turn=await result('vgc_replay_turn',{analysis_id:report.id,turn:1});
  const saved=await result('vgc_replay_get',{analysis_id:report.id});
  assert.equal(saved.teamVersion,report.teamVersion);
  const sets=(await readFile('examples/sample-team.txt','utf8')).trim().split(/\r?\n\s*\r?\n/);
  const damage=await result('vgc_damage_calculate',{attacker_set:sets[0],defender_set:sets[2],move:'Earthquake'});
  assert.ok(damage.range[1]>0);
  console.log(JSON.stringify({step:'offline-replay',findings:report.findings.length,turn:turn.turn,teamVersion:report.teamVersion}));
  console.log(JSON.stringify({step:'damage',range:damage.range,calculatorVersion:damage.calculatorVersion}));
  if(process.argv.includes('--refresh')) {
    const refreshed=await result('vgc_refresh_meta',{force:true}); console.log(JSON.stringify({step:'refresh',...refreshed}));
  }
  if(process.argv.includes('--refresh') || process.argv.includes('--team')) {
    const team=await result('vgc_team_evaluate',{team_export:await readFile('examples/sample-team.txt','utf8')});
    const detail=await result('vgc_matchup_detail',{analysis_id:team.id,limit:2});
    await mkdir('examples/reports',{recursive:true});
    await writeFile('examples/reports/team-smoke.json',JSON.stringify(team,null,2));
    console.log(JSON.stringify({step:'team-evaluation',metaTeams:team.metaTeamCount,matchups:team.matchupCount,openingScenarios:team.openingScenarioCount,details:detail.matchups.length}));
  }
} finally {await client.close();}
