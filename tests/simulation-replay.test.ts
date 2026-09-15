import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {EngineSession,completePreviewTeam,type EngineSeed} from '../src/simulation/engine.js';
import {reconstructReplayStart,UnsupportedReplayError} from '../src/simulation/replay.js';
import {loadReplay,parseReplay} from '../src/replay/index.js';
const seed:EngineSeed=[12,34,56,78];
const names=['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion'];
function fixture() {
  const team=completePreviewTeam(names);
  for(const set of team.pokemon) {set.moves=['Protect'];set.gender='M';}
  const session=EngineSession.create({teams:{p1:team,p2:team},seed});
  session.step({p1:'team 1234',p2:'team 1234'});
  const first=session.view('p1').observations.join('\n');
  session.step({p1:'move 1, move 1',p2:'move 1, move 1'});
  const second=session.view('p1').observations.join('\n');
  return {team,first,second};
}
const parse=(log:string)=>parseReplay(loadReplay({content:log}));
describe('public replay prefix reconstruction',()=>{
  it('rejects a historical M-B replay under the current M-C engine',()=>{
    const replay=parseReplay(loadReplay({content:readFileSync('examples/public-replays/gen9championsvgc2026regmb-2675725887.json','utf8')}));
    const {team}=fixture();
    expect(()=>reconstructReplayStart(replay,team,'p1',1,team,seed)).toThrow(/format/i);
  });
  it('reconstructs a consistent turn1 state with sampled hidden selected reserves',()=>{
    const {team,first}=fixture();
    const cp=reconstructReplayStart(parse(first),team,'p1',1,team,seed);
    const session=EngineSession.restore(cp);
    expect(session.view('p1').turn).toBe(1);
    expect(session.view('p1').request.side.pokemon.slice(0,2).map(p=>p.details.split(',')[0])).toEqual(names.slice(0,2));
    expect(cp.reconstruction.warnings.join(' ')).toContain('reserves');
    expect(cp.reconstruction.kind).toBe('public-prefix-sampled');
    expect(session.snapshot().reconstruction).toEqual(cp.reconstruction);
  });
  it('ignores timer and spectator chatter inside the mechanically matched prefix',()=>{
    const {team,first}=fixture();
    const noisy=first.replace('|turn|1','|inactive|Alice has 30 seconds left.\n|j|Spectator\n|c|Spectator|hello\n|turn|1');
    expect(()=>reconstructReplayStart(parse(noisy),team,'p1',1,team,seed)).not.toThrow();
  });
  it('does not consult later moves, reveals or selected reserves',()=>{
    const {team,first}=fixture();
    const a=parse(first+'\n|move|p2a: Dragonite|Ice Beam|p1a: Dragonite\n|-item|p2a: Dragonite|Choice Specs');
    const b=parse(first+'\n|move|p2a: Dragonite|Fire Blast|p1a: Dragonite\n|-item|p2a: Dragonite|Life Orb');
    const ca=reconstructReplayStart(a,team,'p1',1,team,seed);
    const cb=reconstructReplayStart(b,team,'p1',1,team,seed);
    expect(ca.reconstruction).toEqual(cb.reconstruction);
    expect(EngineSession.restore(ca).view('p1')).toEqual(EngineSession.restore(cb).view('p1'));
  });
  it('conditions a fully observed four-Protect turn and preserves persistent PP',()=>{
    const {team,second}=fixture();
    const cp=reconstructReplayStart(parse(second),team,'p1',2,team,seed);
    expect(EngineSession.restore(cp).view('p1').turn).toBe(2);
    const active=EngineSession.restore(cp).view('p1').request.active![0]!;
    expect(active.moves[0]!.pp).toBe(active.moves[0]!.maxpp!-1);
  });
  it('conditions a damaging turn on the actual rounded public HP observation',()=>{
    const {team}=fixture();const opponent=structuredClone(team);
    team.pokemon[0]!.moves=['Extreme Speed'];opponent.pokemon[0]!.moves=['Rain Dance'];
    const source=EngineSession.create({teams:{p1:team,p2:opponent},seed});
    source.step({p1:'team 1234',p2:'team 1234'});
    source.step({p1:'move 1 1, move 1',p2:'move 1, move 1'});
    const observations=source.view('p1').observations;
    const checkpoint=reconstructReplayStart(parse(observations.join('\n')),team,'p1',2,opponent,seed);
    const reconstructed=EngineSession.restore(checkpoint).view('p1');
    expect(reconstructed.observations.filter(e=>e.startsWith('|-damage|'))).toEqual(observations.filter(e=>e.startsWith('|-damage|')));
    expect(checkpoint.reconstruction.conditioningAttempts).toBeGreaterThan(1);
  });
  it('reports an illegal candidate as unsupported reconstruction coverage',()=>{
    const {team,first}=fixture(); const bad=structuredClone(team);bad.pokemon[0]!.moves=['Not A Move'];
    expect(()=>reconstructReplayStart(parse(first),team,'p1',1,bad,seed)).toThrow(UnsupportedReplayError);
  });
  it('rejects one-sided sheet disclosure rather than granting both full sheets',()=>{
    const {team,first}=fixture();
    const sheet=EngineSession.create({teams:{p1:team,p2:team},seed,informationMode:'open_sheet'}).view('p1').observations.find(line=>line.startsWith('|showteam|p1|'))!;
    const partial=first.replace('|start',sheet+'\n|start');
    expect(()=>reconstructReplayStart(parse(partial),team,'p1',1,team,seed)).toThrow(/sheet/);
  });
  it.each(['partial','duplicate','invalid-side'])('rejects %s opening sheets rather than inventing disclosures',(variant)=>{
    const {team,first}=fixture();
    const sheets=EngineSession.create({teams:{p1:team,p2:team},seed,informationMode:'open_sheet'}).view('p1').observations.filter(line=>line.startsWith('|showteam|'));
    const changed=sheets.map(line=>{
      if(variant==='invalid-side')return line.replace('|showteam|p2|','|showteam|p3|');
      return line.replace(/(\|showteam\|p[12]\|)(.*)/,(_match,header:string,packed:string)=>{
        const sets=packed.split(']');
        if(variant==='partial')return header+sets[0];
        sets[1]=sets[0]!;
        return header+sets.join(']');
      });
    });
    const log=first.replace('|start',changed.join('\n')+'\n|start');
    expect(()=>reconstructReplayStart(parse(log),team,'p1',1,team,seed)).toThrow(/sheet/);
  });
  it('retains complete, preview-matching opening sheets',()=>{
    const {team,first}=fixture();
    const sheets=EngineSession.create({teams:{p1:team,p2:team},seed,informationMode:'open_sheet'}).view('p1').observations.filter(line=>line.startsWith('|showteam|'));
    const log=first.replace('|start',sheets.join('\n')+'\n|start');
    const checkpoint=reconstructReplayStart(parse(log),team,'p1',1,team,seed);
    expect(EngineSession.restore(checkpoint).view('p1').informationMode).toBe('open_sheet');
  });
  it('rejects incomplete commands rather than guessing actions prevented from executing',()=>{
    const {team,second}=fixture();
    const missing=second.replace(/\|move\|p2b:[^\n]+\n/,'');
    expect(()=>reconstructReplayStart(parse(missing),team,'p1',2,team,seed)).toThrow(UnsupportedReplayError);
  });
  it('rejects an impossible public entry HP projection',()=>{
    const {team,first}=fixture();
    const damaged=first.replace(/(\|switch\|p1a:[^\n]+\|)\d+\/\d+/,'$1'+'12/100');
    expect(()=>reconstructReplayStart(parse(damaged),team,'p1',1,team,seed)).toThrow(/projection|match/);
  });
});








