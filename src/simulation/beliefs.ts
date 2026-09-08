import {Generations, toID} from '@smogon/calc';
import type {DamageRequest, MetaTeam, MetaUsageRow, PokemonSet, PokemonTeam, SourceReference} from '../domain/contracts.js';
import {calculateChampionsDamage} from '../calc/champions.js';
import {sha256} from '../util/hash.js';
import {STAT_IDS} from '../domain/contracts.js';

export type KnownPokemon = Partial<PokemonSet> & {species:string};
export interface TeamCandidate {
  id:string; team:PokemonTeam; weight:number; source:SourceReference;
  assumptions:string[]; sourceTeamIds:string[]; sources:SourceReference[];
}
type DamageDistribution = Array<{damage:number;probability:number}>;
export type BeliefObservation = (
  | {kind:'reveal';species:string;field:'move'|'item'|'ability'|'nature';value:string;origin?:'native'|'changed'|'copied'}
  | {kind:'damage';observedDamage:[number,number];likelihoods:Record<string,DamageDistribution>}
  | {kind:'speed';speeds:Record<string,number>;otherSpeed:number;actedFirst:boolean;priority:number;otherPriority:number;trickRoom?:boolean;orderUncertain?:boolean}
) & {turn?:number};
export interface TeamBelief {
  version:'team-particles-v2'; regulationId:string; preview:string[]; known:KnownPokemon[];
  candidates:TeamCandidate[]; observations:BeliefObservation[];
  status:'covered'|'insufficient_coverage'; effectiveSampleSize:number; warnings:string[];
}
export interface TeamBeliefInput {
  regulationId:string; preview:string[]; known?:KnownPokemon[]; exactTeam?:PokemonTeam;
  publishedTeams?:MetaTeam[]; usageRows?:MetaUsageRow[]; completionTeams?:PokemonTeam[];
  completionSourceLabel?:string;
  validateTeam?:(team:PokemonTeam)=>string[]; maxCandidates?:number;
}
const gen=Generations.get(0);
const id=(value:string|undefined)=>toID(value??'');
const calcSpecies=(species:string)=>id(species)==='aegislash'?'Aegislash-Shield':species;
const sameRoster=(a:string[],b:string[])=>a.map(id).sort().join(',')===b.map(id).sort().join(',');

/** Apply analyst-known fields to a sampled completion; never use this to disclose analyst truth to an actor.
 * Unspecified investments retain as much of the completion as fits the 66-point budget.
 * The caller must validate learnsets and full format clauses with the pinned engine afterward.
 */
