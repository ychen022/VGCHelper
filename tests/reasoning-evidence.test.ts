import {describe,expect,it} from 'vitest';
import {EngineSession,completePreviewTeam,ENGINE_PROFILE} from '../src/simulation/engine.js';
import {buildTeamBelief} from '../src/simulation/beliefs.js';
import {buildPlayerEvidence} from '../src/simulation/reasoning/evidence.js';

function fixture() {
  const names=['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion'];
  const team=completePreviewTeam(names);
  for(const set of team.pokemon){set.moves=['Protect'];set.gender='M';}
  team.pokemon[0]!.moves=['Dragon Claw','Protect'];
  team.pokemon[1]!.moves=['Earthquake','Protect'];
  const game=EngineSession.create({teams:{p1:team,p2:team},seed:[1,2,3,4]});
  game.step({p1:'team 1234',p2:'team 1234'});
  const belief=buildTeamBelief({regulationId:'champions-m-b',preview:names,completionTeams:[team]});
  return {game,belief};
}

describe('reasoning player evidence',()=>{
  it('contains exact actor options, public board and diverse plans without privileged extensions',()=>{
    const {game,belief}=fixture(),view=game.view('p1');
    const evidence=buildPlayerEvidence(view,belief);
    expect(evidence.request).toEqual(view.request);
    expect(evidence.legalCommands).toContain('move 1 -2, move 1');
    expect(evidence.board.sides.p2.pokemon).toBeDefined();
    expect(evidence.planningActions.some(a=>a.families.some(f=>f.startsWith('protect:')))).toBe(true);
    expect(evidence.planningActions.some(a=>a.families.some(f=>f.startsWith('switch:')))).toBe(true);
    expect(buildPlayerEvidence({...view,privateCheckpoint:()=>{throw new Error('secret');},opponentChoice:'secret'} as typeof view,belief)).toEqual(evidence);
    expect(JSON.stringify(evidence)).not.toContain('privateCheckpoint');
  });
  it('labels bounded sourced set hypotheses and supplies pinned move mechanics',()=>{
    const {game,belief}=fixture();
    belief.candidates=Array.from({length:40},(_,i)=>({...structuredClone(belief.candidates[0]!),id:`candidate-${i}`,weight:1/40}));
    const evidence=buildPlayerEvidence(game.view('p1'),belief);
    expect(evidence.opponentBelief.hypotheses.length).toBeLessThan(40);
    expect(evidence.opponentBelief.omittedCandidates).toBeGreaterThan(0);
    expect(evidence.opponentBelief.displayedWeight).toBeLessThan(1);
    expect(evidence.opponentBelief.hypotheses[0]!.sources[0]!.provider).toBe('explicit-completion-library');
    expect(evidence.opponentBelief.weightInterpretation).toMatch(/model|proposal/i);
    expect(evidence.mechanics.engineRevision).toBe(ENGINE_PROFILE.revision);
    expect(evidence.mechanics.moves.find(m=>m.name==='Protect')).toMatchObject({priority:4,target:'self',basePower:0});
    expect(evidence.mechanics.moves.find(m=>m.name==='Earthquake')).toMatchObject({target:'allAdjacent',basePower:100});
  });
  it('bounds history while preserving the current board and declares missing set coverage',()=>{
    const {game,belief}=fixture(),view=game.view('p1');
    view.observations=[...view.observations,...Array.from({length:600},()=> '|message|'+ 'x'.repeat(160))];
    belief.candidates=[];belief.status='insufficient_coverage';
    const evidence=buildPlayerEvidence(view,belief);
    expect(evidence.publicHistory.lines.join('\n').length).toBeLessThanOrEqual(24_000);
    expect(evidence.publicHistory.omittedLines).toBeGreaterThan(0);
    expect(evidence.board.turn).toBe(1);
    expect(evidence.opponentBelief.status).toBe('insufficient_coverage');
    expect(evidence.limitations.join(' ')).toMatch(/coverage/i);
  });
  it('reports zero HP consistently after a public faint event',()=>{
    const {game,belief}=fixture(),view=game.view('p1');
    view.observations.push('|-damage|p2a: Dragonite|0 fnt');
    const damaged=Object.values(buildPlayerEvidence(view,belief).board.sides.p2.pokemon).find(p=>p.nickname==='Dragonite')!;
    expect(damaged.hp).toMatchObject({current:0,percentRange:[0,0]});
    view.observations.push('|faint|p2a: Dragonite');
    const evidence=buildPlayerEvidence(view,belief);
    const fainted=Object.values(evidence.board.sides.p2.pokemon).find(p=>p.nickname==='Dragonite')!;
    expect(fainted).toMatchObject({fainted:true,hpPercent:0,hp:{current:0,percentRange:[0,0]}});
  });
});
