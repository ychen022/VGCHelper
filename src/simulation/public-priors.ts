import {STAT_IDS,type MetaTeam,type MetaUsageRow,type PokemonSet,type SourceReference} from '../domain/contracts.js';
import {sha256} from '../util/hash.js';
import {applyKnownToCompletion,buildTeamBelief,type KnownPokemon,type TeamBelief,type TeamCandidate} from './beliefs.js';
import {completePreviewTeam,moveMetadata,validateEngineTeam} from './engine.js';
import {speciesIdentity} from './identity.js';

export interface PublicBeliefSources {regulationId:string;metaTeams:MetaTeam[];usageRows:MetaUsageRow[]}
interface SetProposal {set:PokemonSet;sourceTeamIds:string[];sources:SourceReference[];assumptions:string[]}
const MAX_CANDIDATES=32,MAX_SETS_PER_SPECIES=24,MAX_ATTEMPTS=3200;
const id=(value:string|undefined)=>String(value??'').toLowerCase().replace(/[^a-z0-9]/g,'');
const rosterKey=(roster:string[])=>roster.map(speciesIdentity).sort().join(',');
const sourceKey=(source:SourceReference)=>JSON.stringify(Object.entries(source).sort(([a],[b])=>a.localeCompare(b)));
const uniqueSources=(sources:SourceReference[])=>[...new Map(sources.map(source=>[sourceKey(source),source])).entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,source])=>source);
// Ignore presentation/provenance differences when de-duplicating the same mechanical set.
function setKey(set:PokemonSet):string {
  return sha256(JSON.stringify([id(set.species),id(set.item),id(set.ability),id(set.nature),set.moves.map(id).sort(),
    STAT_IDS.map(stat=>set.skillPoints[stat]??0),STAT_IDS.map(stat=>set.ivs[stat]??31),set.level,set.gender??'',set.shiny??false]));
}

function investmentScenarios(set:PokemonSet):PokemonSet[] {
  if(Object.keys(set.skillPoints).length)return [set];
  let physical=0,special=0;
  try{
    for(const name of set.moves){
      const move=moveMetadata(name);
      if(move.category==='Physical')physical+=move.basePower;
      if(move.category==='Special')special+=move.basePower;
    }
  }catch{return [];}
  const offense=special>physical?'spa':'atk';
  const spreads=[{[offense]:32,spe:32,hp:2},{[offense]:32,hp:32,spd:2},{hp:32,def:16,spd:16,spe:2}];
  return spreads.map(skillPoints=>({...set,skillPoints,provenance:{...set.provenance,
    skillPoints:{knowledge:'inferred',confidence:0,source:'Unobserved investment scenario based on the published move categories; not an observed spread.'}}}));
}

function assemble(options:SetProposal[][],add:(proposal:SetProposal[])=>boolean):{bounded:boolean} {
  const total=options.reduce((product,slot)=>product*slot.length,1);
  if(!total)return {bounded:false};
  const visited=new Set<string>();
  let accepted=0;
  const visit=(indices:number[])=>{
    const key=indices.join(',');
    if(visited.has(key))return;
    visited.add(key);
    const proposal=indices.map((index,slot)=>options[slot]![index]!);
    const items=proposal.map(option=>id(option.set.item)).filter(Boolean);
    if(new Set(items).size!==items.length)return;
    if(add(proposal))accepted++;
  };
  // Cover each marginal before sampling the remaining Cartesian product. Prefix
  // truncation would fix the first party member even when later sets vary.
  for(let round=0;round<Math.max(...options.map(slot=>slot.length))&&accepted<MAX_CANDIDATES;round++)visit(options.map(slot=>round%slot.length));
  // A coprime stride permutes the product without allocating it. The seed is
  // constant and depends on no live battle state, private set or engine RNG.
  const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
  let stride=Math.max(1,Math.floor(total*0.6180339887498949));
  while(gcd(stride,total)!==1)stride++;
  for(let step=0;step<total&&visited.size<MAX_ATTEMPTS&&accepted<MAX_CANDIDATES;step++){
    let index=(step*stride)%total;
    const indices=options.map(slot=>{const value=index%slot.length;index=Math.floor(index/slot.length);return value;});
    visit(indices);
  }
  return {bounded:visited.size<total};
}