describe('bounded latent command reconstruction',()=>{
  it('replays a voluntary switch and preserves the switched party and PP',()=>{
    const {team}=fixture();
    const source=EngineSession.create({teams:{p1:team,p2:team},seed});
    source.step({p1:'team 1234',p2:'team 1234'});
    source.step({p1:'switch 3, move 1',p2:'move 1, move 1'});
    const cp=reconstructReplayStart(parse(source.view('p1').observations.join('\n')),team,'p1',2,team,seed,{ownSelectedFour:names.slice(0,4),maxAttempts:256,particleCap:2});
    const view=EngineSession.restore(cp).view('p1');
    expect(view.request.side.pokemon[0]!.details).toContain('Whimsicott');
    expect(view.request.active![1]!.moves[0]!.pp).toBe(source.view('p1').request.active![1]!.moves[0]!.pp);
    expect(cp.reconstruction.transitionAcceptances).toBeGreaterThan(0);
  });
  it('honors an expired reconstruction deadline and a zero attempt budget',()=>{
    const {team,first}=fixture();
    expect(()=>reconstructReplayStart(parse(first),team,'p1',1,team,seed,{deadline:0})).toThrow(/deadline|budget/);
    expect(()=>reconstructReplayStart(parse(first),team,'p1',1,team,seed,{maxAttempts:0})).toThrow(/attempt|budget/);
  });
});


