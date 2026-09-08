import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parseShowdownTeam} from '../src/teams/parser.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import {loadReplay,parseReplay} from '../src/replay/index.js';
import {EngineSession,completePreviewTeam,type PlayerSide} from '../src/simulation/engine.js';
import {buildTeamBelief} from '../src/simulation/beliefs.js';
import {actionDistribution,chooseAction} from '../src/simulation/policy.js';
import {runSimulation,type SimulationRequest,type EpisodeTrace} from '../src/simulation/runner.js';

const team=parseShowdownTeam(readFileSync('examples/sample-team.txt','utf8'),loadRegulationProfile());
const preview=team.pokemon.map(p=>p.species);
const request:SimulationRequest={kind:'branch',regulationId:'champions-vgc-2026-m-b',teams:{p1:{team,preview},p2:{team,preview}},metaTeams:[],usageRows:[],samples:1,maxTurns:40,budgetMs:15000,seed:'branch-regression',informationMode:'closed',policies:{p1:'tactical',p2:'damage'}};
function rootGame(){const game=EngineSession.create({teams:{p1:team,p2:team},seed:[10,20,30,40]});game.step({p1:'team 1234',p2:'team 1234'});return game;}

describe('real branch continuations',()=>{
 it('rejects an actor who is waiting rather than silently dropping the root action',()=>{
  const game=EngineSession.create({teams:{p1:team,p2:team},seed:[10,20,30,40]});
  const belief=buildTeamBelief({regulationId:request.regulationId,preview,completionTeams:[completePreviewTeam(preview)]});
  let actor:PlayerSide|undefined;
  for(let step=0;step<60&&!game.view('p1').ended;step++){
   const views={p1:game.view('p1'),p2:game.view('p2')};
   if(views.p1.request.wait||views.p2.request.wait){actor=views.p1.request.wait?'p1':'p2';break;}
   game.step({p1:chooseAction(actionDistribution(views.p1,belief),`a${step}`),p2:chooseAction(actionDistribution(views.p2,belief),`b${step}`)});
  }
  expect(actor).toBeDefined();
  expect(()=>runSimulation({...request,actor:actor!,checkpoint:game.snapshot(),branches:[{label:'must not disappear',command:'NOT A LEGAL ACTION'}]})).toThrow(/no decision|checkpoint where.*acts/i);
 });
 it('validates every root command before starting any branch',()=>{
  expect(()=>runSimulation({...request,checkpoint:rootGame().snapshot(),branches:[{label:'invalid',command:'NOT A LEGAL ACTION'}]})).toThrow(/not legal/i);
 });
 it('forces each root once and lets later policy choices adapt to branch observations',()=>{
  const game=rootGame();const view=game.view('p1');
  const attack='move 1, move 2';const defend='move 4, move 4';
  expect(view.legalCommands).toContain(attack);expect(view.legalCommands).toContain(defend);
  const traces:EpisodeTrace[]=[];
  const report=runSimulation({...request,checkpoint:game.snapshot(),branches:[{label:'attack',command:attack},{label:'defend',command:defend}]},{trace:value=>traces.push(value)});
  expect(report.variants.every(row=>row.games===1&&row.invalid===0&&row.unresolved===0)).toBe(true);
  for(const [index,command] of [attack,defend].entries()){
   const decisions=traces[index]!.decisions.filter(d=>d.side==='p1');
   expect(decisions[0]!.command).toBe(command);
   expect(decisions.some(d=>d.turn>1)).toBe(true);
  }
  const afterAttack=traces[0]!.decisions.find(d=>d.side==='p1'&&d.turn>1)!;
  const afterDefend=traces[1]!.decisions.find(d=>d.side==='p1'&&d.turn>1)!;
  expect(afterAttack.observations).not.toEqual(afterDefend.observations);
  expect(afterAttack.alternatives).not.toEqual(afterDefend.alternatives);
 });
 it('reports completed branch outcomes from the selected p2 actor perspective',()=>{
  const game=rootGame();const traces:EpisodeTrace[]=[];
  const command=game.view('p2').legalCommands.find(c=>c==='move 1, move 2')!;
  const report=runSimulation({...request,actor:'p2',checkpoint:game.snapshot(),branches:[{label:'p2 action',command}]},{trace:value=>traces.push(value)});
  expect(report.outcomePerspective).toBe('p2');
  expect(report.variants[0]).toMatchObject({games:1,invalid:0,unresolved:0});
  expect(['p1','p2','draw']).toContain(traces[0]!.outcome);
  expect(report.variants[0]!.wins).toBe(traces[0]!.outcome==='p2'?1:0);
  expect(report.variants[0]!.losses).toBe(traces[0]!.outcome==='p1'?1:0);
 });
 it('rejects public replay root switching when selected reserves are unknown',()=>{
  const game=rootGame();const replay=parseReplay(loadReplay({content:game.view('p1').observations.join('\n')}));
  const command=game.view('p1').legalCommands.find(c=>c.startsWith('switch 3,'))!;
  expect(command).toBeDefined();
  expect(()=>runSimulation({...request,replayStart:{replay,userTeam:team,playerSide:'p1',turn:1},branches:[{label:'unknown reserve',command}]})).toThrow(/selected four|switch alternatives/i);
 });
 it('keeps p1 preview choices identical when analyst-only p2 partial facts change',()=>{
  const tracesA:EpisodeTrace[]=[],tracesB:EpisodeTrace[]=[];
  const base={...request,kind:'battle' as const,maxTurns:1,teams:{p1:{team,preview},p2:{preview}}};
  runSimulation(base,{trace:value=>tracesA.push(value)});
  runSimulation({...base,teams:{...base.teams,p2:{preview,known:[{species:'Garchomp',moves:['Rock Slide'],item:'Life Orb',skillPoints:{hp:32,spe:32}}]}}},{trace:value=>tracesB.push(value)});
  const a=tracesA[0]!.decisions.find(d=>d.side==='p1')!;
  const b=tracesB[0]!.decisions.find(d=>d.side==='p1')!;
  expect(a.command).toBe(b.command);
  expect(a.alternatives).toEqual(b.alternatives);
  expect(a.belief.known).toEqual([]);expect(b.belief.known).toEqual([]);
 });
});
