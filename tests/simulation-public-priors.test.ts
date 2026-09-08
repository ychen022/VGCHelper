import {describe,expect,it} from 'vitest';
import type {MetaTeam,PokemonSet} from '../src/domain/contracts.js';
import {actorPriorFactory} from '../src/simulation/runner.js';
import {completePreviewTeam,EngineSession,validateEngineTeam} from '../src/simulation/engine.js';
import {buildPublicTeamBelief} from '../src/simulation/public-priors.js';

const regulationId='champions-vgc-2026-m-b';
const preview=['Torkoal','Garchomp','Whimsicott','Kingambit','Sneasler','Dragonite'];
const torkoal:PokemonSet={species:'Torkoal',item:'Charcoal',ability:'Drought',nature:'Quiet',moves:['Eruption','Heat Wave','Earth Power','Protect'],skillPoints:{hp:32,spa:32,spd:2},ivs:{},level:50};
const base=completePreviewTeam(preview);
base.pokemon[0]=torkoal;
const published=(id:string,pokemon:PokemonSet[]):MetaTeam=>({id,name:id,regulationId,roster:pokemon.map(set=>set.species),pokemon:structuredClone(pokemon),exactSets:true,source:{provider:'public-fixture',url:`https://example.test/teams/${id}`,retrievedAt:'2026-09-07',regulationId}});
const splitSources=[published('sun',base.pokemon.slice(0,3)),published('balance',base.pokemon.slice(3))];

