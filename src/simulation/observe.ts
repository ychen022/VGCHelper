import {Generations,Pokemon,toID} from '@smogon/calc';
import type {PokemonSet,PokemonTeam} from '../domain/contracts.js';
import type {PlayerView} from './engine.js';
import {validateEngineTeam} from './engine.js';
import {buildTeamBelief,calculateDamageLikelihoods,updateTeamBelief,type BeliefObservation,type TeamBelief,type TeamCandidate} from './beliefs.js';
import {movePriority,isSpreadMove} from '../calc/champions.js';
import {readOpenSheet} from '../replay/sheets.js';
import {sha256} from '../util/hash.js';
import {speciesIdentity} from './identity.js';

export interface ObserveOptions {
  completionTeams?:PokemonTeam[];
  validateTeam?:(team:PokemonTeam)=>string[];
  expand?:boolean;
}
interface PrefixBelief extends TeamBelief {observedPrefix?:{count:number;hash:string}}
interface Hp {low:number;high:number;maximum?:number}
interface VisiblePokemon {species:string;form:string;hp?:Hp;changedItem:boolean;changedAbility:boolean;copied:boolean;currentItem?:string;currentAbility?:string}
interface MoveEvent {actor:string;target:string;move:string;index:number;turn:number;unsafe:boolean;trickRoom:boolean;state:VisiblePokemon}
const gen=Generations.get(0);
const id=(value:string)=>toID(value);
const slot=(value:string)=>value.slice(0,3);
const clone=<T>(value:T):T=>structuredClone(value);
function hp(value:string,own:boolean):Hp|undefined {
  const match=/^(\d+)(?:\/(\d+))?/.exec(value);
  if(!match)return undefined;
  const current=Number(match[1]),maximum=Number(match[2]??100);
  if(!maximum)return undefined;
  const percent=current/maximum*100;
  return own?{low:percent,high:percent,maximum}:{low:Math.max(0,percent-(current?100/maximum:0)),high:percent};
}
function baseSpecies(form:string,preview:string[]):string {
  return preview.find(name=>id(name)===id(form))??preview.find(name=>speciesIdentity(name)===speciesIdentity(form))??form;
}
function ownSet(view:PlayerView,state:VisiblePokemon):PokemonSet|undefined {
  return view.ownTeam.pokemon.find(set=>id(set.species)===id(state.species)||id(set.species)===id(state.form));
}
function candidateSet(candidate:TeamCandidate,state:VisiblePokemon):PokemonSet|undefined {
  return candidate.team.pokemon.find(set=>id(set.species)===id(state.species));
}
function presentSet(set:PokemonSet,state:VisiblePokemon):PokemonSet {
  return {...set,species:state.form,...(state.currentItem!==undefined?{item:state.currentItem}:{}),...(state.currentAbility!==undefined?{ability:state.currentAbility}:{})};
}
function stats(set:PokemonSet):Pokemon {
  return new Pokemon(gen,id(set.species)==='aegislash'?'Aegislash-Shield':set.species,{level:set.level,evs:set.skillPoints,ivs:set.ivs,...(set.nature?{nature:set.nature}:{}),...(set.item?{item:set.item}:{}),...(set.ability?{ability:set.ability}:{})});
}
function hpScenarios(set:PokemonSet,state:VisiblePokemon):number[] {
  if(!state.hp)return [];
  const max=stats(set).maxHP(),{low,high,maximum}=state.hp;
  if(maximum!==undefined)return [Math.round(high*max/100)/max*100].filter(percent=>percent>0);
  const tolerance=8*Number.EPSILON*max;
  // Public positive HP is rounded up: the lower percentage endpoint is exclusive.
  const first=Math.max(1,Math.floor(low*max/100+tolerance)+1);
  const last=Math.min(max,Math.floor(high*max/100+tolerance));
  return Array.from({length:Math.max(0,last-first+1)},(_,i)=>(first+i)/max*100);
}
function speed(set:PokemonSet):number {
  const base=stats(set).stats.spe;
  return Math.floor(base*(id(set.item??'')==='choicescarf'?1.5:['ironball','machobrace','poweranklet','powerband','powerbelt','powerbracer','powerlens','powerweight'].includes(id(set.item??''))?0.5:1));
}
function ambiguousOrder(set:PokemonSet):boolean {
  return ['quickclaw','custapberry','laggingtail','fullincense'].includes(id(set.item??''))||['prankster','galewings','triage','quickdraw','stall','myceliummight'].includes(id(set.ability??''));
}