describe('multi-phase and censored turns',()=>{
  it('reconstructs a Parting Shot pivot and its forced replacement before turn 2',()=>{
    const {team}=fixture();const own=structuredClone(team),enemy=structuredClone(team);
    own.pokemon[0]=completePreviewTeam(['Incineroar',...names.slice(1)]).pokemon[0]!;own.pokemon[0]!.moves=['Parting Shot'];own.pokemon[0]!.gender='M';
    enemy.pokemon[0]!.moves=['Rain Dance'];
    const source=EngineSession.create({teams:{p1:own,p2:enemy},seed});source.step({p1:'team 1234',p2:'team 1234'});
    source.step({p1:'move 1 1, move 1',p2:'move 1, move 1'});
    expect(source.view('p1').request.forceSwitch).toEqual([true,false]);
    source.step({p1:'switch 3, pass'});
    const cp=reconstructReplayStart(parse(source.view('p1').observations.join('\n')),own,'p1',2,enemy,seed,{ownSelectedFour:['Incineroar',...names.slice(1,4)],maxAttempts:1024});
    expect(EngineSession.restore(cp).view('p1').request.side.pokemon[0]!.details).toContain('Whimsicott');
  });
  it('retains latent commands for a Pokemon fainted before it can move, then replaces it',()=>{
    const {team}=fixture();const own=structuredClone(team),enemy=structuredClone(team);
    own.pokemon[4]!.moves=['Close Combat'];enemy.pokemon[3]!.moves=['Swords Dance'];enemy.pokemon[0]!.moves=['Rain Dance'];
    const source=EngineSession.create({teams:{p1:own,p2:enemy},seed});source.step({p1:'team 5234',p2:'team 4132'});
    source.step({p1:'move 1 1, move 1',p2:'move 1, move 1'});
    expect(source.view('p2').request.forceSwitch).toEqual([true,false]);
    source.step({p2:'switch 3, pass'});
    const cp=reconstructReplayStart(parse(source.view('p1').observations.join('\n')),own,'p1',2,enemy,seed,{ownSelectedFour:[names[4]!,names[1]!,names[2]!,names[3]!],maxAttempts:1024});
    expect(EngineSession.restore(cp).view('p2').request.side.pokemon.find(p=>p.details.startsWith('Kingambit'))!.condition).toBe('0 fnt');
  });
  it('reconstructs a Fake Out flinch while retaining an unobserved move choice',()=>{
    const {team}=fixture();const own=structuredClone(team),enemy=structuredClone(team);
    own.pokemon[4]!.moves=['Fake Out'];enemy.pokemon[0]!.moves=['Rain Dance','Dragon Dance'];enemy.pokemon[0]!.ability='Multiscale';
    const source=EngineSession.create({teams:{p1:own,p2:enemy},seed});source.step({p1:'team 5234',p2:'team 1234'});
    source.step({p1:'move 1 1, move 1',p2:'move 2, move 1'});
    expect(source.view('p1').observations.some(line=>line.includes('|cant|p2a: Dragonite|flinch'))).toBe(true);
    const cp=reconstructReplayStart(parse(source.view('p1').observations.join('\n')),own,'p1',2,enemy,seed,{maxAttempts:1024});
    expect(cp.reconstruction.retainedParticles).toBeGreaterThan(1);
    expect(EngineSession.restore(cp).view('p2').request.active![0]!.moves.every(m=>m.pp===m.maxpp)).toBe(true);
  });
});