export function applyKnownToCompletion(completion:PokemonTeam,known:KnownPokemon[]):PokemonTeam {
  const masks=new Map<string,KnownPokemon>();
  for(const observation of known){
    const key=id(observation.species);
    if(!completion.pokemon.some(set=>id(set.species)===key))throw new Error(`Known species ${observation.species} is absent from preview`);
    const mask=masks.get(key)??{species:observation.species};
    for(const field of ['item','ability','nature','level','gender','shiny','nickname'] as const){
      const value=observation[field],previous=mask[field];
      if(value===undefined)continue;
      if(previous!==undefined&&(typeof value==='string'?id(String(previous))!==id(value):previous!==value))throw new Error(`Conflicting known ${field} for ${observation.species}`);
      Object.assign(mask,{[field]:value});
    }
    if(observation.moves){
      const moves=[...(mask.moves??[])];
      for(const move of observation.moves){
        if(!id(move))throw new Error('Known move must be nonempty');
        if(!moves.some(other=>id(other)===id(move)))moves.push(move);
      }
      if(moves.length>4)throw new Error(`Known moves exceed four slots for ${observation.species}`);
      mask.moves=moves;
    }
    for(const field of ['skillPoints','ivs'] as const){
      if(!observation[field])continue;
      const values={...mask[field]};
      for(const [stat,value] of Object.entries(observation[field])){
        if(!STAT_IDS.includes(stat as typeof STAT_IDS[number])||!Number.isInteger(value)||value<0||value>(field==='skillPoints'?32:31))throw new Error(`Invalid known ${field}.${stat}`);
        const name=stat as typeof STAT_IDS[number];
        if(values[name]!==undefined&&values[name]!==value)throw new Error(`Conflicting known ${field}.${stat} for ${observation.species}`);
        values[name]=value;
      }
      mask[field]=values;
    }
    if(Object.values(mask.skillPoints??{}).reduce((sum,n)=>sum+n,0)>66)throw new Error('Known investments exceed the Champions 66-point total');
    if(mask.level!==undefined&&mask.level!==50)throw new Error('Champions completion requires level 50');
    masks.set(key,mask);
  }
  return {...structuredClone(completion),pokemon:completion.pokemon.map(original=>{
    const mask=masks.get(id(original.species));
    if(!mask)return structuredClone(original);
    const knownMoves=mask.moves??[];
    const skillPoints={...mask.skillPoints};
    let budget=66-Object.values(skillPoints).reduce((sum,n)=>sum+n,0);
    for(const stat of STAT_IDS)if(skillPoints[stat]===undefined){
      const amount=Math.min(Math.max(0,Math.min(32,original.skillPoints[stat]??0)),budget);
      skillPoints[stat]=amount;budget-=amount;
    }
    return {...structuredClone(original),...structuredClone(mask),
      moves:[...knownMoves,...original.moves.filter(move=>!knownMoves.some(knownMove=>id(knownMove)===id(move)))].slice(0,4),
      skillPoints,ivs:{...original.ivs,...mask.ivs},
    };
  })};
}

function matches(set:PokemonSet,known:KnownPokemon):boolean {
  if(id(set.species)!==id(known.species))return false;
  for(const field of ['item','ability','nature','level','gender','shiny'] as const){
    const value=known[field];
    if(value!==undefined && (typeof value==='string'?id(String(set[field]))!==id(value):set[field]!==value))return false;
  }
  if(known.moves?.some(move=>!set.moves.some(other=>id(move)===id(other))))return false;
  for(const field of ['skillPoints','ivs'] as const)for(const [stat,value] of Object.entries(known[field]??{})){
    const actual=set[field][stat as keyof PokemonSet[typeof field]]??(field==='ivs'?31:0);
    if(actual!==value)return false;
  }
  return true;
}

/** Structural Champions checks. Engine validation supplies species learnsets and format clauses. */
function structurallyValid(team:PokemonTeam):boolean {
  const species=new Set<string>();
  const items=new Set<string>();
  return team.pokemon.length>0&&team.pokemon.length<=6&&team.pokemon.every(set=>{
    if(!gen.species.get(id(calcSpecies(set.species)))||species.has(id(set.species)))return false;
    species.add(id(set.species));
    if(set.item){if(!gen.items.get(id(set.item))||items.has(id(set.item)))return false;items.add(id(set.item));}
    if(!set.ability||!gen.abilities.get(id(set.ability))||!set.nature||!gen.natures.get(id(set.nature)))return false;
    if(!set.moves.length||set.moves.length>4||new Set(set.moves.map(id)).size!==set.moves.length||set.moves.some(move=>!gen.moves.get(id(move))))return false;
    return set.level===50&&Object.values(set.skillPoints).every(v=>Number.isInteger(v)&&v>=0&&v<=32)&&Object.values(set.skillPoints).reduce((a,b)=>a+b,0)<=66&&Object.values(set.ivs).every(v=>Number.isInteger(v)&&v>=0&&v<=31);
  });
}

