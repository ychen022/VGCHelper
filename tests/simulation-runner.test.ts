import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parseShowdownTeam} from '../src/teams/parser.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import {runSimulation,actorPriorFactory,type SimulationRequest} from '../src/simulation/runner.js';
import {EngineSession} from '../src/simulation/engine.js';
const team=parseShowdownTeam(readFileSync('examples/sample-team.txt','utf8'),loadRegulationProfile());
const request:SimulationRequest={kind:'battle',regulationId:'champions-vgc-2026-m-b',teams:{p1:{team,preview:team.pokemon.map(p=>p.species)},p2:{preview:team.pokemon.map(p=>p.species)}},metaTeams:[],usageRows:[],samples:2,maxTurns:35,budgetMs:30000,seed:'runner-test',informationMode:'closed',policies:{p1:'tactical',p2:'damage'}};
describe('probabilistic battle runner',()=>{
  it('persists the configured credible-action cutoff and exposes chosen action evidence',()=>{
    const traces:any[]=[];
    const report=runSimulation({...request,samples:1,maxTurns:1,actionSelection:{topFraction:0.25,maxScoreGap:0}},{trace:value=>traces.push(value)});
    expect(report.configuration.actionSelection).toEqual({topFraction:0.25,maxScoreGap:0});
    for(const decision of traces[0].decisions){
      expect(decision.selectedAction.score).toBe(decision.alternatives[0].score);
      expect(decision.selectedAction.probability).toBeGreaterThan(0);
    }
  });
  it('retains the final resolution in both player logs without changing pre-decision evidence',()=>{
    const traces:any[]=[];const games:Array<{log:string;ended:boolean}>=[];
    runSimulation({...request,samples:1},{trace:value=>traces.push(value),game:value=>games.push(value)});
    expect(games[0]!.ended).toBe(true);
    const trace=traces[0];
    expect(trace.battleLogs?.p1.lines.join('\n')).toBe(games[0]!.log);
    for(const side of ['p1','p2'] as const){
      const log=trace.battleLogs[side];
      expect(log.ended).toBe(true);
      expect(log.lines).toContain(`|win|${trace.outcome}`);
      const lastDecision=trace.decisions.findLast((d:any)=>d.side===side);
      expect(lastDecision.selectedAction).toMatchObject({source:'policy',candidateCount:expect.any(Number),score:expect.any(Number),probability:expect.any(Number),rank:expect.any(Number)});
      expect(lastDecision.observations.join('\n')).not.toContain('|win|');
      const resolution=log.lines.slice(lastDecision.observations.length).join('\n');
      expect(resolution).toContain('|move|');
      expect(resolution).toContain('|faint|');
      expect(log.lines.join('\n')).not.toContain('|split|');
      expect(log.lines.join('\n')).not.toContain('|showteam|');
    }
  });
  it('retains the last resolved turn when a game reaches its turn cap',()=>{
    const traces:any[]=[];
    runSimulation({...request,samples:1,maxTurns:1},{trace:value=>traces.push(value)});
    expect(traces[0].outcome).toBe('unresolved');
    expect(traces[0].battleLogs?.p1).toMatchObject({ended:false,turn:2});
    expect(traces[0].battleLogs.p1.lines.join('\n')).toContain('|move|');
    expect(traces[0].battleLogs.p1.lines.join('\n')).not.toContain('|win|');
  });
  it('plays reproducible sampled games and distinguishes uncertainty from exact knowledge',()=>{
    const first=runSimulation(request);const second=runSimulation(request);
    expect(first.variants).toEqual(second.variants);
    expect(first.variants[0]!.games).toBe(2);
    expect(first.variants[0]!.invalid).toBe(0);
    expect(first.variants[0]!.unresolved).toBe(0);
    expect(first.variants[0]!.wins+first.variants[0]!.losses+first.variants[0]!.draws+first.variants[0]!.unresolved+first.variants[0]!.invalid).toBe(2);
    expect(first.assumptions.join(' ')).toContain('synthetic');
    expect(first.versions.engine).toContain('6b4bc');
  },30000);
  it('does not score a turn cap as a loss or draw',()=>{
    const result=runSimulation({...request,samples:1,maxTurns:1});
    expect(result.variants[0]).toMatchObject({games:1,unresolved:1,wins:0,losses:0,draws:0});
  });
  it('honors a fixed selected four and lead order',()=>{
    const plan=team.pokemon.slice(0,4).map(p=>p.species);
    const result=runSimulation({...request,samples:1,maxTurns:1,fixedPlans:{p1:plan}});
    expect(result.selectedPlans.find(p=>p.side==='p1')?.plan).toBe(plan.join(' / '));
    expect(()=>runSimulation({...request,fixedPlans:{p1:[plan[0]!,plan[0]!,plan[2]!,plan[3]!]}})).toThrow(/four distinct/i);
  });
  it('compares fixed and reselected plans with paired outcomes',()=>{
    const result=runSimulation({...request,samples:1,maxTurns:1,fixedPlans:{p1:team.pokemon.slice(0,4).map(p=>p.species)},compareReselectedPlan:true});
    expect(result.variants.map(v=>v.label)).toEqual(['fixed plan','reselected plan']);
    expect(result.variants.every(v=>v.games===1)).toBe(true);
    expect(result.comparison?.winDifference).toBeNull();
  });
  it('matches fixed Mega labels and rejects replacement teams missing the fixed member',()=>{
    const plan=team.pokemon.slice(0,4).map(p=>p.species);plan[0]+='-Mega';
    expect(runSimulation({...request,samples:1,maxTurns:1,fixedPlans:{p1:plan}}).variants[0]!.invalid).toBe(0);
    const candidate=structuredClone(team);candidate.pokemon[0]!.species='Pelipper';
    expect(()=>runSimulation({...request,fixedPlans:{p1:plan},comparisonTeam:candidate})).toThrow(/fixed p1 plan/);
  });
  it('parses all packed public sheet fields for the other actor search prior',()=>{
    const game=EngineSession.create({teams:{p1:team,p2:team},seed:[1,2,3,4],informationMode:'open_sheet'});
    const factory=actorPriorFactory({regulationId:request.regulationId,metaTeams:[{id:'known-source',name:'source',regulationId:request.regulationId,roster:request.teams.p1.preview,pokemon:team.pokemon,exactSets:true,source:{provider:'fixture',retrievedAt:'now'}}],usageRows:[]});
    const belief=factory(game.view('p2'));
    expect(belief.known).toHaveLength(6);
    expect(belief.known[0]!.moves).toHaveLength(4);
    expect(belief.known.every(p=>p.skillPoints===undefined)).toBe(true);
  });
  it('runs bounded information-set search and exposes fallback and rollout coverage',()=>{
    const result=runSimulation({...request,samples:1,maxTurns:1,policies:{p1:'search',p2:'damage'},search:{iterations:2,budgetMs:1000,maxTurns:1,maxDepth:2,candidateCap:2,confirmationSamples:1}});
    expect(result.search.decisions).toBeGreaterThan(0);
    expect(result.search.iterations).toBeGreaterThan(0);
    expect(result.search.cappedRollouts+result.search.invalidRollouts).toBeGreaterThan(0);
    expect(result.variants[0]!.invalid).toBe(0);
    expect(result.search.version).toContain('information-set');
  },10000);
  it('accepts the maximum battle horizon at preview when search confirmation is disabled',()=>{
    const result=runSimulation({...request,samples:1,maxTurns:200,budgetMs:5000,policies:{p1:'search',p2:'damage'},search:{iterations:1,budgetMs:1,maxTurns:1,maxDepth:1,candidateCap:1,confirmationSamples:0}});
    expect(result.variants[0]!.invalid).toBe(0);
    expect(result.warnings.join(' ')).not.toContain('Invalid confirmation horizon');
  },10000);
  it('suppresses paired estimates when games are censored',()=>{
    const result=runSimulation({...request,comparisonTeam:team,samples:2,maxTurns:1});
    expect(result.comparison).toMatchObject({winDifference:null,standardError:null});
  });
  it('completes analyst partial details without revealing them as actor knowledge',()=>{
    const traces:any[]=[];
    const result=runSimulation({...request,samples:1,maxTurns:2,teams:{...request.teams,p2:{...request.teams.p2,known:[{species:'Garchomp',moves:['Rock Slide'],item:'Life Orb'}]}}},{trace:value=>traces.push(value)});
    expect(result.variants[0]!.invalid).toBe(0);
    const first=traces[0].decisions.find((d:any)=>d.side==='p1');
    expect(first.belief.known).toEqual([]);
  });
  it('reports progress and stores checkpoints for real subsequent branching',()=>{
    const progress:unknown[]=[];const traces:unknown[]=[];
    runSimulation({...request,samples:1,maxTurns:2},{progress:value=>progress.push(value),trace:value=>traces.push(value)});
    expect(progress.length).toBeGreaterThan(0);
    expect(traces[0]).toMatchObject({episode:0,checkpoints:expect.arrayContaining([expect.objectContaining({turn:1})])});
  });
  it('can complete partial inputs when a published item conflicts with an analyst constraint',()=>{
    const result=runSimulation({...request,samples:1,maxTurns:1,
      metaTeams:[{id:'published',name:'published',regulationId:request.regulationId,roster:request.teams.p1.preview,pokemon:team.pokemon,exactSets:true,source:{provider:'fixture',retrievedAt:'2026-09-07'}}],
      teams:{...request.teams,p2:{...request.teams.p2,known:[{species:'Kingambit',item:'Life Orb'}]}},
    });
    expect(result.variants[0]!.invalid).toBe(0);
  });
});
