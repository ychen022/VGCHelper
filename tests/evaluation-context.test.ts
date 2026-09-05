import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {evaluateTeam} from '../src/analysis/matchup/evaluator.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import {parseShowdownTeam} from '../src/teams/parser.js';
import type {MetaTeam} from '../src/domain/contracts.js';
const profile=loadRegulationProfile();
const team=parseShowdownTeam(readFileSync('examples/sample-team.txt','utf8'),profile);
const meta:MetaTeam={id:'mirror',name:'mirror',regulationId:profile.id,pokemon:team.pokemon,roster:team.pokemon.map(s=>s.species),exactSets:true,source:{provider:'fixture',retrievedAt:'2026-09-04'}};
describe('contextual evaluation',()=>{
  it('keeps a declared four and Mega decision fixed across every opponent response',()=>{
    const four=team.pokemon.slice(0,4).map(s=>s.species);
    const result=evaluateTeam(team,[meta],[],profile,{modes:[{id:'my-four',bringFour:four,lead:[four[0]!,four[1]!],mega:null}],priorityThreats:['Charizard-Mega-Y']});
    const plan=result.evaluation.modePlans.find(p=>p.modeId==='my-four')!;
    expect(plan).toBeDefined();
    expect(plan.bringFour).toEqual(four);
    expect(plan.lead).toEqual({first:four[0],second:four[1]});
    expect(plan.userMega).toBeNull();
    // Fifteen pairs plus five Dragonite pairs with its alternative Mega state.
    expect(plan.responseCount).toBe(20);
    expect(result.evaluation.coverage.omittedPriorityThreats).toContainEqual({threat:'Charizard-Mega-Y',reason:'missing-source'});
  },30000);
  it('rejects an invented role move before doing expensive evaluation',()=>{
    expect(()=>evaluateTeam(team,[meta],[],profile,{roles:[{pokemon:team.pokemon[0]!.species,move:'Dire Claw',purpose:'hypothesis'}]})).toThrow(/move/i);
  });
  it('rejects duplicate or out-of-team mode members and Mega outside the four',()=>{
    expect(()=>evaluateTeam(team,[meta],[],profile,{modes:[{id:'invalid',bringFour:['Garchomp','Garchomp','Whimsicott','Scizor'],mega:null}]})).toThrow(/four/i);
  });
});
