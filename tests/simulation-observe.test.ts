import {describe,expect,it} from 'vitest';
import type {PokemonSet,MetaTeam} from '../src/domain/contracts.js';
import type {PlayerView} from '../src/simulation/engine.js';
import {buildTeamBelief} from '../src/simulation/beliefs.js';
import {updateBeliefFromView} from '../src/simulation/observe.js';
import {calculateChampionsDamage,pokemonMaxHp} from '../src/calc/champions.js';
import {completePreviewTeam,EngineSession} from '../src/simulation/engine.js';
const set=(item='Focus Sash',spe=0):PokemonSet=>({species:'Pikachu',ability:'Static',nature:'Timid',item,moves:['Thunderbolt','Protect'],skillPoints:{spe},ivs:{},level:50});
const meta=(name:string,pokemon:PokemonSet):MetaTeam=>({id:name,name,regulationId:'mb',pokemon:[pokemon],roster:[pokemon.species],exactSets:true,source:{provider:'fixture',retrievedAt:'now'}});
const prior=()=>buildTeamBelief({regulationId:'mb',preview:['Pikachu'],publishedTeams:[meta('slow',set('Focus Sash')),meta('fast',set('Life Orb',32))]});
const view=(observations:string[],turn=1):PlayerView=>({side:'p1',turn,ownTeam:{pokemon:[set('Sitrus Berry',16)]},request:{side:{id:'p1',name:'p1',pokemon:[]}},observations,legalCommands:[],ended:false,informationMode:'closed'});
const prefix=['|switch|p1a: Me|Pikachu, L50|110/110','|switch|p2a: Foe|Pikachu, L50|100/100','|turn|1'];
describe('actor stream belief updates',()=>{
 it('maps nicknames to preview species and excludes future reveals',()=>{
  const base=[...prefix,'|move|p2a: Foe|Protect|p2a: Foe'];
  const a=updateBeliefFromView(prior(),view(base));
  const b=updateBeliefFromView(prior(),view([...base,'|turn|2','|-item|p2a: Foe|Life Orb']));
  expect(a).toEqual(b);
  expect(a.known[0]?.moves).toEqual(['Protect']);
 });
 it('does not treat acquired or consumed current items as original items',()=>{
  const current=updateBeliefFromView(prior(),view([...prefix,'|-item|p2a: Foe|Sitrus Berry|[from] move: Trick','|-enditem|p2a: Foe|Sitrus Berry|[eat]']));
  expect(current.candidates).toHaveLength(2);
  const native=updateBeliefFromView(prior(),view([...prefix,'|-enditem|p2a: Foe|Life Orb|[from] move: Knock Off']));
  expect(native.candidates).toHaveLength(1);
 });
 it('uses native priority-aware ordering once per observed prefix',()=>{
  const logs=[...prefix,'|move|p2a: Foe|Thunderbolt|p1a: Me','|move|p1a: Me|Thunderbolt|p2a: Foe','|turn|2'];
  const updated=updateBeliefFromView(prior(),view(logs,2));
  expect(updated.candidates).toHaveLength(1);
  expect(updated.candidates[0]!.team.pokemon[0]!.item).toBe('Life Orb');
  expect(updateBeliefFromView(updated,view(logs,2))).toEqual(updated);
  const priority=updateBeliefFromView(prior(),view([...prefix,'|move|p2a: Foe|Protect|p2a: Foe','|move|p1a: Me|Thunderbolt|p2a: Foe','|turn|2'],2));
  expect(priority.candidates).toHaveLength(2);
 });
 it('conditions isolated direct damage with candidate-specific rounded HP',()=>{
  const fragile=set('Focus Sash');
  const bulky={...set('Assault Vest'),nature:'Calm',skillPoints:{spd:32}};
  const belief=buildTeamBelief({regulationId:'mb',preview:['Pikachu'],publishedTeams:[meta('fragile',fragile),meta('bulky',bulky)]});
  const attacker=set('Sitrus Berry',16);
  const damage=calculateChampionsDamage({attacker,defender:fragile,move:'Thunderbolt',attackerPosition:{species:'Pikachu'},defenderPosition:{species:'Pikachu'}}).range[1];
  const after=Math.ceil(100*(pokemonMaxHp(fragile)-damage)/pokemonMaxHp(fragile));
  const updated=updateBeliefFromView(belief,view([...prefix,'|move|p1a: Me|Thunderbolt|p2a: Foe',`|-damage|p2a: Foe|${after}/100`,'|turn|2'],2));
  expect(updated.candidates).toHaveLength(1);
  expect(updated.candidates[0]!.team.pokemon[0]!.item).toBe('Focus Sash');
 });
 it('skips ambiguous damage with an explicit coverage warning',()=>{
  const updated=updateBeliefFromView(prior(),view([...prefix,'|move|p1a: Me|Thunderbolt|p2a: Foe','|-crit|p2a: Foe','|-damage|p2a: Foe|10/100','|turn|2'],2));
  expect(updated.candidates).toHaveLength(2);
  expect(updated.warnings.join(' ')).toMatch(/critical|ambiguous/i);
 });
 it('expands only from public native reveals and validates completions',()=>{
  const updated=updateBeliefFromView(prior(),view([...prefix,'|move|p2a: Foe|Thunder Wave|p1a: Me']),{validateTeam:()=>[]});
  expect(updated.status).toBe('covered');
  expect(updated.candidates.every(c=>c.team.pokemon[0]!.moves.includes('Thunder Wave'))).toBe(true);
  expect(updated.known[0]!.skillPoints).toBeUndefined();
  const rejected=updateBeliefFromView(prior(),view([...prefix,'|move|p2a: Foe|Thunder Wave|p1a: Me']),{validateTeam:()=>['illegal fixture']});
  expect(rejected.status).toBe('insufficient_coverage');
 });
 it('preserves acquired item history across switching and form-change abilities',()=>{
  const updated=updateBeliefFromView(prior(),view([...prefix,
   '|-item|p2a: Foe|Sitrus Berry|[from] move: Trick',
   '|switch|p2a: Foe|Pikachu, L50|100/100',
   '|-enditem|p2a: Foe|Sitrus Berry|[eat]',
   '|-formechange|p2a: Foe|Pikachu',
   '|-ability|p2a: Foe|Lightning Rod',
  ]));
  expect(updated.candidates).toHaveLength(2);
  expect(updated.known).toEqual([]);
 });
 it('reverses clean same-priority speed evidence under observed Trick Room',()=>{
  const updated=updateBeliefFromView(prior(),view([...prefix,'|-fieldstart|move: Trick Room','|move|p2a: Foe|Thunderbolt|p1a: Me','|move|p1a: Me|Thunderbolt|p2a: Foe','|turn|2'],2));
  expect(updated.candidates).toHaveLength(1);
  expect(updated.candidates[0]!.team.pokemon[0]!.item).toBe('Focus Sash');
 });
 it('uses Trick Room state at the action, not a later field change',()=>{
  const updated=updateBeliefFromView(prior(),view([...prefix,'|move|p2a: Foe|Thunderbolt|p1a: Me','|move|p1a: Me|Thunderbolt|p2a: Foe','|-fieldstart|move: Trick Room','|turn|2'],2));
  expect(updated.candidates[0]!.team.pokemon[0]!.item).toBe('Life Orb');
 });
 it('does not infer native abilities from ability replacement events',()=>{
  const updated=updateBeliefFromView(prior(),view([...prefix,'|-ability|p2a: Foe|Simple|[from] move: Simple Beam']));
  expect(updated.candidates).toHaveLength(2);
  expect(updated.known).toEqual([]);
 });
 it('learns the publicly revealed Mega Stone in a closed-sheet battle',()=>{
  const dragonite=(item:string)=>({...set(item),species:'Dragonite',ability:'Inner Focus',nature:'Adamant',moves:['Dragon Claw','Protect']});
  const belief=buildTeamBelief({regulationId:'mb',preview:['Dragonite'],publishedTeams:[meta('mega',dragonite('Dragoninite')),meta('other',dragonite('Leftovers'))]});
  const updated=updateBeliefFromView(belief,view([prefix[0]!,'|switch|p2a: Foe|Dragonite, L50|100/100','|turn|1','|-mega|p2a: Foe|Dragonite|Dragoninite']));
  expect(updated.candidates).toHaveLength(1);
  expect(updated.known).toEqual([{species:'Dragonite',item:'Dragoninite'}]);
 });
 it('preserves the true team after exact-HP damage with floating-point percentage rounding',()=>{
  const names=['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion'];
  const team=completePreviewTeam(names);
  for(const pokemon of team.pokemon){pokemon.moves=['Protect'];pokemon.gender='M';}
  team.pokemon[0]!.ability='Multiscale';
  team.pokemon[0]!.moves=['Dragon Claw'];
  team.pokemon[1]!.moves=['Dragon Claw'];
  const engine=EngineSession.create({teams:{p1:team,p2:team},seed:[1,2,3,4]});
  engine.step({p1:'team 1234',p2:'team 1234'});
  engine.step({p1:'move 1 1, move 1 1',p2:'move 1 2, move 1 2'});
  const visible=engine.view('p1');
  expect(visible.observations).toContain('|-damage|p1b: Garchomp|23/185');
  const updated=updateBeliefFromView(buildTeamBelief({regulationId:'mb',preview:names,exactTeam:team}),visible,{expand:false});
  expect(updated.observations.some(o=>o.kind==='damage')).toBe(true);
  expect(updated.candidates).toHaveLength(1);
 });
 it('conditions consecutive hits using the pre-hit HP after Multiscale breaks',()=>{
  const names=['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion'];
  const own=completePreviewTeam(names),enemy=completePreviewTeam(names);
  for(const team of [own,enemy])for(const pokemon of team.pokemon){pokemon.moves=['Protect'];pokemon.gender='M';}
  own.pokemon[0]!.moves=['Extreme Speed'];
  own.pokemon[1]!.moves=['Crunch'];
  enemy.pokemon[0]!.ability='Multiscale';
  enemy.pokemon[0]!.moves=['Dragon Claw'];
  const engine=EngineSession.create({teams:{p1:own,p2:enemy},seed:[2,3,4,5]});
  engine.step({p1:'team 1234',p2:'team 1234'});
  engine.step({p1:'move 1 1, move 1 1',p2:'move 1 -2, move 1'});
  const visible=engine.view('p1');
  expect(visible.observations).toContain('|-damage|p2a: Dragonite|82/100');
  expect(visible.observations).toContain('|-damage|p2a: Dragonite|51/100');
  const updated=updateBeliefFromView(buildTeamBelief({regulationId:'mb',preview:names,exactTeam:enemy}),visible,{expand:false});
  expect(updated.observations.filter(o=>o.kind==='damage')).toHaveLength(2);
  expect(updated.candidates).toHaveLength(1);
 });
});
