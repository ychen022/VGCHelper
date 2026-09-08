import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import type {PlayerView} from '../src/simulation/engine.js';
import type {TeamBelief} from '../src/simulation/beliefs.js';
import {buildTeamBelief} from '../src/simulation/beliefs.js';
import {EngineSession,completePreviewTeam} from '../src/simulation/engine.js';
import * as policy from '../src/simulation/policy.js';

const fixtures=JSON.parse(readFileSync('tests/fixtures/mb861-policy-decisions.json','utf8')) as Array<{name:string;turn:number;command:string;view:PlayerView;belief:TeamBelief}>;

describe('credible action selection',()=>{
  it('scores partner healing against the incoming replacement instead of the outgoing ally',()=>{
    const team=completePreviewTeam(['Gardevoir','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion']);
    team.pokemon[0]!.moves=['Heal Pulse','Psychic','Protect'];team.pokemon[1]!.moves=['Dragon Claw','Protect'];
    const game=EngineSession.create({teams:{p1:team,p2:team},seed:[1,2,3,4]});game.step({p1:'team 1234',p2:'team 1234'});
    game.step({p1:'move 3, move 1 1',p2:'move 3, move 1 2'});
    const view=game.view('p1'),belief=buildTeamBelief({regulationId:'champions-vgc-2026-m-b',preview:team.pokemon.map(p=>p.species),exactTeam:team});
    const command='move 1 -2, switch 3';expect(view.legalCommands).toContain(command);
    const hurtReserve=structuredClone(view);hurtReserve.request.side.pokemon[2]!.condition='68/137';
    const full=policy.scoreActions(view,belief).find(a=>a.command===command)!.score;
    const hurt=policy.scoreActions(hurtReserve,belief).find(a=>a.command===command)!.score;
    expect(hurt-full).toBeCloseTo(50);
    expect(policy.planningActions(view,belief,512).some(a=>a.command.startsWith('move 1 1,'))).toBe(false);
  });

  it('keeps Helping Hand for attacks but excludes Helping Hand combined with ally healing',()=>{
    const fixture=fixtures[2]!,view=structuredClone(fixture.view);
    // Isolate request-level target semantics; both moves are explicitly advertised.
    view.request.active![0]!.moves=[{id:'helpinghand',move:'Helping Hand',target:'adjacentAlly'}];
    view.request.active![1]!.moves=[{id:'pollenpuff',move:'Pollen Puff',target:'normal'}];
    view.legalCommands=['move 1 -2, move 1 -1','move 1 -2, move 1 1'];
    const actions=policy.planningActions(view,fixture.belief,8);
    expect(actions.map(a=>a.command)).toEqual(['move 1 -2, move 1 1']);
  });

  it('does not mistake hostile ally status moves for partner support',()=>{
    const team=completePreviewTeam(['Venusaur','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion']);
    team.pokemon[0]!.moves=['Sleep Powder'];team.pokemon[1]!.moves=['Dragon Claw'];
    const game=EngineSession.create({teams:{p1:team,p2:team},seed:[1,2,3,4]});
    game.step({p1:'team 1234',p2:'team 1234'});
    const view=game.view('p1'),belief=buildTeamBelief({regulationId:'champions-vgc-2026-m-b',preview:team.pokemon.map(p=>p.species),exactTeam:team});
    expect(view.legalCommands).toContain('move 1 -2, move 1 2');
    expect(policy.actionDistribution(view,belief).some(a=>a.command.includes('move 1 -2'))).toBe(false);
    expect(policy.planningActions(view,belief,512).some(a=>a.command.includes('move 1 -2'))).toBe(false);
  });

  it.each(fixtures)('never samples the rejected $name turn $turn command',fixture=>{
    expect(fixture.view.legalCommands).toContain(fixture.command);
    const actions=policy.actionDistribution(fixture.view,fixture.belief,fixture.name==='damage-win'?'damage':'tactical');
    expect(actions.some(a=>a.command===fixture.command)).toBe(false);
    expect(actions.reduce((sum,a)=>sum+a.probability,0)).toBeCloseTo(1);
  });

  it('excludes friendly attacks from the planner as well as the fast sampler',()=>{
    const fixture=fixtures[1]!;
    const actions=policy.planningActions(fixture.view,fixture.belief,512);
    expect(actions.some(a=>a.command===fixture.command)).toBe(false);
    expect(actions.some(a=>/move \d+ -/.test(a.command))).toBe(false);
    expect(actions.length).toBeGreaterThan(0);
  });

  it('retains Protect and switch plans for planning even when the sampler excludes them',()=>{
    const fixture=fixtures[2]!;
    const actions=policy.planningActions(fixture.view,fixture.belief,8);
    const protect=fixture.view.request.active![1]!.moves.findIndex(m=>m.id==='protect')+1;
    expect(protect).toBeGreaterThan(0);
    expect(actions.some(a=>a.command.split(',')[1]!.trim()===`move ${protect}`)).toBe(true);
    expect(actions.some(a=>a.command.includes('switch '))).toBe(true);
    expect(actions.length).toBeLessThanOrEqual(8);
    expect(actions.every(a=>fixture.view.legalCommands.includes(a.command))).toBe(true);
  });

  it('keeps raw scores available separately from the bounded sampling distribution',()=>{
    const fixture=fixtures[2]!;
    const raw=policy.scoreActions(fixture.view,fixture.belief);
    const actions=policy.actionDistribution(fixture.view,fixture.belief);
    expect(raw.some(a=>a.command===fixture.command)).toBe(true);
    expect(actions.length).toBeLessThan(raw.length/2);
    expect(Math.max(...actions.map(a=>a.score))-Math.min(...actions.map(a=>a.score))).toBeLessThanOrEqual(18);
  });

  it('does not restore an unsupported command when it is the only advertised action',()=>{
    const fixture=fixtures[0]!;
    const view={...fixture.view,legalCommands:[fixture.command]};
    expect(policy.actionDistribution(view,fixture.belief)).toEqual([]);
    expect(policy.chooseAction(policy.actionDistribution(view,fixture.belief),'fallback')).toBeUndefined();
  });

  it('does not score a vacant enemy slot against unrelated unrevealed Pokemon',()=>{
    const fixture=fixtures[1]!;
    const actions=policy.planningActions(fixture.view,fixture.belief,512);
    // Milotic is the only remaining opponent, in p1b. Positive target 1 is empty.
    expect(actions.every(a=>!/(?:^|, )move \d+ 1(?:,|$)/.test(a.command))).toBe(true);
    expect(actions.some(a=>a.command.includes(' 2'))).toBe(true);
  });
});
