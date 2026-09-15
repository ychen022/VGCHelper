import {describe,expect,it,vi} from 'vitest';
import {EngineSession,completePreviewTeam} from '../src/simulation/engine.js';
import {buildTeamBelief} from '../src/simulation/beliefs.js';
import {evaluatePlayerPlans} from '../src/simulation/reasoning/scenarios.js';
import type {MetaTeam} from '../src/domain/contracts.js';

function fixture() {
  const names=['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion'];
  const own=completePreviewTeam(names),opponent=completePreviewTeam(names);
  for(const team of [own,opponent])for(const set of team.pokemon){set.moves=['Protect'];set.gender='M';}
  own.pokemon[0]!.moves=['Dragon Claw','Protect'];
  own.pokemon[1]!.moves=['Earthquake','Protect'];
  const game=EngineSession.create({teams:{p1:own,p2:opponent},seed:[1,2,3,4]});
  game.step({p1:'team 1234',p2:'team 1234'});
  const source={provider:'test-published',retrievedAt:'input',regulationId:'champions-m-c'};
  const metaTeams:MetaTeam[]=[own,opponent].map((team,i)=>({id:`published-${i}`,name:'Published fixture',regulationId:'champions-m-c',pokemon:team.pokemon,roster:names,exactSets:true,source}));
  const belief=buildTeamBelief({regulationId:'champions-m-c',preview:names,publishedTeams:[metaTeams[1]!]});
  return {game,view:game.view('p1'),belief,sources:{regulationId:'champions-m-c',metaTeams,usageRows:[]}};
}
const baseOptions={samples:1,maxTurns:1,budgetMs:10_000,seed:'reasoning-test'};