/** Actor priors depend on public source snapshots and actual public revelations only. */
export function buildPublicTeamBelief(preview:string[],sources:PublicBeliefSources,known:KnownPokemon[]=[]):TeamBelief {
  const previewSpecies=(species:string)=>preview.find(value=>speciesIdentity(value)===speciesIdentity(species))??species;
  known=known.map(value=>({...value,species:previewSpecies(value.species)}));
  const published=sources.metaTeams.filter(team=>team.exactSets&&team.regulationId===sources.regulationId&&
    (!team.source.regulationId||team.source.regulationId===sources.regulationId))
    .toSorted((a,b)=>a.id.localeCompare(b.id)||sourceKey(a.source).localeCompare(sourceKey(b.source))||JSON.stringify(a.pokemon).localeCompare(JSON.stringify(b.pokemon)))
    .map(team=>({...team,pokemon:team.pokemon.map(set=>({...set,species:previewSpecies(set.species)}))}));
  const input={regulationId:sources.regulationId,preview,known,usageRows:sources.usageRows,validateTeam:validateEngineTeam,maxCandidates:MAX_CANDIDATES};
  // The general builder can recombine even these teams after known-field
  // filtering. Only its actual whole-team result may bypass our sampler.
  const whole=buildTeamBelief({...input,publishedTeams:published.filter(team=>rosterKey(team.pokemon.map(set=>set.species))===rosterKey(preview))});
  if(whole.candidates.some(candidate=>candidate.source.provider!=='published-set-recombination'))return whole;
  whole.candidates=[];whole.status='insufficient_coverage';whole.effectiveSampleSize=0;
  const warnings=whole.warnings.filter(warning=>!warning.startsWith('Insufficient coverage:'));
  // The pinned validator requires six members. Independent itemless
  // padding validates each source set without needing to synthesize its roster
  // partners (e.g. Ditto has no damaging-move baseline). Padding is never proposed.
  const validationPadding=completePreviewTeam(['Garchomp','Whimsicott','Kingambit','Sneasler','Dragonite','Basculegion']).pokemon;
  const partners=(species:string)=>validationPadding.filter(set=>speciesIdentity(set.species)!==speciesIdentity(species)).slice(0,5);
  const missing:string[]=[];
  let marginalCap=false;
  const options=preview.map(species=>{
    const unique=new Map<string,SetProposal>();
    for(const origin of published)for(const set of origin.pokemon.filter(set=>id(set.species)===id(species))){
      const single=buildTeamBelief({regulationId:sources.regulationId,preview:[species],known:known.filter(value=>id(value.species)===id(species)),
        publishedTeams:investmentScenarios(set).map(proposed=>({...origin,pokemon:[proposed],roster:[species]})),maxCandidates:3});
      for(const candidate of single.candidates){
        const proposed=candidate.team.pokemon[0]!;
        const validationTeam={pokemon:[proposed,...partners(species)]};
        if(validateEngineTeam(validationTeam).length)continue;
        const key=setKey(proposed),previous=unique.get(key);
        const assumptions=candidate.assumptions.filter(assumption=>!assumption.startsWith('Uniform source-team prior'));
        if(!Object.keys(set.skillPoints).length)assumptions.push('Published investments omitted: hypothetical offense/speed, offense/bulk and mixed-bulk scenarios based on the published move categories; true investments remain unknown.');
        unique.set(key,{set:previous?.set??proposed,sourceTeamIds:[...new Set([...(previous?.sourceTeamIds??[]),origin.id])].sort(),
          sources:uniqueSources([...(previous?.sources??[]),origin.source]),assumptions:[...new Set([...(previous?.assumptions??[]),...assumptions])]});
      }
    }
    marginalCap ||= unique.size>MAX_SETS_PER_SPECIES;
    const values=[...unique.entries()].sort(([a],[b])=>a.localeCompare(b)).slice(0,MAX_SETS_PER_SPECIES).map(([,option])=>option);
    if(values.length)return values;
    missing.push(species);
    try{
      const baseline=completePreviewTeam([species,...partners(species).map(set=>set.species)]);
      baseline.pokemon[0]={...baseline.pokemon[0]!,species};
      const set=applyKnownToCompletion(baseline,known.filter(value=>id(value.species)===id(species))).pokemon[0]!;
      return [{set,sourceTeamIds:[],sources:[],assumptions:[`No compatible published set for ${species}: weak synthetic exploratory completion; not an estimate of a realistic competitive set.`]}];
    }catch{return [];}
  });
  const usage=sources.usageRows.filter(row=>row.source.regulationVerified===true&&row.source.regulationId===sources.regulationId)
    .toSorted((a,b)=>sourceKey(a.source).localeCompare(sourceKey(b.source))||a.rank-b.rank||a.name.localeCompare(b.name)||a.percentage-b.percentage);
  const candidates:TeamCandidate[]=[];
  const source:SourceReference={provider:missing.length?'partial-public-set-completion':'published-set-recombination',retrievedAt:'input',regulationId:sources.regulationId};
  const {bounded}=assemble(options,proposal=>{
    const checked=buildTeamBelief({...input,usageRows:[],completionTeams:[{pokemon:proposal.map(option=>option.set)}]});
    const candidate=checked.candidates[0];
    if(!candidate||candidates.some(previous=>previous.id===candidate.id))return false;
    const usedUsage:SourceReference[]=[];
    let weight=1;
    for(const option of proposal){
      const rows=usage.filter(row=>id(row.pokemon)===id(option.set.species)&&row.category==='item'&&Number.isFinite(row.percentage));
      if(!rows.length)continue;
      const matching=rows.find(row=>id(row.name)===id(option.set.item));
      weight*=Math.max(0.01,Math.min(1,(matching?.percentage??1)/100));
      usedUsage.push(...rows.map(row=>row.source));
    }
    candidates.push({...candidate,source,weight,sourceTeamIds:[...new Set(proposal.flatMap(option=>option.sourceTeamIds))].sort(),
      sources:uniqueSources([...proposal.flatMap(option=>option.sources),...usedUsage]),assumptions:[
        'Synthetic joint team assembled from complete public sets; cross-team correlations are unobserved. Proposal weights are model judgments, not observed joint frequencies.',
        `Published set coverage: ${preview.length-missing.length}/${preview.length} roster members.`,
        ...new Set(proposal.flatMap(option=>option.assumptions)),
        ...(usedUsage.length?['Verified matching-regulation item marginals reweight proposals with 1% exploration support; these are not empirical joint probabilities.']:['Uniform proposal weights across the retained legal combinations; source duplication does not add probability mass.']),
      ]});
    return true;
  });
  if(missing.length)warnings.push(`Insufficient published set coverage: ${missing.join(', ')}. Their synthetic completions have weak assumptions; this prior supports only limited exploratory evaluation.`);
  if(bounded||marginalCap)warnings.push('Public set proposal cap reached; bounded combinations retain incomplete coverage and are not exhaustive.');
  if(!candidates.length)warnings.push('Insufficient coverage: no legal joint team satisfies the roster and public known fields.');
  const total=candidates.reduce((sum,candidate)=>sum+candidate.weight,0);
  for(const candidate of candidates)candidate.weight/=total;
  return {...whole,candidates,status:candidates.length?'covered':'insufficient_coverage',
    effectiveSampleSize:candidates.length?1/candidates.reduce((sum,candidate)=>sum+candidate.weight**2,0):0,warnings:[...new Set(warnings)]};
}
