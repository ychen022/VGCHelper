import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parseShowdownTeam} from '../src/teams/parser.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import {EngineSession,completePreviewTeam} from '../src/simulation/engine.js';
import {buildTeamBelief} from '../src/simulation/beliefs.js';
import {actionDistribution,scoreActions,chooseAction,publicBattleState,ownSet} from '../src/simulation/policy.js';
const team=parseShowdownTeam(readFileSync('examples/sample-team.txt','utf8'),loadRegulationProfile());
const preview=team.pokemon.map(p=>p.species);
const belief=buildTeamBelief({regulationId:'champions-vgc-2026-m-b',preview,completionTeams:[completePreviewTeam(preview)]});
function session(){return EngineSession.create({teams:{p1:team,p2:team},seed:[1,2,3,4]});}
describe('view-only action policies',()=>{
  it('keeps Eternal Floette identity when Showdown names its Mega form Floette-Mega',()=>{
    const modified=structuredClone(team);modified.pokemon[0]={species:'Floette-Eternal',item:'Floettite',ability:'Flower Veil',nature:'Timid',moves:['Moonblast','Protect'],skillPoints:{spa:32,spe:32,hp:2},ivs:{},level:50};
    const game=EngineSession.create({teams:{p1:modified,p2:modified},seed:[1,2,3,4]});game.step({p1:'team 1234',p2:'team 1234'});
    game.step({p1:'move 1 1 mega, move 1 1',p2:'move 1 1 mega, move 1 1'});
    const view=game.view('p1');
    expect(ownSet(view,view.request.side.pokemon[0]!).species).toBe('Floette-Eternal');
    expect(()=>actionDistribution(view,belief)).not.toThrow();
  });
  it('returns normalized reproducible probabilities over only permitted commands',()=>{
    const game=session();const view=game.view('p1');
    const choices=actionDistribution(view,belief);
    expect(choices.reduce((sum,c)=>sum+c.probability,0)).toBeCloseTo(1);
    expect(choices.every(c=>view.legalCommands.includes(c.command))).toBe(true);
    expect(chooseAction(choices,'seed')).toBe(chooseAction(choices,'seed'));
  });
  it('never changes an actor decision when only opposing unrevealed investments change',()=>{
    const other=structuredClone(team); other.pokemon[0]!.skillPoints={hp:32,def:32,spd:2};
    const first=session(); const second=EngineSession.create({teams:{p1:team,p2:other},seed:[1,2,3,4]});
    expect(actionDistribution(first.view('p1'),belief)).toEqual(actionDistribution(second.view('p1'),belief));
  });
  it('scores both partners and their targets and honors actually revealed boosts',()=>{
    const game=session();game.step({p1:'team 1234',p2:'team 1234'});
    const view=game.view('p1');const actions=actionDistribution(view,belief);
    expect(actions.some(c=>c.command.includes('move')&&c.command.includes(','))).toBe(true);
    expect(actions.every(c=>Number.isFinite(c.score))).toBe(true);
    const state=publicBattleState({...view,observations:[...view.observations,'|-boost|p1a: Garchomp|atk|2']});
    expect(Object.values(state.sides.p1.pokemon).find(p=>p.active&&p.slot==='p1a')?.boosts.atk).toBe(2);
  });
  it('does not value Fake Out after a first turn lost to flinching',()=>{
    const game=session();game.step({p1:'team 4123',p2:'team 1234'});
    const view=game.view('p1');
    const fakeOutIndex=view.request.active![0]!.moves.findIndex(move=>move.id==='fakeout')+1;
    const command=view.legalCommands.find(command=>command.startsWith(`move ${fakeOutIndex} 1,`))!;
    const first=scoreActions(view,belief).find(action=>action.command===command)!;
    const later=scoreActions({...view,turn:2,observations:[...view.observations,'|cant|p1a: Sneasler|flinch','|turn|2']},belief).find(action=>action.command===command)!;
    expect(later.score).toBeLessThan(first.score-20);
  });
  it('includes the actor defensive boosts in incoming damage features',()=>{
    const game=session();game.step({p1:'team 1234',p2:'team 1234'});
    const view=game.view('p1');
    const protectIndex=view.request.active![0]!.moves.findIndex(move=>move.id==='protect')+1;
    const command=view.legalCommands.find(command=>command.startsWith(`move ${protectIndex},`))!;
    const normal=scoreActions(view,belief).find(action=>action.command===command)!;
    const boosted=scoreActions({...view,observations:[...view.observations,'|-boost|p1a: Garchomp|def|6','|-boost|p1a: Garchomp|spd|6']},belief).find(action=>action.command===command)!;
    expect(boosted.score).toBeLessThan(normal.score);
  });
});
