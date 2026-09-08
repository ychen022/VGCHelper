import {describe,it,expect} from 'vitest';
import {EngineSession,completePreviewTeam,type PlayerView,type PlayerSide} from '../src/simulation/engine.js';
import {buildTeamBelief,sampleBeliefTeam} from '../src/simulation/beliefs.js';
import {actionDistribution,planningActions} from '../src/simulation/policy.js';
import {informationSetKey,searchDecision,type SearchOptions,type SearchWorld} from '../src/simulation/search.js';

const team={pokemon:[{species:'Garchomp',ability:'Rough Skin',nature:'Adamant',moves:['Earthquake','Protect'],skillPoints:{atk:32,spe:32,hp:2},ivs:{},level:50}]};
const belief=buildTeamBelief({regulationId:'champions-vgc-2026-m-b',preview:['Garchomp'],exactTeam:team});
function view(side:PlayerSide='p1'):PlayerView {
  return {side,turn:1,ownTeam:structuredClone(team),request:{side:{id:side,name:side,pokemon:[{ident:`${side}: Garchomp`,details:'Garchomp, L50',condition:'180/180',active:true,stats:{atk:180},moves:['earthquake','protect'],baseAbility:'roughskin',item:''}]},active:[{moves:[{move:'Earthquake',id:'earthquake',target:'allAdjacent'},{move:'Protect',id:'protect',target:'self'}]}]},observations:['|turn|1'],legalCommands:['move 1','move 2'],ended:false,informationMode:'closed'};
}
// Synthetic tactical trap: immediate attack loses after two decisions; guarding
// creates a future decision at which guarding again is necessary to win.
// World construction has only actor input and sampled belief, never true state.
const trap:SearchOptions['sampleWorld']=(input,prior)=>{
  let current=structuredClone(input),first='',steps=0;
  const opponent:PlayerSide=input.side==='p1'?'p2':'p1';
  return {view(side){
    if(side===input.side)return structuredClone(current);
    return {...view(opponent),turn:current.turn,ownTeam:structuredClone(prior.candidates[0]!.team),legalCommands:current.ended?[]:['move 1'],ended:current.ended,...(current.winner?{winner:current.winner}:{})};
  },step(commands){
    const command=commands[input.side]!;
    if(!current.legalCommands.includes(command))throw new Error('Illegal fixture action');
    steps++;
    if(steps===1)first=command;
    current={...current,turn:current.turn+1,observations:[...current.observations,`|turn|${current.turn+1}`,`|message|actor chose ${command}`]};
    if(steps===2)current={...current,ended:true,legalCommands:[],winner:first==='move 2'&&command==='move 2'?input.side:opponent};
  }} satisfies SearchWorld;
};
function options(overrides:Partial<SearchOptions>={}):SearchOptions {
  return {seed:'frozen',iterations:100,budgetMs:30000,maxTurns:10,maxDepth:10,candidateCap:2,sampleWorld:trap,opponentBelief:()=>structuredClone(belief),...overrides};
}
describe('information-set search',()=>{
  it('keeps all previously explored root candidates available for exploitation',()=>{
    const root=view();root.legalCommands=Array.from({length:16},(_,i)=>`move ${i+1}`);
    root.request.active![0]!.moves=Array.from({length:16},()=>({...root.request.active![0]!.moves[0]!}));
    const ordered=planningActions(root,belief,16);expect(ordered).toHaveLength(16);
    const winning=ordered.at(-1)!.command;
    const result=searchDecision(root,belief,options({candidateCap:16,iterations:100,sampleWorld(actor){
      let current=structuredClone(actor);
      return {view(side){return side===actor.side?structuredClone(current):{...view(side),legalCommands:['move 1']};},step(commands){current={...current,ended:true,legalCommands:[],winner:commands[actor.side]===winning?actor.side:'p2'};}};
    }}));
    expect(result.rootActions.find(a=>a.command===winning)!.visits).toBeGreaterThan(5);
    expect(result.command).toBe(winning);
  });
  it('looks beyond the immediate damage trap and explores future information nodes',()=>{
    const root=view();expect(actionDistribution(root,belief,'damage')[0]!.command).toBe('move 1');
    const result=searchDecision(root,belief,options());
    expect(result.command).toBe('move 2');
    expect(result.rootActions.every(action=>action.visits>0)).toBe(true);
    expect(result.nodes.filter(node=>node.key!==informationSetKey(root)&&node.visits>0).length).toBeGreaterThanOrEqual(2);
    expect(result.rootActions.find(action=>action.command==='move 2')!.meanValue).toBeGreaterThan(0.7);
  });
  it('is deterministic with frozen input, factory and seed, independent of unprovided truth',()=>{
    const one={...view(),hiddenOpponent:{item:'Choice Scarf'},rng:[1,2,3,4]};
    const two={...view(),hiddenOpponent:{item:'Focus Sash'},rng:[9,8,7,6]};
    expect(informationSetKey(one)).toBe(informationSetKey(two));
    expect(searchDecision(one,belief,options())).toEqual(searchDecision(two,belief,options()));
  });
  it('ignores real unrevealed opposing engine sets and RNG while sampling from the view alone',()=>{
    const own=completePreviewTeam(['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion']);
    own.pokemon.forEach(set=>{set.gender='M';});
    const other=structuredClone(own);other.pokemon[0]!.item='Life Orb';other.pokemon[0]!.skillPoints={hp:32,def:32,spd:2};
    const first=EngineSession.create({teams:{p1:own,p2:own},seed:[1,2,3,4]}).view('p1');
    const second=EngineSession.create({teams:{p1:own,p2:other},seed:[8,7,6,5]}).view('p1');
    const prior=buildTeamBelief({regulationId:belief.regulationId,preview:own.pokemon.map(p=>p.species),completionTeams:[own]});
    const factory:SearchOptions['sampleWorld']=(actor,actorBelief,seed)=>EngineSession.create({teams:{p1:actor.ownTeam,p2:sampleBeliefTeam(actorBelief,seed)},seed:[2,3,4,5]});
    expect(first).toEqual(second);
    const result=searchDecision(first,prior,options({iterations:4,maxDepth:1,sampleWorld:factory,opponentBelief:()=>prior}));
    expect(result.invalidRollouts).toBe(0);
    expect(result.iterations).toBe(4);
    expect(result).toEqual(searchDecision(second,prior,options({iterations:4,maxDepth:1,sampleWorld:factory,opponentBelief:()=>prior})));
  });
  it('backs up rewards from the actor p2 perspective',()=>{
    const result=searchDecision(view('p2'),belief,options({confirmationSamples:5}));
    expect(result.command).toBe('move 2');
    expect(result.confirmation.wins).toBe(5);
    expect(result.confirmation.losses).toBe(0);
  });
  it('reports truncated horizons as heuristic/capped instead of losses or win rates',()=>{
    const result=searchDecision(view(),belief,options({maxDepth:1,iterations:6,confirmationSamples:3}));
    expect(result.incompleteRollouts).toBe(6);
    expect(result.rootActions.reduce((sum,a)=>sum+a.terminal,0)).toBe(0);
    expect(result.confirmation.capped).toBe(3);
    expect(result.confirmation.losses).toBe(0);
    expect(result.confirmation.winRate).toBeNull();
    expect(result.assumptions.join(' ')).toMatch(/heuristic/);
  });
  it('rejects sampled worlds that change actor selected party, request or visible history',()=>{
    const mismatch:SearchOptions['sampleWorld']=(root,prior,seed)=>{
      const world=trap(root,prior,seed,Infinity);return {...world,view(side){const result=world.view(side);if(side===root.side)result.request.side.pokemon[0]!.condition='1/180';return result;}};
    };
    const result=searchDecision(view(),belief,options({iterations:4,sampleWorld:mismatch}));
    expect(result.invalidRollouts).toBe(4);
    expect(result.rootActions.every(action=>action.meanValue===null)).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/root/);
  });
  it('honors a zero wall budget without sampling',()=>{
    const result=searchDecision(view(),belief,options({budgetMs:0,sampleWorld(){throw new Error('Must not sample');}}));
    expect(result.iterations).toBe(0);expect(result.status).toBe('budget_exhausted');
    expect(view().legalCommands).toContain(result.command);
  });
  it('caps by turn horizon independently of decision depth and keeps confirmation out of selection',()=>{
    const capped=searchDecision(view(),belief,options({iterations:4,maxTurns:1,maxDepth:10}));
    expect(capped.incompleteRollouts).toBe(4);
    const selection=searchDecision(view(),belief,options());
    const confirmed=searchDecision(view(),belief,options({confirmationSamples:8}));
    expect(confirmed.rootActions).toEqual(selection.rootActions);
    expect(confirmed.nodes).toEqual(selection.nodes);
    expect(confirmed.confirmation).toMatchObject({samples:8,wins:8,losses:0,invalid:0,capped:0,winRate:1});
  });
  it('can confirm a frozen short-horizon recommendation with full-game continuations',()=>{
    const result=searchDecision(view(),belief,options({iterations:4,maxTurns:1,maxDepth:1,confirmationSamples:3,confirmationMaxTurns:10,confirmationMaxDepth:10}));
    expect(result.incompleteRollouts).toBe(4);
    expect(result.confirmation.capped).toBe(0);
    expect(result.confirmation.wins+result.confirmation.losses+result.confirmation.draws).toBe(3);
  });
});