function publishedSpreadVariants(team:MetaTeam,limit:number):Array<{team:MetaTeam;weight:number;assumptions:string[]}> {
  if(!team.pokemon.some(set=>Object.keys(set.skillPoints).length===0))return [{team,weight:1,assumptions:[]}];
  const options=team.pokemon.map(set=>{
    if(Object.keys(set.skillPoints).length)return [set];
    const species=gen.species.get(id(calcSpecies(set.species)));
    const offense=species&&species.baseStats.atk>=species.baseStats.spa?'atk':'spa';
    const spreads=[{[offense]:32,spe:32,hp:2},{[offense]:32,hp:32,spd:2},{hp:32,def:16,spd:16,spe:2}];
    return spreads.map(skillPoints=>({...set,skillPoints,
      provenance:{...set.provenance,skillPoints:{knowledge:'inferred' as const,confidence:0,source:'unobserved investment scenario; uniform modeled spread prior'}}}
    ));
  });
  const total=options.reduce((n,sets)=>n*sets.length,1);
  const indices=Array.from({length:total},(_,i)=>i);
  // Include each marginal scenario before a deterministic dispersed joint subset.
  // Repeated prefix truncation would falsely freeze the first party members.
  const chosen=total<=limit?indices:[...new Set([0,(total-1)/2,total-1,...indices.toSorted((a,b)=>sha256(`${team.id}:${a}`).localeCompare(sha256(`${team.id}:${b}`)))])].slice(0,limit);
  const variants=chosen.map(index=>options.map(sets=>{const set=sets[index%sets.length]!;index=Math.floor(index/sets.length);return set;}));
  return variants.map(pokemon=>({team:{...team,pokemon},weight:1/variants.length,assumptions:['Published investment omitted: sampled offense/speed, offense/bulk or mixed bulk scenario; investments remain unknown to the actor.']}));
}

function normalized(belief:TeamBelief):TeamBelief {
  const candidates=belief.candidates.filter(c=>Number.isFinite(c.weight)&&c.weight>0);
  const total=candidates.reduce((sum,c)=>sum+c.weight,0);
  const result=candidates.map(c=>({...c,weight:c.weight/total}));
  return {...belief,candidates:result,status:result.length?'covered':'insufficient_coverage',effectiveSampleSize:result.length?1/result.reduce((sum,c)=>sum+c.weight*c.weight,0):0};
}

