import {describe, expect, it} from 'vitest';
import type {MetaTeam, PokemonSet} from '../src/domain/contracts.js';
import {buildTeamBelief, sampleBeliefTeam, updateTeamBelief, damageObservation, calculateDamageLikelihoods, applyKnownToCompletion} from '../src/simulation/beliefs.js';

const set = (item: string, spe = 32): PokemonSet => ({species:'Pikachu', item, ability:'Static', nature:'Timid', moves:['Thunderbolt','Protect'],skillPoints:{spa:32,spe},ivs:{},level:50});
const published = (id:string,item:string,spe=32): MetaTeam => ({id,name:id,regulationId:'champions-m-b',roster:['Pikachu'],pokemon:[set(item,spe)],exactSets:true,source:{provider:'fixture',retrievedAt:'2026-09-07',regulationId:'champions-m-b'}});
const input = {regulationId:'champions-m-b',preview:['Pikachu'],publishedTeams:[published('a','Life Orb'),published('b','Focus Sash',0)]};

describe('probabilistic team beliefs',()=>{
  it('preserves joint published sets and known investments without declaring samples known',()=>{
    const belief=buildTeamBelief(input);
    expect(belief.candidates.map(c=>c.weight)).toEqual([0.5,0.5]);
    expect(belief.known).toEqual([]);
    expect(belief.effectiveSampleSize).toBe(2);
    const constrained=buildTeamBelief({...input,known:[{species:'Pikachu',skillPoints:{spe:0}}]});
    expect(constrained.candidates).toHaveLength(1);
    expect(constrained.candidates[0]!.team.pokemon[0]!.item).toBe('Focus Sash');
    expect(sampleBeliefTeam(belief,123)).toEqual(sampleBeliefTeam(belief,123));
  });
  it('conditions native reveals but does not infer original sets from copied moves or changed items',()=>{
    const belief=buildTeamBelief(input);
    expect(updateTeamBelief(belief,[{kind:'reveal',species:'Pikachu',field:'item',value:'Life Orb',origin:'native'}]).candidates).toHaveLength(1);
    expect(updateTeamBelief(belief,[{kind:'reveal',species:'Pikachu',field:'move',value:'Surf',origin:'copied'}]).candidates).toHaveLength(2);
    expect(belief.candidates).toHaveLength(2);
  });
  it('does not use later observations at an earlier decision boundary',()=>{
    const belief=buildTeamBelief(input);
    const future={kind:'reveal' as const,species:'Pikachu',field:'item' as const,value:'Life Orb',turn:4};
    expect(updateTeamBelief(belief,[future],{throughTurn:3})).toEqual(updateTeamBelief(belief,[],{throughTurn:3}));
  });
  it('uses fractional damage likelihoods, normalized posteriors and rounded HP intervals',()=>{
    const belief=buildTeamBelief(input);
    const likelihoods=Object.fromEntries(belief.candidates.map((c,i)=>[c.id,[{damage:40,probability:i?0.25:0.75},{damage:60,probability:i?0.75:0.25}]]));
    const result=updateTeamBelief(belief,[{kind:'damage',likelihoods,observedDamage:[39,41]}]);
    expect(result.candidates.map(c=>c.weight)).toEqual([0.75,0.25]);
    const observation=damageObservation({before:[99,100],after:[59,60],maximumHp:100,likelihoods});
    expect(observation.observedDamage).toEqual([39,41]);
  });
  it('conditions speed only within equal priority and handles ties and Trick Room',()=>{
    const belief=buildTeamBelief(input);
    const speeds=Object.fromEntries(belief.candidates.map((c,i)=>[c.id,i?50:100]));
    const obs={kind:'speed' as const,speeds,otherSpeed:75,actedFirst:true,priority:0,otherPriority:0};
    expect(updateTeamBelief(belief,[obs]).candidates[0]!.team.pokemon[0]!.item).toBe('Life Orb');
    expect(updateTeamBelief(belief,[{...obs,trickRoom:true}]).candidates[0]!.team.pokemon[0]!.item).toBe('Focus Sash');
    expect(updateTeamBelief(belief,[{...obs,priority:1}]).candidates).toHaveLength(2);
  });
  it.each([23,184])('tolerates arithmetic rounding at %i HP but rejects incompatible damage',(remaining)=>{
    const belief=buildTeamBelief(input);
    const observed=100-remaining/185*100;
    const likelihoods=Object.fromEntries(belief.candidates.map((c,i)=>[c.id,[{damage:(185-remaining)/185*100+(i?1e-6:0),probability:1}]]));
    const updated=updateTeamBelief(belief,[{kind:'damage',observedDamage:[observed,observed],likelihoods}]);
    expect(updated.candidates).toHaveLength(1);
    expect(updated.candidates[0]!.id).toBe(belief.candidates[0]!.id);
  });
  it('ignores unbound usage and exposes exhaustion without resetting the prior',()=>{
    const belief=buildTeamBelief({...input,usageRows:[{pokemon:'Pikachu',category:'item',name:'Life Orb',rank:1,percentage:100,source:{provider:'usage',retrievedAt:'now',regulationVerified:true}}]});
    expect(belief.candidates.map(c=>c.weight)).toEqual([0.5,0.5]);
    const exhausted=updateTeamBelief(belief,[{kind:'reveal',species:'Pikachu',field:'move',value:'Surf'}]);
    expect(exhausted.status).toBe('insufficient_coverage');
    expect(()=>sampleBeliefTeam(exhausted,1)).toThrow(/coverage/i);
  });
  it('expansion reapplies earlier evidence instead of resurrecting incompatible sets',()=>{
    const belief=updateTeamBelief(buildTeamBelief(input),[{kind:'reveal',species:'Pikachu',field:'item',value:'Life Orb'}]);
    const result=updateTeamBelief(belief,[{kind:'reveal',species:'Pikachu',field:'move',value:'Surf'}],{expand:()=>buildTeamBelief(input)});
    expect(result.status).toBe('insufficient_coverage');
    expect(result.observations).toHaveLength(2);
  });
  it('integrates weighted nuisance scenarios using the real calculator',()=>{
    const belief=buildTeamBelief(input);
    const likelihoods=calculateDamageLikelihoods(belief,c=>[
      {request:{attacker:c.team.pokemon[0]!,defender:set('Focus Sash'),move:'Thunderbolt'},weight:3},
      {request:{attacker:c.team.pokemon[0]!,defender:set('Focus Sash'),move:'Thunderbolt',field:{isProtected:true}},weight:1},
    ]);
    for(const rolls of Object.values(likelihoods)){
      expect(rolls.reduce((sum,r)=>sum+r.probability,0)).toBeCloseTo(1);
      expect(rolls.filter(r=>r.damage===0).reduce((sum,r)=>sum+r.probability,0)).toBeCloseTo(0.25);
    }
  });
  it('rejects illegal complete candidates through the engine validator boundary',()=>{
    const belief=buildTeamBelief({...input,validateTeam:team=>team.pokemon[0]!.item==='Life Orb'?['not legal in fixture']:[]});
    expect(belief.candidates).toHaveLength(1);
    expect(belief.candidates[0]!.team.pokemon[0]!.item).toBe('Focus Sash');
  });
  it('retains source identities when recombining published sets',()=>{
    const raichu={...published('r','Sitrus Berry'),roster:['Raichu'],pokemon:[{...set('Sitrus Berry'),species:'Raichu'}]};
    const belief=buildTeamBelief({...input,preview:['Pikachu','Raichu'],publishedTeams:[input.publishedTeams[0]!,raichu]});
    expect(belief.candidates).toHaveLength(1);
    expect(belief.candidates[0]!.sourceTeamIds).toEqual(['a','r']);
  });
  it('records native revelations as known while leaving investments unknown',()=>{
    const result=updateTeamBelief(buildTeamBelief(input),[{kind:'reveal',species:'Pikachu',field:'move',value:'Protect'}]);
    expect(result.known).toEqual([{species:'Pikachu',moves:['Protect']}]);
    expect(result.known[0]!.skillPoints).toBeUndefined();
  });
  it('accepts the engine Aegislash alias while preserving the public species',()=>{
    const aegislash={...set('Leftovers'),species:'Aegislash',ability:'Stance Change',nature:'Quiet',moves:['Shadow Ball','Flash Cannon','Protect']};
    const result=buildTeamBelief({regulationId:'mb',preview:['Aegislash'],exactTeam:{pokemon:[aegislash]}});
    expect(result.status).toBe('covered');
    expect(result.candidates[0]!.team.pokemon[0]!.species).toBe('Aegislash');
  });
  it('expands omitted published investments into labeled plausible spreads',()=>{
    const unknown={...published('unknown','Life Orb'),pokemon:[{...set('Life Orb'),skillPoints:{}}]};
    const result=buildTeamBelief({...input,publishedTeams:[unknown]});
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(new Set(result.candidates.map(c=>c.team.pokemon[0]!.skillPoints.spe??0)).size).toBeGreaterThan(1);
    expect(result.candidates.every(c=>c.assumptions.some(a=>/investment/i.test(a)))).toBe(true);
    expect(result.known).toEqual([]);
  });
  it('keeps every unknown spread variable under a joint candidate cap',()=>{
    const species=['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion'];
    const unknown={...published('unknown',''),roster:species,pokemon:species.map(species=>({...set(''),species,skillPoints:{}}))};
    const result=buildTeamBelief({...input,preview:species,publishedTeams:[unknown],maxCandidates:32});
    for(let slot=0;slot<6;slot++)expect(new Set(result.candidates.map(c=>JSON.stringify(c.team.pokemon[slot]!.skillPoints))).size).toBe(3);
  });
  it('completes legal partial moves, item and investment constraints exactly',()=>{
    const completion={pokemon:[{...set(''),species:'Garchomp',ability:'Rough Skin',nature:'Jolly',moves:['Earthquake','Dig','Dragon Claw','Protect'],skillPoints:{atk:32,spe:32,hp:2}}]};
    const result=applyKnownToCompletion(completion,[{species:'Garchomp',moves:['Rock Slide'],item:'Life Orb',skillPoints:{hp:32,spe:32}}]);
    expect(result.pokemon[0]!.moves).toEqual(['Rock Slide','Earthquake','Dig','Dragon Claw']);
    expect(result.pokemon[0]!.item).toBe('Life Orb');
    expect(result.pokemon[0]!.skillPoints).toMatchObject({hp:32,spe:32,atk:2});
    expect(Object.values(result.pokemon[0]!.skillPoints).reduce((a,b)=>a+b,0)).toBe(66);
    expect(completion.pokemon[0]!.moves).not.toContain('Rock Slide');
  });
  it('rejects contradictory or impossible known-field masks instead of silently overwriting',()=>{
    const completion={pokemon:[set('Life Orb')]};
    expect(()=>applyKnownToCompletion(completion,[{species:'Pikachu',item:'Life Orb'},{species:'Pikachu',item:'Focus Sash'}])).toThrow(/conflicting/i);
    expect(()=>applyKnownToCompletion(completion,[{species:'Pikachu',skillPoints:{hp:32,atk:32,spe:32}}])).toThrow(/66/);
    expect(()=>applyKnownToCompletion(completion,[{species:'Pikachu',moves:['Protect','Surf','Thunderbolt','Volt Tackle','Iron Tail']}])).toThrow(/four/);
    expect(()=>applyKnownToCompletion(completion,[{species:'Raichu',item:'Life Orb'}])).toThrow(/preview/i);
  });
});