it('allows redirected targets as latent legal commands',()=>{
  const {team}=fixture();const own=structuredClone(team),enemy=structuredClone(team);
  own.pokemon[0]!.moves=['Thunder Wave'];enemy.pokemon[0]!.moves=['Rain Dance'];
  enemy.pokemon[1]=completePreviewTeam(['Clefable',...names.filter(n=>n!=='Garchomp')]).pokemon[0]!;
  enemy.pokemon[1]!.moves=['Follow Me'];enemy.pokemon[1]!.gender='M';
  const source=EngineSession.create({teams:{p1:own,p2:enemy},seed});source.step({p1:'team 1234',p2:'team 1234'});
  source.step({p1:'move 1 1, move 1',p2:'move 1, move 1'});
  expect(source.view('p1').observations.some(line=>line.includes('|Thunder Wave|p2b: Clefable'))).toBe(true);
  const cp=reconstructReplayStart(parse(source.view('p1').observations.join('\n')),own,'p1',2,enemy,seed,{maxAttempts:1024});
  expect(EngineSession.restore(cp).view('p1').turn).toBe(2);
});

describe('explicit battle-equivalent format normalization',()=>{
  it('accepts the M-C Bo3 single-game rules with a prior-game disclosure limitation',()=>{
    const {team,first}=fixture();
    const replay=parse(first.replace('VGC 2026 Reg M-C','VGC 2026 Reg M-C (Bo3)'));
    const cp=reconstructReplayStart(replay,team,'p1',1,team,seed);
    expect(cp.reconstruction.warnings.join(' ')).toContain('prior games');
  });
  it('rejects a conflicting later tier inside the observed prefix',()=>{
    const {team,first}=fixture();
    const replay=parse(first.replace('|turn|1','|tier|[Gen 9 Champions] VGC 2026 Reg M-A\n|turn|1'));
    expect(()=>reconstructReplayStart(replay,team,'p1',1,team,seed)).toThrow(/format|tier/i);
  });
});

it('reconstructs beyond the former turn-4 limit without consulting future actions',()=>{
  const {team}=fixture();team.pokemon[0]!.moves=['Dragon Dance'];team.pokemon[1]!.moves=['Swords Dance'];
  const source=EngineSession.create({teams:{p1:team,p2:team},seed});source.step({p1:'team 1234',p2:'team 1234'});
  for(let turn=1;turn<5;turn++)source.step({p1:'move 1, move 1',p2:'move 1, move 1'});
  const log=source.view('p1').observations.join('\n');
  const cp=reconstructReplayStart(parse(log+'\n|move|p2a: Dragonite|Fire Blast|p1a: Dragonite'),team,'p1',5,team,seed,{particleCap:2,maxAttempts:512});
  expect(EngineSession.restore(cp).view('p1').turn).toBe(5);
  expect(EngineSession.restore(cp).view('p1').request.active![0]!.moves[0]!.pp).toBe(source.view('p1').request.active![0]!.moves[0]!.pp);
  expect(()=>reconstructReplayStart(parse(log),team,'p1',5,team,seed,{maxAttempts:1})).toThrow(/bounded attempt budget/);
});

it('keeps queued partner actions while a faster pivot pauses for replacement',()=>{
  const {team}=fixture();const own=structuredClone(team),enemy=structuredClone(team);
  own.pokemon[2]!.moves=['U-turn'];own.pokemon[1]!.moves=['Swords Dance'];enemy.pokemon[0]!.moves=['Rain Dance'];
  const source=EngineSession.create({teams:{p1:own,p2:enemy},seed:[12,34,56,79]});source.step({p1:'team 3214',p2:'team 1234'});
  source.step({p1:'move 1 1, move 1',p2:'move 1, move 1'});
  expect(source.view('p1').request.forceSwitch).toEqual([true,false]);
  source.step({p1:'switch 3, pass'});
  const cp=reconstructReplayStart(parse(source.view('p1').observations.join('\n')),own,'p1',2,enemy,seed,{maxAttempts:1024});
  expect(EngineSession.restore(cp).view('p1').request.active![1]!.moves[0]!.pp).toBe(source.view('p1').request.active![1]!.moves[0]!.pp);
});