export function buildTeamBelief(input:TeamBeliefInput):TeamBelief {
  const known=structuredClone(input.known??[]);
  const warnings:string[]=[];
  const candidates:TeamCandidate[]=[];
  const limit=input.maxCandidates??128;
  if(!Number.isInteger(limit)||limit<1||limit>4096)throw new Error('maxCandidates must be 1–4096');
  const add=(team:PokemonTeam,source:SourceReference,assumptions:string[],weight=1,sourceTeamIds:string[]=[],sources:SourceReference[]=[source])=>{
    if(!sameRoster(team.pokemon.map(p=>p.species),input.preview)||!structurallyValid(team))return;
    if(known.some(k=>!team.pokemon.some(set=>matches(set,k))))return;
    if(input.validateTeam?.(team).length)return;
    const ordered={...team,pokemon:input.preview.map(species=>team.pokemon.find(set=>id(set.species)===id(species))!)};
    const key=sha256(JSON.stringify(ordered.pokemon));
    if(candidates.some(c=>c.id===key))return;
    if(candidates.length>=limit){warnings.push('Candidate cap reached; prior coverage is truncated.');return;}
    candidates.push({id:key,team:structuredClone(ordered),source:structuredClone(source),assumptions,weight,sourceTeamIds:[...sourceTeamIds],sources:structuredClone(sources)});
  };
  if(input.exactTeam){
    add(input.exactTeam,{provider:'supplied-exact',retrievedAt:'input',regulationId:input.regulationId},['Conditional on analyst-supplied exact team; expose to an actor only if actually known.']);
  }else{
    const variants=(input.publishedTeams??[]).filter(team=>team.regulationId===input.regulationId&&team.exactSets).flatMap(team=>publishedSpreadVariants(team,limit));
    const published=variants.map(variant=>variant.team);
    for(const {team,weight,assumptions} of variants)add({pokemon:team.pokemon},team.source,['Uniform source-team prior over compatible published teams; tournament sample, not ladder frequency.',...assumptions],weight,[team.id]);
    if(!candidates.length){
      for(const team of input.completionTeams??[])add(team,{provider:'explicit-completion-library',retrievedAt:'input',regulationId:input.regulationId},[`${input.completionSourceLabel??'Explicit completion prior'}; uniform conditional prior.`]);
      // Recombine complete published sets only when no matching whole team exists.
      const variants=input.preview.map(species=>published.flatMap(team=>team.pokemon.filter(set=>id(set.species)===id(species)).map(set=>({set,team}))));
      let attempts=0;
      const visit=(slot:number,sets:PokemonSet[],origins:MetaTeam[])=>{
        if(candidates.length>=limit||attempts>=limit*100)return;
        if(slot===variants.length){attempts++;add({pokemon:sets},{provider:'published-set-recombination',retrievedAt:'input',regulationId:input.regulationId},['Recombined complete published sets; cross-team correlations are not observed.',...(sets.some(set=>set.provenance?.skillPoints?.source.startsWith('unobserved investment scenario'))?['Missing published investments use hypothetical offense/speed/bulk scenarios, not known values.']:[])],1,[...new Set(origins.map(t=>t.id))],origins.map(t=>t.source));return;}
        for(const {set,team} of variants[slot]??[])visit(slot+1,[...sets,set],[...origins,team]);
      };
      visit(0,[],[]);
    }
  }
  const usage=(input.usageRows??[]).filter(row=>row.source.regulationVerified===true&&row.source.regulationId===input.regulationId);
  if(usage.length!==(input.usageRows?.length??0))warnings.push('Ignored usage rows without explicit verified matching regulation.');
  // Published whole-team probabilities are never overwritten by independent marginals.
  for(const candidate of candidates.filter(c=>c.source.provider==='published-set-recombination')){
    for(const set of candidate.team.pokemon){
      const rows=usage.filter(row=>id(row.pokemon)===id(set.species)&&row.category==='item');
      const matching=rows.find(row=>id(row.name)===id(set.item));
      if(rows.length)candidate.weight*=Math.max(0.01,Math.min(1,(matching?.percentage??1)/100));
    }
    if(usage.length)candidate.assumptions.push('Regulation-bound item marginals reweight fallback combinations with 1% exploration support; this is a modeling prior, not observed joint frequency.');
  }
  if(!input.validateTeam)warnings.push('Only calculator structural legality checked; validate all candidates with the pinned engine before simulation.');
  if(!candidates.length)warnings.push('Insufficient coverage: no complete compatible team; supply published sets or a legal completion library.');
  return normalized({version:'team-particles-v2',regulationId:input.regulationId,preview:[...input.preview],known,candidates,observations:[],status:'covered',effectiveSampleSize:0,warnings:[...new Set(warnings)]});
}

function likelihood(candidate:TeamCandidate,observation:BeliefObservation):number {
  if(observation.kind==='reveal'){
    if(observation.origin==='changed'||observation.origin==='copied')return 1;
    const set=candidate.team.pokemon.find(p=>id(p.species)===id(observation.species));
    if(!set)return 0;
    return (observation.field==='move'?set.moves.some(move=>id(move)===id(observation.value)):id(set[observation.field])===id(observation.value))?1:0;
  }
  if(observation.kind==='damage'){
    const rolls=observation.likelihoods[candidate.id];
    if(!rolls)return 1; // Unsupported calculator context is missing evidence, never impossibility.
    const total=rolls.reduce((sum,roll)=>sum+Math.max(0,roll.probability),0);
    if(!total)return 1;
    return rolls.filter(roll=>{
      const [low,high]=observation.observedDamage;
      // Small hits can subtract two HP percentages near 100, not near the damage magnitude.
      const tolerance=8*Number.EPSILON*Math.max(100,Math.abs(roll.damage),Math.abs(low),Math.abs(high));
      return roll.damage>=low-tolerance&&roll.damage<=high+tolerance;
    }).reduce((sum,roll)=>sum+Math.max(0,roll.probability),0)/total;
  }
  if(observation.priority!==observation.otherPriority||observation.orderUncertain)return 1;
  const speed=observation.speeds[candidate.id];
  if(speed===undefined)return 1;
  if(speed===observation.otherSpeed)return 0.5;
  const first=observation.trickRoom?speed<observation.otherSpeed:speed>observation.otherSpeed;
  return first===observation.actedFirst?1:0;
}