describe('actor-only reasoning scenarios',()=>{
  it('evaluates a legal allied attack outside the fast shortlist and resolves its partner consequences',()=>{
    const {view,belief,sources}=fixture();
    const command='move 1 -2, move 2';
    const result=evaluatePlayerPlans(view,belief,sources,{...baseOptions,plans:[{label:'partner protects',command},{label:'partner switches',command:'move 1 -2, switch 3'}]});
    expect(result.evaluations.every(e=>e.legality==='legal')).toBe(true);
    expect(result.evaluations.every(e=>e.counts.invalid===0&&e.counts.unsupported===0)).toBe(true);
    const guard=result.evaluations[0]!.consequences[0]!,swap=result.evaluations[1]!.consequences[0]!;
    expect(guard.own.hpPercentTotal).toBe(400);
    expect(guard.publicEvents.some(line=>line.includes('Dragon Claw'))).toBe(true);
    expect(swap.own.active.some(p=>p.species==='Whimsicott')).toBe(true);
    // Whimsicott's Fairy immunity is evaluated after the partner actually switches.
    expect(swap.publicEvents.some(line=>line.includes('-immune')&&line.includes('Whimsicott'))).toBe(true);
    expect(result.pairedSamples).toBe(1);
    expect(result.assumptions.join(' ')).toMatch(/not.*win probab/i);
    expect(JSON.stringify(result)).not.toMatch(/winRate|winProbability/);
  });
  it('pairs mechanical worlds and responses across identical plans and ignores privileged view extensions',()=>{
    const {view,belief,sources}=fixture();
    const options={...baseOptions,samples:3,plans:[{label:'a',command:'move 2, move 2'},{label:'b',command:'move 2, move 2'}]};
    const result=evaluatePlayerPlans({...view,checkpoint:()=>{throw new Error('secret');},opponentChoice:'secret'} as typeof view,belief,sources,options);
    expect(result.evaluations[0]!.consequences).toEqual(result.evaluations[1]!.consequences);
    expect(result.pairedSamples).toBe(3);
    expect(result.evaluations[0]!.counts.capped).toBe(3);
    expect(result.evaluations[0]!.consequences.some(c=>c.opponentResponse?.families.some(f=>f.startsWith('switch:')))).toBe(true);
    expect(result.evaluations[0]!.consequences.some(c=>c.opponentResponse?.families.some(f=>f.startsWith('protect:')))).toBe(true);
    expect(result.responseModel.weightInterpretation).toMatch(/model.*not.*empirical/i);
    expect(result).toEqual(evaluatePlayerPlans(view,belief,sources,options));
  });
  it('retains defensive and extreme consequences while reporting response coverage over all trials',()=>{
    const {view,belief,sources}=fixture();
    belief.candidates[0]!.team.pokemon[0]!.moves=['Dragon Claw','Protect'];
    belief.candidates[0]!.team.pokemon[1]!.moves=['Earthquake','Protect'];
    const result=evaluatePlayerPlans(view,belief,sources,{...baseOptions,samples:16,seed:'response-coverage',plans:[{label:'attack',command:'move 1 1, move 1'}]});
    const evaluation=result.evaluations[0]!;
    expect(evaluation.counts).toMatchObject({attempted:16,capped:16,invalid:0,unsupported:0});
    expect(evaluation.consequences).toHaveLength(8);
    expect(evaluation.omittedConsequences).toBe(8);
    expect(new Set(evaluation.consequences.map(c=>c.opponentResponse?.category))).toEqual(new Set(['tactical','protect','switch']));
    expect(evaluation.summary!.horizonUtility.maximum).toBeGreaterThan(evaluation.summary!.horizonUtility.minimum);
    expect(Math.min(...evaluation.consequences.map(c=>c.horizonUtility))).toBe(evaluation.summary!.horizonUtility.minimum);
    expect(Math.max(...evaluation.consequences.map(c=>c.horizonUtility))).toBe(evaluation.summary!.horizonUtility.maximum);
    expect(Math.min(...evaluation.consequences.map(c=>c.own.hpPercentTotal))).toBe(evaluation.summary!.ownHpPercentTotal.minimum);
    expect(Math.max(...evaluation.consequences.map(c=>c.own.hpPercentTotal))).toBe(evaluation.summary!.ownHpPercentTotal.maximum);
    expect(evaluation.responseCoverage).toBeDefined();
    expect(evaluation.responseCoverage.unassigned).toBe(0);
    expect(evaluation.responseCoverage.categories.map(c=>({category:c.category,selected:c.selected,rootExecuted:c.rootExecuted})))
      .toEqual([{category:'tactical',selected:8,rootExecuted:8},{category:'protect',selected:4,rootExecuted:4},{category:'switch',selected:4,rootExecuted:4}]);
    expect(evaluation.responseCoverage.categories.every(c=>c.summary?.samples===c.selected)).toBe(true);
    expect(evaluation.responseCoverage.interpretation).toMatch(/model.*not.*empirical/i);
  });
  it('spreads response categories across early samples when the deadline interrupts the requested batch',()=>{
    const {view,belief,sources}=fixture();
    let expired=false,resolved=0;
    const originalStep=EngineSession.prototype.step;
    // Keep real reconstruction and joint mechanics; advance the external clock after four completed root turns.
    const step=vi.spyOn(EngineSession.prototype,'step').mockImplementation(function(this:EngineSession,commands){
      originalStep.call(this,commands);
      if(!commands.p1?.startsWith('team ')&&!commands.p2?.startsWith('team ')&&++resolved===4)expired=true;
    });
    const clock=vi.spyOn(Date,'now').mockImplementation(()=>expired?10_001:0);
    try {
      const result=evaluatePlayerPlans(view,belief,sources,{...baseOptions,samples:16,plans:[{label:'guard',command:'move 2, move 2'}]});
      const evaluation=result.evaluations[0]!;
      expect(result.status).toBe('budget_exhausted');
      expect(evaluation.counts).toMatchObject({attempted:4,capped:4,notRun:12});
      expect(new Set(evaluation.consequences.map(c=>c.opponentResponse?.category))).toEqual(new Set(['tactical','protect','switch']));
      expect(evaluation.responseCoverage.unassigned).toBe(12);
      expect(evaluation.responseCoverage.categories.map(c=>c.selected)).toEqual([2,1,1]);
    }finally{step.mockRestore();clock.mockRestore();}
  });
  it('reports illegal commands, unsupported forced-switch roots and unrun deadline work explicitly',()=>{
    const {view,belief,sources}=fixture();
    const invalid=evaluatePlayerPlans(view,belief,sources,{...baseOptions,plans:[{label:'bad',command:'move 99, move 99'}]});
    expect(invalid.evaluations[0]).toMatchObject({legality:'illegal',counts:{attempted:0,invalid:1}});
    const forced={...view,request:{...view.request,forceSwitch:[true,false]}};
    const unsupported=evaluatePlayerPlans(forced,belief,sources,{...baseOptions,plans:[{label:'guard',command:'move 2, move 2'}]});
    expect(unsupported.status).toBe('unsupported');
    expect(unsupported.evaluations[0]!.reasons.join(' ')).toMatch(/forced.switch|partial.turn/i);
    expect(unsupported.evaluations[0]!.counts.unsupported).toBe(1);
    const capped=evaluatePlayerPlans(view,belief,sources,{...baseOptions,budgetMs:0,samples:3,plans:[{label:'guard',command:'move 2, move 2'}]});
    expect(capped.status).toBe('budget_exhausted');
    expect(capped.evaluations[0]!.counts).toMatchObject({attempted:0,notRun:3,terminal:0});
  });
  it('rejects unbounded scenario work before reconstruction',()=>{
    const {view,belief,sources}=fixture();
    const options={...baseOptions,plans:[{label:'guard',command:'move 2, move 2'}]};
    for(const invalid of [{samples:0},{samples:33},{maxTurns:4},{budgetMs:Infinity},{budgetMs:-1},{plans:[]},{plans:Array.from({length:9},()=>options.plans[0]!)}]){
      expect(()=>evaluatePlayerPlans(view,belief,sources,{...options,...invalid})).toThrow();
    }
  });
  it('reports a reconstruction deadline as exhausted even when no world was produced',()=>{
    const {view,belief,sources}=fixture();
    const clock=vi.spyOn(Date,'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(2);
    try {
      const result=evaluatePlayerPlans(view,belief,sources,{...baseOptions,budgetMs:1,plans:[{label:'guard',command:'move 2, move 2'}]});
      expect(result.status).toBe('budget_exhausted');
      expect(result.evaluations[0]!.counts).toMatchObject({attempted:1,capped:1,invalid:0,unsupported:0});
      expect(result.evaluations[0]!.consequences).toEqual([]);
    }finally{clock.mockRestore();}
  });
  it('does not relabel an inconsistent reconstructed own request as an engine-illegal plan',()=>{
    const {view,belief,sources}=fixture();
    view.request.active![0]!.moves[0]!.pp=1;
    const result=evaluatePlayerPlans(view,belief,sources,{...baseOptions,plans:[{label:'guard',command:'move 2, move 2'}]});
    expect(result.evaluations[0]!.counts).toMatchObject({attempted:1,unsupported:1,invalid:0});
    expect(result.evaluations[0]!.reasons.join(' ')).toMatch(/own.*request|consistent/i);
    expect(result.pairedSamples).toBe(0);
  });
  it('separates true sampled terminal outcomes from horizon caps',()=>{
    const names=['Forretress','Glalie','Metagross','Garbodor','Vanilluxe','Glimmora'];
    const team=completePreviewTeam(names);
    for(const set of team.pokemon){set.moves=['Explosion'];set.gender=set.species==='Metagross'?'N':'M';}
    const game=EngineSession.create({teams:{p1:team,p2:team},seed:[1,2,3,4]});
    game.step({p1:'team 1234',p2:'team 1234'});
    const source={provider:'test-published',retrievedAt:'input',regulationId:'champions-m-c'};
    const published:MetaTeam={id:'explosion',name:'Explosion fixture',regulationId:'champions-m-c',pokemon:team.pokemon,roster:names,exactSets:true,source};
    const belief=buildTeamBelief({regulationId:'champions-m-c',preview:names,publishedTeams:[published]});
    const result=evaluatePlayerPlans(game.view('p1'),belief,{regulationId:'champions-m-c',metaTeams:[published],usageRows:[]},
      {...baseOptions,maxTurns:3,plans:[{label:'boom',command:'move 1, move 1'}]});
    expect(result.evaluations[0]!.counts).toMatchObject({terminal:1,capped:0,invalid:0,unsupported:0});
    const consequence=result.evaluations[0]!.consequences[0]!;
    expect(consequence.kind).toBe('terminal');
    expect(consequence.turnsResolved).toBe(consequence.turn);
    expect(Object.values(result.evaluations[0]!.terminalOutcomes).reduce((a,b)=>a+b,0)).toBe(1);
  });
});
