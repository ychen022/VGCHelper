import {describe,expect,it} from 'vitest';
import {EngineSession,completePreviewTeam} from '../src/simulation/engine.js';
import {buildTeamBelief} from '../src/simulation/beliefs.js';
import {sampleActorWorld} from '../src/simulation/worlds.js';
import {informationSetKey} from '../src/simulation/search.js';
import {publicBattleState} from '../src/simulation/policy.js';
const names=['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion'];
function fixture() {
  const own=completePreviewTeam(names),enemy=completePreviewTeam(names);
  for(const team of [own,enemy])for(const set of team.pokemon){set.moves=['Protect'];set.gender='M';}
  own.pokemon[0]!.nickname='My dragon';
  const belief=buildTeamBelief({regulationId:'champions-m-c',preview:names,exactTeam:enemy});
  const source=EngineSession.create({teams:{p1:own,p2:enemy},seed:[12,34,56,78]});
  return {source,belief,own,enemy};
}
describe('actor-only sampled worlds',()=>{
  it('preserves the complete preview information set and gives the opponent its own team',()=>{
    const {source,belief,enemy}=fixture(),view=source.view('p1');
    const world=sampleActorWorld(view,belief,'preview');
    expect(informationSetKey(world.view('p1'))).toBe(informationSetKey(view));
    expect(world.view('p2').ownTeam).toEqual(enemy);
    expect(world.view('p2').ownTeam.pokemon[0]!.nickname).toBeUndefined();
    expect(Object.keys(world).sort()).toEqual(['step','view']);
  });
  it('preserves a non-default selected four and exact own request after a switch',()=>{
    const {source,belief}=fixture();source.step({p1:'team 1265',p2:'team 1234'});
    source.step({p1:'switch 3, move 1',p2:'move 1, move 1'});
    const view=source.view('p1'),world=sampleActorWorld(view,belief,'switch',{maxAttempts:512});
    expect(informationSetKey(world.view('p1'))).toBe(informationSetKey(view));
    world.step({p1:'move 1, move 1',p2:'move 1, move 1'});
    expect(world.view('p1').turn).toBe(3);
    expect(world.view('p1').observations.slice(0,view.observations.length)).toEqual(view.observations);
  });
  it('rejects a fabricated own PP value rather than masking meaningful state',()=>{
    const {source,belief}=fixture();source.step({p1:'team 1265',p2:'team 1234'});
    const view=source.view('p1');view.request.active![0]!.moves[0]!.pp=2;
    expect(()=>sampleActorWorld(view,belief,'invalid',{maxAttempts:32})).toThrow(/own.*request|consistent/i);
  });
  it('propagates an exhausted outer deadline',()=>{
    const {source,belief}=fixture();
    expect(()=>sampleActorWorld(source.view('p1'),belief,'deadline',{deadline:0})).toThrow(/deadline/);
  });
});

describe('world boundary validation',()=>{
  it('keeps a revealed opponent nickname across the sampled future',()=>{
    const {own,enemy,belief}=fixture();enemy.pokemon[0]!.nickname='Enemy dragon';
    const source=EngineSession.create({teams:{p1:own,p2:enemy},seed:[12,34,56,78]});source.step({p1:'team 1234',p2:'team 1234'});
    const world=sampleActorWorld(source.view('p1'),belief,'nickname',{maxAttempts:64});
    world.step({p1:'move 1, move 1',p2:'move 1, move 1'});
    const state=publicBattleState(world.view('p1'));
    expect(Object.values(state.sides.p2.pokemon).filter(p=>p.species==='Dragonite')).toHaveLength(1);
    expect(Object.values(state.sides.p2.pokemon).every(p=>p.species!==undefined)).toBe(true);
  });
  it('rejects wrong formats and impossible prebattle mechanical history',()=>{
    const {source,belief}=fixture(),view=source.view('p1');
    expect(()=>sampleActorWorld({...view,observations:view.observations.map(line=>line.startsWith('|tier|')?'|tier|[Gen 9] OU':line)},belief,'tier')).toThrow(/format|preview/);
    expect(()=>sampleActorWorld({...view,observations:[...view.observations,'|-damage|p1a: My dragon|1/100']},belief,'damage')).toThrow(/preview/i);
  });
  it('rejects a fixed candidate gender conflicting with the visible preview',()=>{
    const {source,belief}=fixture();belief.candidates[0]!.team.pokemon[0]!.gender='F';
    expect(()=>sampleActorWorld(source.view('p1'),belief,'gender')).toThrow(/gender/);
  });
  it('uses publicly observed genders when a known team leaves gender unspecified',()=>{
    const own=completePreviewTeam(names),enemy=completePreviewTeam(names);
    const source=EngineSession.create({teams:{p1:own,p2:enemy},seed:[12,34,56,78]});
    const belief=buildTeamBelief({regulationId:'champions-m-c',preview:names,exactTeam:enemy});
    const root=source.view('p1');
    expect(informationSetKey(sampleActorWorld(root,belief,'different seed').view('p1'))).toBe(informationSetKey(root));
  });
  it('rejects an opponent prior whose roster contradicts the visible preview',()=>{
    const {source}=fixture();
    const enemy=completePreviewTeam(['Incineroar',...names.slice(1)]);
    const belief=buildTeamBelief({regulationId:'champions-m-c',preview:enemy.pokemon.map(p=>p.species),exactTeam:enemy});
    expect(()=>sampleActorWorld(source.view('p1'),belief,'roster')).toThrow(/preview/);
  });
});

it('ignores extraneous privileged fields rather than forwarding them to a sampled actor',()=>{
  const {source,belief}=fixture();
  const view={...source.view('p1'),privateCheckpoint:()=>{throw new Error('private state accessed');}};
  const world=sampleActorWorld(view,belief,'allowlist');
  expect(Object.keys(world.view('p1'))).not.toContain('privateCheckpoint');
});

it('explicitly rejects a partial-turn forced-switch root',()=>{
  const {source,belief}=fixture();source.step({p1:'team 1234',p2:'team 1234'});
  const view=source.view('p1');view.request.forceSwitch=[true,false];
  expect(()=>sampleActorWorld(view,belief,'partial')).toThrow(/Partial-turn forced-switch/);
});