export function updateTeamBelief(belief:TeamBelief,observations:BeliefObservation[],options:{throughTurn?:number;expand?:(observations:BeliefObservation[])=>TeamBelief}={}):TeamBelief {
  const evidence=observations.filter(obs=>options.throughTurn===undefined||obs.turn===undefined||obs.turn<=options.throughTurn);
  let result=structuredClone(belief);
  for(const observation of evidence){
    result.candidates=result.candidates.map(candidate=>({...candidate,weight:candidate.weight*likelihood(candidate,observation)}));
    if(observation.kind==='reveal'&&observation.origin!=='changed'&&observation.origin!=='copied'){
      let known=result.known.find(p=>id(p.species)===id(observation.species));
      if(!known){known={species:observation.species};result.known.push(known);}
      if(observation.field==='move'){
        known.moves??=[];
        if(!known.moves.some(move=>id(move)===id(observation.value)))known.moves.push(observation.value);
      }else known[observation.field]=observation.value;
    }
    result.observations.push(structuredClone(observation));
    result=normalized(result);
  }
  if(!result.candidates.length&&evidence.length){
    if(options.expand){
      const expanded=options.expand(structuredClone(result.observations));
      result=updateTeamBelief({...expanded,observations:[]},result.observations);
      result.warnings.push('Prior exhausted; explicit legal prior expansion attempted and all past evidence reapplied.');
    }
    if(!result.candidates.length)result.warnings.push('Insufficient coverage: observations exhausted candidate support; no posterior reset performed.');
  }
  return result;
}

export function sampleBeliefTeam(belief:TeamBelief,seed:number|string):PokemonTeam {
  if(!belief.candidates.length)throw new Error('Insufficient belief coverage');
  // Stable hash-derived uniform variate, independent from engine random state.
  const u=parseInt(sha256(String(seed)).slice(0,13),16)/0x10000000000000;
  let cumulative=0;
  for(const candidate of belief.candidates){cumulative+=candidate.weight;if(u<cumulative)return structuredClone(candidate.team);}
  return structuredClone(belief.candidates.at(-1)!.team);
}

/** HP interval endpoints are percentages; callers choose exact or protocol rounding intervals. */
export function damageObservation(input:{before:[number,number];after:[number,number];maximumHp:number;likelihoods:Record<string,DamageDistribution>}):Extract<BeliefObservation,{kind:'damage'}> {
  return {kind:'damage',likelihoods:input.likelihoods,observedDamage:[Math.max(0,(input.before[0]-input.after[1])*input.maximumHp/100),Math.max(0,(input.before[1]-input.after[0])*input.maximumHp/100)]};
}

/** Integrate explicit nuisance scenarios (critical hits, field and position) without hidden engine access. */
export function calculateDamageLikelihoods(belief:TeamBelief,scenarios:(candidate:TeamCandidate)=>Array<{request:DamageRequest;weight:number}>):Record<string,DamageDistribution> {
  const result:Record<string,DamageDistribution>={};
  for(const candidate of belief.candidates){
    const variants=scenarios(candidate).filter(s=>Number.isFinite(s.weight)&&s.weight>0);
    const total=variants.reduce((sum,s)=>sum+s.weight,0);
    if(!total)continue;
    try{result[candidate.id]=variants.flatMap(s=>{
      const calculation=calculateChampionsDamage(s.request);
      return (calculation.damageDistribution??calculation.damage.map(damage=>({damage,probability:1/calculation.damage.length}))).map(roll=>({damage:roll.damage,probability:roll.probability*s.weight/total}));
    });}catch{/* Missing evidence for unsupported mechanics, not negative evidence. */}
  }
  return result;
}