/** Consume an actor's legally visible log prefix. Never accepts opposing truth or requests. */
export function updateBeliefFromView(prior:TeamBelief,view:PlayerView,options:ObserveOptions={}):TeamBelief {
  const lines:string[]=[];
  let turn=0;
  for(const raw of view.observations.flatMap(line=>line.split('\n'))){
    if(raw.startsWith('|turn|')){turn=Number(raw.split('|')[2]);if(turn>view.turn)break;}
    lines.push(raw);
  }
  const previous=(prior as PrefixBelief).observedPrefix;
  const oldCount=previous?.count??0;
  if(previous&&sha256(lines.slice(0,oldCount).join('\n'))!==previous.hash){
    return {...clone(prior),warnings:[...new Set([...prior.warnings,'Observation prefix changed; use the original prior to evaluate a different prefix.'])]};
  }
  if(previous&&oldCount===lines.length)return clone(prior);
  let result=clone(prior);
  const warnings=new Set(result.warnings);
  const states=new Map<string,VisiblePokemon>();
  const identities=new Map<string,VisiblePokemon>();
  const opponent=view.side==='p1'?'p2':'p1';
  let unsafe=false,trickRoom=false;
  let moves:MoveEvent[]=[];
  turn=0;
  let lastMove:MoveEvent|undefined;
  const apply=(observation:BeliefObservation)=>{
    const before=result;
    result=updateTeamBelief(result,[observation]);
    if(result.status==='covered'||options.expand===false||observation.kind!=='reveal')return;
    const known=clone(result.known);
    const templates=[...before.candidates.map(c=>c.team),...(options.completionTeams??[])];
    const teams=templates.map(team=>({...clone(team),pokemon:team.pokemon.map(original=>{
      const revealed=known.find(k=>id(k.species)===id(original.species));
      if(!revealed)return clone(original);
      const revealedMoves=revealed.moves??[];
      return {...clone(original),...revealed,moves:[...revealedMoves,...original.moves.filter(move=>!revealedMoves.some(m=>id(m)===id(move)))].slice(0,4),skillPoints:original.skillPoints,ivs:original.ivs};
    })}));
    const expanded=buildTeamBelief({regulationId:prior.regulationId,preview:prior.preview,known,completionTeams:teams,validateTeam:options.validateTeam??validateEngineTeam});
    if(expanded.status==='covered'){
      // Native constraints are reapplied by buildTeamBelief. Historical numerical evidence needs
      // recomputation for new candidate IDs, so expansion is explicitly a coverage recovery.
      result={...expanded,observations:result.observations};
      warnings.add('Public reveals required legal prior expansion; expanded sets preserve sampled unknown investments. Historical damage/order likelihoods were not recomputed for new candidates; posterior coverage is approximate.');
    }else warnings.add('Insufficient coverage after public-reveal expansion; policy must use a view-only fallback.');
  };
  const finishOrder=()=>{
    const firstOwn=moves.find(m=>m.actor.startsWith(view.side));
    const firstOpp=moves.find(m=>m.actor.startsWith(opponent));
    if(!firstOwn||!firstOpp||Math.max(firstOwn.index,firstOpp.index)<oldCount)return;
    if(firstOwn.unsafe||firstOpp.unsafe||firstOwn.trickRoom!==firstOpp.trickRoom){warnings.add('Skipped speed evidence: public status, field, boosts or order-changing mechanics make effective order ambiguous.');return;}
    try{
      const own=ownSet(view,firstOwn.state);
      if(!own)return;
      const ownCurrent=presentSet(own,firstOwn.state);
      if(ambiguousOrder(ownCurrent)||result.candidates.some(c=>{const set=candidateSet(c,firstOpp.state);return !set||ambiguousOrder(presentSet(set,firstOpp.state));})){
        warnings.add('Skipped speed evidence: candidate-dependent priority or random ordering effects.');return;
      }
      const priority=movePriority(firstOpp.move),otherPriority=movePriority(firstOwn.move);
      if(priority!==otherPriority)return;
      const speeds=Object.fromEntries(result.candidates.flatMap(c=>{const set=candidateSet(c,firstOpp.state);return set?[[c.id,speed(presentSet(set,firstOpp.state))]]:[];}));
      apply({kind:'speed',speeds,otherSpeed:speed(ownCurrent),actedFirst:firstOpp.index<firstOwn.index,priority,otherPriority,trickRoom:firstOpp.trickRoom,turn:firstOpp.turn});
    }catch{warnings.add('Skipped speed evidence: unsupported calculator species or move.');}
  };
  for(let index=0;index<lines.length;index++){
    const parts=lines[index]!.split('|'),kind=parts[1]??'',who=parts[2]??'',value=parts[3]??'';
    const key=slot(who),isOpponent=who.startsWith(opponent);
    if(kind==='turn'){
      finishOrder();moves=[];lastMove=undefined;turn=Number(who);continue;
    }
    if(kind==='switch'||kind==='drag'||kind==='replace'){
      const form=value.split(',')[0]!;
      const roster=isOpponent?prior.preview:view.ownTeam.pokemon.map(p=>p.species);
      const identity=`${who.slice(0,2)}:${who.split(': ').slice(1).join(': ')}`;
      const previousState=identities.get(identity);
      const health=hp(parts[4]??'',!isOpponent);
      const species=baseSpecies(form,roster);
      const nextState:VisiblePokemon={species,form,changedItem:false,changedAbility:id(species)!==id(form),copied:false,...(health?{hp:health}:{}),...(previousState?{
        changedItem:previousState.changedItem,
        ...(previousState.currentItem!==undefined?{currentItem:previousState.currentItem}:{}),
      }:{}),...(kind==='replace'&&previousState?{changedAbility:previousState.changedAbility,copied:previousState.copied}:{})};
      states.set(key,nextState);identities.set(identity,nextState);
      if(lastMove)unsafe=true; // Mid-resolution replacement/switch can change ordering.
      continue;
    }
    if(kind==='showteam'&&who===opponent&&index>=oldCount){
      try{for(const set of readOpenSheet(value)){
        const species=baseSpecies(set.species,prior.preview);
        for(const field of ['item','ability','nature'] as const)if(set[field]!==undefined)apply({kind:'reveal',species,field,value:set[field]!,turn});
        for(const move of set.moves)apply({kind:'reveal',species,field:'move',value:move,turn});
      }}catch{warnings.add('Skipped malformed open team sheet.');}
      continue;
    }
    const state=states.get(key);
    if(kind==='detailschange'||kind==='-formechange'){
      if(state){state.form=value.split(',')[0]!;state.changedAbility=true;}
      unsafe=true;continue;
    }
    if(kind==='-transform'){if(state)state.copied=true;unsafe=true;continue;}
    if(kind==='-fieldstart'&&/trick room/i.test(who)){trickRoom=true;continue;}
    if(kind==='-fieldend'&&/trick room/i.test(who)){trickRoom=false;continue;}
    if(['-weather','-fieldstart','-fieldend','-sidestart','-sideend','-boost','-unboost','-setboost','-swapboost','-copyboost','-clearboost','-clearallboost','-status','-curestatus','-start','-end','-activate'].includes(kind))unsafe=true;
    if(kind==='-mega'&&state){
      const stone=parts[4];
      if(stone){
        if(isOpponent&&index>=oldCount)apply({kind:'reveal',species:state.species,field:'item',value:stone,origin:state.changedItem?'changed':'native',turn});
        state.currentItem=stone;
      }
      state.changedAbility=true;unsafe=true;continue;
    }
    if((kind==='-item'||kind==='-enditem')&&state){
      const changed=state.changedItem||(kind==='-item'&&parts.slice(4).some(p=>p.startsWith('[from]')));
      if(isOpponent&&index>=oldCount)apply({kind:'reveal',species:state.species,field:'item',value,origin:changed?'changed':'native',turn});
      state.changedItem=changed;state.currentItem=kind==='-enditem'?'':value;
      unsafe=true;continue;
    }
    if(kind==='-ability'&&state){
      const changed=state.changedAbility||parts.slice(4).some(p=>p.startsWith('[from]'));
      if(isOpponent&&index>=oldCount)apply({kind:'reveal',species:state.species,field:'ability',value,origin:changed?'changed':'native',turn});
      state.changedAbility=changed;state.currentAbility=value;continue;
    }
    if(kind==='move'&&state){
      const copied=state.copied||parts.slice(5).some(p=>p.startsWith('[from]'));
      if(isOpponent&&index>=oldCount)apply({kind:'reveal',species:state.species,field:'move',value,origin:copied?'copied':'native',turn});
      lastMove={actor:who,target:parts[4]??'',move:value,index,turn,unsafe:unsafe||copied,trickRoom,state:clone(state)};
      moves.push(lastMove);
      if(['trick','switcheroo','skillswap','roleplay','doodle','entrainment','worryseed','simplebeam','gastroacid'].includes(id(value)))unsafe=true;
      continue;
    }
    if((kind==='-damage'||kind==='-heal')&&state){
      const after=hp(value,!isOpponent),before=state.hp;
      if(index>=oldCount&&kind==='-damage'&&before&&after&&lastMove&&lastMove.actor.slice(0,2)!==who.slice(0,2)){
        const nextMove=lines.findIndex((line,i)=>i>lastMove!.index&&(line.startsWith('|move|')||line.startsWith('|turn|')));
        const block=lines.slice(lastMove.index,nextMove<0?lines.length:nextMove);
        const ambiguous=unsafe||lastMove.unsafe||parts.slice(4).some(p=>p.startsWith('[from]'))||block.some(line=>/^\|-(?:crit|hitcount|fail|immune|miss|enditem|item|boost|unboost|status|activate|ability)\|/.test(line));
        if(ambiguous){warnings.add('Skipped ambiguous direct damage evidence (critical, multi-hit, item/ability change or field/state context).');}
        else try{
          if(isSpreadMove(lastMove.move)){warnings.add('Skipped spread damage evidence: active-target count and partner modifiers are not reconstructed.');}
          else {
            const attackerState=lastMove.state,defenderState=clone(state),move=lastMove.move;
            const attackerOwn=lastMove.actor.startsWith(view.side);
            const likelihoods=calculateDamageLikelihoods(result,c=>{
              const attacker=attackerOwn?ownSet(view,attackerState):candidateSet(c,attackerState);
              const defender=attackerOwn?candidateSet(c,defenderState):ownSet(view,defenderState);
              if(!attacker||!defender)return [];
              const currentAttacker=presentSet(attacker,attackerState),currentDefender=presentSet(defender,defenderState);
              const attackerHp=hpScenarios(currentAttacker,attackerState),defenderHp=hpScenarios(currentDefender,defenderState);
              if(attackerHp.length>1||defenderHp.length>1)warnings.add('Rounded pre-hit HP uses uniformly weighted compatible integer-HP scenarios; these nuisance weights are approximate.');
              return attackerHp.flatMap(hpPercent=>defenderHp.map(defenderPercent=>({weight:1,request:{
                attacker:currentAttacker,defender:currentDefender,move,
                attackerPosition:{species:attackerState.form,hpPercent},
                defenderPosition:{species:defenderState.form,hpPercent:defenderPercent},
              }})));
            });
            for(const c of result.candidates){
              const defender=attackerOwn?candidateSet(c,defenderState):ownSet(view,defenderState);
              if(!defender||!likelihoods[c.id])continue;
              const max=before.maximum??stats(presentSet(defender,defenderState)).maxHP();
              likelihoods[c.id]=likelihoods[c.id]!.map(roll=>({damage:Math.min(roll.damage/max*100,before.high),probability:roll.probability}));
            }
            if(Object.keys(likelihoods).length!==result.candidates.length)warnings.add('Some candidates lack supported damage likelihoods; their weights remain unchanged.');
            apply({kind:'damage',observedDamage:[Math.max(0,before.low-after.high),Math.max(0,before.high-after.low)],likelihoods,turn});
          }
        }catch{warnings.add('Skipped direct damage evidence: unsupported calculator context.');}
      }
      if(after)state.hp=after;
      continue;
    }
  }
  // A decision view normally ends in a turn header; only completed order groups count.
  if(view.ended)finishOrder();
  const output:PrefixBelief={...result,warnings:[...new Set([...result.warnings,...warnings])],observedPrefix:{count:lines.length,hash:sha256(lines.join('\n'))}};
  return output;
}