describe('public custom-roster priors',()=>{
  it('uses coherent published sets from multiple teams in the actor prior before an arbitrary completion',()=>{
    const game=EngineSession.create({teams:{p1:base,p2:base},seed:[1,2,3,4]});
    const belief=actorPriorFactory({regulationId,metaTeams:splitSources,usageRows:[]})(game.view('p1'));
    expect(belief.candidates).toHaveLength(1);
    expect(belief.candidates[0]!.team.pokemon[0]).toEqual(torkoal);
    expect(belief.candidates[0]!.sourceTeamIds.toSorted()).toEqual(['balance','sun']);
    expect(belief.candidates[0]!.sources.map(source=>source.url).toSorted()).toEqual(['https://example.test/teams/balance','https://example.test/teams/sun']);
    expect(belief.candidates[0]!.assumptions.join(' ')).toMatch(/proposal weight/i);
    expect(belief.candidates[0]!.assumptions.join(' ')).toMatch(/not.*(?:empirical|observed).*frequenc/i);
    expect(validateEngineTeam(belief.candidates[0]!.team)).toEqual([]);
    expect(belief.known).toEqual([]);
  });
  it('keeps matching published whole teams ahead of assembled sets',()=>{
    const whole=published('whole',base.pokemon);
    const alternative=published('alternative',[{...torkoal,item:'Sitrus Berry'}]);
    const belief=buildPublicTeamBelief(preview,{regulationId,metaTeams:[...splitSources,whole,alternative],usageRows:[]});
    expect(belief.candidates).toHaveLength(1);
    expect(belief.candidates[0]!.sourceTeamIds).toEqual(['whole']);
    expect(belief.candidates[0]!.source.provider).toBe('public-fixture');
  });
  it('never borrows sets from another regulation or conflicting source metadata',()=>{
    const wrong=published('wrong',[{...torkoal,item:'Sitrus Berry'}]);
    wrong.regulationId='another-regulation';
    const conflict=published('conflict',[{...torkoal,item:'Leftovers'}]);
    conflict.source.regulationId='another-regulation';
    const belief=buildPublicTeamBelief(preview,{regulationId,metaTeams:[...splitSources,wrong,conflict],usageRows:[]});
    expect(belief.candidates).toHaveLength(1);
    expect(belief.candidates[0]!.team.pokemon[0]!.item).toBe('Charcoal');
    expect(JSON.stringify(belief.candidates)).not.toContain('another-regulation');
  });
  it('enforces item clause, learnsets and 66-point investments before proposing a joint team',()=>{
    const invalidMove=published('illegal-move',[{...torkoal,moves:['Thunderbolt']}]);
    const invalidSpread=published('illegal-spread',[{...torkoal,skillPoints:{hp:32,spa:32,spe:32}}]);
    const collision=published('item-collision',[{...base.pokemon[1]!,item:'Charcoal'}]);
    const alternative=published('legal-item',[{...base.pokemon[1]!,item:'Life Orb'}]);
    const belief=buildPublicTeamBelief(preview,{regulationId,metaTeams:[...splitSources,invalidMove,invalidSpread,collision,alternative],usageRows:[]});
    expect(belief.candidates.length).toBeGreaterThan(0);
    for(const candidate of belief.candidates){
      expect(validateEngineTeam(candidate.team)).toEqual([]);
      expect(candidate.team.pokemon[0]!.moves).toEqual(['Eruption','Heat Wave','Earth Power','Protect']);
      expect(candidate.sourceTeamIds).not.toContain('illegal-move');
      expect(candidate.sourceTeamIds).not.toContain('illegal-spread');
      expect(candidate.sourceTeamIds).not.toContain('item-collision');
    }
  });
  it('merges duplicate sets without multiplying their proposal mass or losing their sources',()=>{
    const duplicate=published('sun-copy',base.pokemon.slice(0,3));
    const belief=buildPublicTeamBelief(preview,{regulationId,metaTeams:[...splitSources,duplicate],usageRows:[]});
    expect(belief.candidates).toHaveLength(1);
    expect(belief.candidates[0]!.weight).toBe(1);
    expect(belief.candidates[0]!.sourceTeamIds.toSorted()).toEqual(['balance','sun','sun-copy']);
  });
  it('bounds combinations without freezing an early roster member and is independent of source ordering',()=>{
    const variants=base.pokemon.flatMap((set,slot)=>[0,16,32].map(speed=>published(`slot-${slot}-speed-${speed}`,[{...set,skillPoints:{hp:32,spa:2,spe:speed}}])));
    const sources={regulationId,metaTeams:variants,usageRows:[]};
    const belief=buildPublicTeamBelief(preview,sources);
    expect(belief.candidates.length).toBeGreaterThan(3);
    expect(belief.candidates.length).toBeLessThanOrEqual(32);
    for(let slot=0;slot<6;slot++)expect(new Set(belief.candidates.map(candidate=>candidate.team.pokemon[slot]!.skillPoints.spe)).size).toBe(3);
    expect(buildPublicTeamBelief(preview,{...sources,metaTeams:[...variants].reverse()})).toEqual(belief);
    expect(belief.warnings.join(' ')).toMatch(/cap|bounded|truncat/i);
  });
  it('retains available published sets and explicitly marks synthetic missing-species coverage',()=>{
    const belief=buildPublicTeamBelief(preview,{regulationId,metaTeams:[splitSources[0]!],usageRows:[]});
    expect(belief.candidates.length).toBeGreaterThan(0);
    expect(belief.candidates[0]!.team.pokemon[0]).toEqual(torkoal);
    expect(belief.candidates[0]!.sourceTeamIds).toEqual(['sun']);
    expect(belief.warnings.join(' ')).toMatch(/insufficient.*(?:coverage|published)/i);
    expect(belief.warnings.join(' ')).toMatch(/Kingambit.*Sneasler.*Dragonite/i);
    expect(belief.candidates[0]!.assumptions.join(' ')).toMatch(/3\/6/);
    expect(belief.candidates[0]!.assumptions.join(' ')).toMatch(/weak|exploratory/i);
  });
  it('conditions on public known fields and reports when those require a synthetic set',()=>{
    const known=[{species:'Torkoal',item:'Sitrus Berry'}];
    const belief=buildPublicTeamBelief(preview,{regulationId,metaTeams:splitSources,usageRows:[]},known);
    expect(belief.candidates.length).toBeGreaterThan(0);
    expect(belief.candidates.every(candidate=>candidate.team.pokemon[0]!.item==='Sitrus Berry')).toBe(true);
    expect(belief.known).toEqual(known);
    expect(belief.warnings.join(' ')).toMatch(/Torkoal/);
    expect(belief.candidates.every(candidate=>candidate.assumptions.join(' ').includes('5/6'))).toBe(true);
  });
  it('returns explicit insufficient coverage for duplicate species instead of an illegal fallback',()=>{
    const duplicatePreview=['Torkoal',...preview.slice(1,5),'Torkoal'];
    const belief=buildPublicTeamBelief(duplicatePreview,{regulationId,metaTeams:splitSources,usageRows:[]});
    expect(belief.candidates).toEqual([]);
    expect(belief.status).toBe('insufficient_coverage');
  });
  it('keeps omitted published investments uncertain while matching the published attacking role',()=>{
    const unknown=published('unknown-sun',[{...torkoal,skillPoints:{}},...base.pokemon.slice(1,3)]);
    const belief=buildPublicTeamBelief(preview,{regulationId,metaTeams:[unknown,splitSources[1]!],usageRows:[]});
    expect(belief.candidates.length).toBeGreaterThan(1);
    expect(belief.candidates.every(candidate=>(candidate.team.pokemon[0]!.skillPoints.atk??0)===0)).toBe(true);
    expect(belief.candidates.some(candidate=>candidate.team.pokemon[0]!.skillPoints.spa===32)).toBe(true);
    expect(new Set(belief.candidates.map(candidate=>candidate.team.pokemon[0]!.skillPoints.spe??0)).size).toBeGreaterThan(1);
    expect(belief.candidates.every(candidate=>candidate.assumptions.join(' ').match(/investment.*(?:unknown|hypothetical|scenario)/i))).toBe(true);
    expect(belief.known).toEqual([]);
  });
  it('uses only verified same-regulation usage as labeled proposal reweighting and retains its source',()=>{
    const alternative=published('other-sun',[{...torkoal,item:'Sitrus Berry'}]);
    const verified={provider:'usage-fixture',retrievedAt:'2026-09-07',regulationId,regulationVerified:true};
    const usageRows=[{pokemon:'Torkoal',category:'item',name:'Charcoal',rank:1,percentage:80,source:verified},
      {pokemon:'Torkoal',category:'item',name:'Sitrus Berry',rank:2,percentage:20,source:verified}];
    const sources={regulationId,metaTeams:[...splitSources,alternative],usageRows};
    const belief=buildPublicTeamBelief(preview,sources);
    expect(belief.candidates.find(candidate=>candidate.team.pokemon[0]!.item==='Charcoal')!.weight).toBeCloseTo(0.8);
    expect(belief.candidates.find(candidate=>candidate.team.pokemon[0]!.item==='Sitrus Berry')!.weight).toBeCloseTo(0.2);
    expect(belief.candidates.every(candidate=>candidate.sources.some(source=>source.provider==='usage-fixture'))).toBe(true);
    const unverified=buildPublicTeamBelief(preview,{...sources,usageRows:usageRows.map(row=>({...row,source:{...verified,regulationVerified:false}}))});
    expect(unverified.candidates.map(candidate=>candidate.weight)).toEqual([0.5,0.5]);
    expect(unverified.warnings.join(' ')).toMatch(/ignored usage/i);
    expect(buildPublicTeamBelief(preview,{...sources,usageRows:[...usageRows].reverse()})).toEqual(belief);
  });
  it('labels recombinations when public known fields rule out each published whole team',()=>{
    const first=published('whole-a',base.pokemon);
    const second=published('whole-b',base.pokemon.map((set,slot)=>slot===0?{...set,item:'Sitrus Berry'}:slot===1?{...set,item:'Life Orb'}:set));
    const belief=buildPublicTeamBelief(preview,{regulationId,metaTeams:[first,second],usageRows:[]},[{species:'Torkoal',item:'Charcoal'},{species:'Garchomp',item:'Life Orb'}]);
    expect(belief.candidates).toHaveLength(1);
    expect(belief.candidates[0]!.source.provider).toBe('published-set-recombination');
    expect(belief.candidates[0]!.assumptions.join(' ')).toMatch(/proposal weight/i);
    expect(belief.candidates[0]!.assumptions.join(' ')).toMatch(/6\/6/);
  });
  it('resolves tied duplicate usage rows without depending on source order',()=>{
    const source={provider:'usage-fixture',retrievedAt:'2026-09-07',regulationId,regulationVerified:true};
    const rows=[20,80].map(percentage=>({pokemon:'Torkoal',category:'item',name:'Charcoal',rank:1,percentage,source}));
    const sources={regulationId,metaTeams:[...splitSources,published('other-sun',[{...torkoal,item:'Sitrus Berry'}])],usageRows:rows};
    expect(buildPublicTeamBelief(preview,sources)).toEqual(buildPublicTeamBelief(preview,{...sources,usageRows:[...rows].reverse()}));
  });
  it('assembles published Ditto sets even when the arbitrary roster completion is unsupported',()=>{
    const ditto:PokemonSet={species:'Ditto',ability:'Imposter',nature:'Relaxed',moves:['Transform'],skillPoints:{hp:32,def:32,spd:2},ivs:{},level:50,item:'Choice Scarf'};
    const roster=['Ditto',...preview.slice(1)];
    const sources={regulationId,metaTeams:[published('ditto-source',[ditto,...base.pokemon.slice(1,3)]),splitSources[1]!],usageRows:[]};
    const belief=buildPublicTeamBelief(roster,sources);
    expect(belief.candidates).toHaveLength(1);
    expect(belief.candidates[0]!.team.pokemon[0]).toEqual(ditto);
    expect(belief.candidates[0]!.sourceTeamIds).toEqual(['balance','ditto-source']);
    expect(validateEngineTeam(belief.candidates[0]!.team)).toEqual([]);
  });
  it('preserves a published Ditto set while completing only another missing roster member',()=>{
    const ditto:PokemonSet={species:'Ditto',ability:'Imposter',nature:'Relaxed',moves:['Transform'],skillPoints:{hp:32,def:32,spd:2},ivs:{},level:50,item:'Choice Scarf'};
    const roster=['Ditto',...preview.slice(1)];
    const belief=buildPublicTeamBelief(roster,{regulationId,metaTeams:[published('partial-ditto',[ditto,...base.pokemon.slice(1,5)])],usageRows:[]});
    expect(belief.candidates).toHaveLength(1);
    expect(belief.candidates[0]!.team.pokemon[0]).toEqual(ditto);
    expect(belief.candidates[0]!.assumptions.join(' ')).toMatch(/5\/6/);
    expect(belief.warnings.join(' ')).toMatch(/Dragonite/);
    expect(validateEngineTeam(belief.candidates[0]!.team)).toEqual([]);
  });
  it('matches supported Aegislash aliases in both whole teams and individual sets',()=>{
    const aegislash:PokemonSet={species:'Aegislash-Shield',ability:'Stance Change',nature:'Quiet',moves:['Shadow Ball','Flash Cannon','Wide Guard','Protect'],skillPoints:{hp:32,spa:32,spd:2},ivs:{},level:50,item:'Leftovers'};
    const roster=['Aegislash',...preview.slice(1)];
    const whole=published('aegislash-whole',[aegislash,...base.pokemon.slice(1)]);
    const wholeBelief=buildPublicTeamBelief(roster,{regulationId,metaTeams:[whole],usageRows:[]});
    expect(wholeBelief.candidates).toHaveLength(1);
    expect(wholeBelief.candidates[0]!.sourceTeamIds).toEqual(['aegislash-whole']);
    expect(wholeBelief.candidates[0]!.source.provider).toBe('public-fixture');
    expect(wholeBelief.candidates[0]!.team.pokemon[0]).toEqual({...aegislash,species:'Aegislash'});
    const mixed=buildPublicTeamBelief(roster,{regulationId,metaTeams:[published('aegislash-part',[aegislash,...base.pokemon.slice(1,3)]),splitSources[1]!],usageRows:[]});
    expect(mixed.candidates).toHaveLength(1);
    expect(mixed.candidates[0]!.team.pokemon[0]).toEqual({...aegislash,species:'Aegislash'});
    expect(mixed.candidates[0]!.sourceTeamIds).toEqual(['aegislash-part','balance']);
    expect(validateEngineTeam(mixed.candidates[0]!.team)).toEqual([]);
  });
});
