import {describe, expect, it} from 'vitest';
import {parseShowdownTeam} from '../src/teams/parser.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import {buildBattleState, megaChoices, battleDamage, battleSpeed} from '../src/analysis/matchup/positions.js';
import {evaluateTeam} from '../src/analysis/matchup/evaluator.js';
import type {MetaTeam} from '../src/domain/contracts.js';
import {readFileSync} from 'node:fs';

const profile = loadRegulationProfile();
const sets = parseShowdownTeam(`Staraptor @ Staraptite
Ability: Intimidate
EVs: 27 HP / 14 Atk / 25 Spe
Jolly Nature
- Close Combat
- Brave Bird
- Tailwind
- Protect

Banette @ Banettite
Ability: Frisk
EVs: 32 HP / 2 Atk / 32 SpD
Adamant Nature
- Poltergeist
- Trick Room
- Encore
- Destiny Bond`,profile,{requireFullTeam:false,allowIncompleteSets:true}).pokemon;
const foes = parseShowdownTeam(`Charizard @ Charizardite Y
Ability: Blaze
EVs: 2 HP / 32 SpA / 32 Spe
Modest Nature
- Heat Wave
- Protect

Incineroar @ Sitrus Berry
Ability: Intimidate
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Flare Blitz
- Fake Out`,profile,{requireFullTeam:false,allowIncompleteSets:true}).pokemon;

describe('legal Mega states',()=>{
  it('offers mutually exclusive activation choices and holding Mega',()=>{
    expect(megaChoices(sets)).toEqual([null,'Staraptor','Banette']);
  });
  it('keeps the other stone holder in base form with its original ability and speed',()=>{
    const state=buildBattleState(sets,foes,'Banette','Charizard');
    expect(state.user.map(s=>s.position.species)).toEqual(['Staraptor','Banette-Mega']);
    expect(state.user[0]!.position.ability).toBe('Intimidate');
    expect(state.user[1]!.position.ability).toBe('Prankster');
    expect(battleSpeed(state.user[0]!)).toBe(159);
    expect(state.weather).toBe('Sun');
    expect(state.opponent[1]!.position.boosts?.atk).toBe(-1);
  });
  it('applies entry Intimidate before gaining Contrary and preserves the original export',()=>{
    const snapshot=structuredClone(sets);
    const state=buildBattleState(sets,foes,'Staraptor',null);
    expect(state.user[0]!.position.ability).toBe('Contrary');
    expect(state.user[0]!.position.boosts?.atk).toBe(-1);
    expect(sets).toEqual(snapshot);
    const hit=battleDamage(state.user[0]!,state.opponent[0]!,'Close Combat',state.weather);
    expect(hit.inputs?.attackerPosition?.species).toBe('Staraptor-Mega');
    expect(hit.inputs?.attackerPosition?.boosts?.atk).toBe(-1);
  });
  it('rejects selecting an unavailable Mega instead of silently activating both',()=>{
    expect(()=>buildBattleState(sets,foes,'Scizor',null)).toThrow(/Mega/);
  });
  it('triggers Intimidate gained by Mega Evolution after the faster opposing Mega gains Contrary',()=>{
    const manectric={...foes[0]!,species:'Manectric',item:'Manectite',ability:'Lightning Rod',skillPoints:{},nature:'Modest'};
    const state=buildBattleState([sets[0]!],[manectric],'Staraptor','Manectric');
    expect(state.opponent[0]!.position.ability).toBe('Intimidate');
    expect(state.user[0]!.position.boosts?.atk).toBe(1);
  });
  it('blocks Feint into Armor Tail allies independently of Protect bypass',()=>{
    const farigiraf={...foes[1]!,species:'Farigiraf',item:'Sitrus Berry',ability:'Armor Tail'};
    const state=buildBattleState([sets[0]!],[foes[0]!,farigiraf],null,null);
    expect(battleDamage(state.user[0]!,state.opponent[0]!,'Feint').range).toEqual([0,0]);
  });
  it('normalizes published Aegislash to Shield for entry stats and Blade when attacking',()=>{
    const aegislash={...sets[1]!,species:'Aegislash',item:'Leftovers',ability:'Stance Change',moves:['Shadow Ball']};
    const state=buildBattleState([aegislash],[foes[0]!],null,null);
    expect(battleSpeed(state.user[0]!)).toBe(80);
    expect(battleDamage(state.user[0]!,state.opponent[0]!,'Shadow Ball').description).toContain('Aegislash-Blade');
  });
  it('accounts for Choice Scarf and sun speed abilities in action order',()=>{
    const state=buildBattleState([{...sets[0]!,item:'Choice Scarf'}],[{...foes[0]!,species:'Venusaur',item:'Life Orb',ability:'Chlorophyll'}],null,null);
    expect(battleSpeed(state.user[0]!)).toBe(238);
    expect(battleSpeed(state.opponent[0]!,'Sun')).toBe(264);
  });
  it('persists explicit legal Mega decisions for both sides of each screened lead',()=>{
    const user=parseShowdownTeam(readFileSync('examples/sample-team.txt','utf8'),profile);
    user.pokemon.splice(0,2,...sets);
    const opponent={...user,pokemon:[...foes,...user.pokemon.slice(2)]};
    const meta:MetaTeam={id:'legal-megas',name:'fixture',regulationId:profile.id,pokemon:opponent.pokemon,roster:opponent.pokemon.map(s=>s.species),exactSets:true,source:{provider:'fixture',retrievedAt:'2026-09-04'}};
    const result=evaluateTeam(user,[meta],[],profile);
    const rows=result.matchups.filter(r=>r.userLead.first==='Staraptor' && r.userLead.second==='Banette');
    expect(rows.some(r=>r.userMega==='Banette')).toBe(true);
    expect(rows.some(r=>r.userMega===null)).toBe(true);
    for(const row of rows) for(const hit of row.damage) {
      const positions=[hit.inputs?.attackerPosition,hit.inputs?.defenderPosition];
      expect(positions.every(p=>p?.species)).toBe(true);
    }
    expect(result.evaluation.archetypePlans.every(p=>p.userMega!==undefined)).toBe(true);
  },30000);
});

