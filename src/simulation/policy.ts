import {Generations,toID} from '@smogon/calc';
import type {BattleState,PokemonSet,PokemonBattleState,PokemonPosition} from '../domain/contracts.js';
import {calculateChampionsDamage,isDamagingMove,isSpreadMove} from '../calc/champions.js';
import {applyEvent,emptyBattleState,normalizeEvents} from '../replay/parser.js';
import {sha256} from '../util/hash.js';
import type {PlayerView,RequestPokemon} from './engine.js';
import {moveMetadata} from './engine.js';
import type {TeamBelief} from './beliefs.js';
import {speciesIdentity} from './identity.js';
import {isPartnerHealing,planningFamilies,unsupportedAction} from './action-support.js';

export const POLICY_VERSION='belief-credible-v3';
export type PolicyStyle='tactical'|'damage';
export interface ActionProbability {command:string;score:number;probability:number;reasons:string[]}
export interface ActionSelectionOptions {topFraction?:number;maxScoreGap?:number}
const gen=Generations.get(0);
const base=speciesIdentity;
export function seededRandom(seed:string|number):()=>number {
  let state=parseInt(sha256(String(seed)).slice(0,8),16)||1;
  return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
}
export function chooseAction(actions:ActionProbability[],seed:string|number):string|undefined {
  if(!actions.length)return undefined;
  let threshold=seededRandom(seed)();
  for(const action of actions){threshold-=action.probability;if(threshold<=0)return action.command;}
  return actions.at(-1)!.command;
}
export function publicBattleState(view:Pick<PlayerView,'observations'>):BattleState {
  const state=emptyBattleState();for(const event of normalizeEvents(view.observations.join('\n')))applyEvent(state,event);return state;
}
export function ownSet(view:PlayerView,pokemon:RequestPokemon):PokemonSet {
  const species=pokemon.details.split(',')[0]!;
  const nickname=pokemon.ident.split(': ').slice(1).join(': ');
  const set=view.ownTeam.pokemon.find(p=>(p.nickname??p.species)===nickname)
    ??view.ownTeam.pokemon.find(p=>base(p.species)===base(species));
  if(!set)throw new Error(`Own request Pokemon is absent from own team: ${pokemon.ident}`);
  return {...set,item:gen.items.get(toID(pokemon.item))?.name??pokemon.item,
    ability:gen.abilities.get(toID(pokemon.ability??pokemon.baseAbility))?.name??pokemon.ability??pokemon.baseAbility};
}
function position(state:PokemonBattleState|undefined,species?:string):PokemonPosition {
  return {...(species||state?.species?{species:species??state!.species!}:{}),
    ...(state?.boosts?{boosts:state.boosts}:{}),...(state?.status?{status:state.status}:{}),
    ...(state?.hpPercent&&state.hpPercent>0?{hpPercent:state.hpPercent}:{}),
    ...(state?.ability?{ability:state.ability}:{}),
    ...(state?.itemConsumed||state?.itemRemoved?{item:''}:state?.item?{item:state.item}:{})};
}
function pressure(attacker:PokemonSet,defender:PokemonSet,move:string,state?:BattleState,attackerState?:PokemonBattleState,defenderState?:PokemonBattleState,mega=false):number {
  try {
    const attackerPosition=position(attackerState,attackerState?.species??attacker.species);
    if(mega) {
      const targets=attacker.item?gen.items.get(toID(attacker.item))?.megaStone:undefined;
      const megaSpecies=targets?Object.entries(targets).find(([original])=>base(original)===base(attacker.species))?.[1]:undefined;
      if(megaSpecies){attackerPosition.species=megaSpecies;delete attackerPosition.ability;}
    }
    const result=calculateChampionsDamage({attacker,defender,move,
      attackerPosition,
      defenderPosition:position(defenderState,defenderState?.species??defender.species),
      field:{...(state?.field.weather?{weather:state.field.weather}:{}),...(state?.field.terrain?{terrain:state.field.terrain}:{}),
        isReflect:Boolean(defenderState&&state?.sides[defenderState.side].conditions?.includes('Reflect')),
        isLightScreen:Boolean(defenderState&&state?.sides[defenderState.side].conditions?.includes('Light Screen'))}});
    const accuracy=moveMetadata(move).accuracy;
    const amount=(result.percentRange[0]+result.percentRange[1])/2;
    const hp=defenderState?.hpPercent??100;
    return (Math.min(125,amount)+ (amount>=hp?25:0))*(typeof accuracy==='number'?accuracy/100:1);
  } catch {return 0;}
}
function mean(values:number[]):number{return values.reduce((a,b)=>a+b,0)/Math.max(1,values.length);}

/** Pure actor-view scoring. Hidden engine state is deliberately absent from the interface. */
export function scoreActions(view:PlayerView,belief:TeamBelief,style:PolicyStyle='tactical'):ActionProbability[] {
  if(view.ended||!view.legalCommands.length)return [];
  const state=publicBattleState(view);const opponent=view.side==='p1'?'p2':'p1';
  const candidates=[...belief.candidates].sort((a,b)=>b.weight-a.weight).slice(0,8);
  const weight=candidates.reduce((sum,c)=>sum+c.weight,0)||1;
  const foeStates=Object.values(state.sides[opponent].pokemon).filter(p=>p.active&&!p.fainted).sort((a,b)=>a.slot.localeCompare(b.slot));
  const expected=(fn:(set:PokemonSet)=>number,species?:string)=>candidates.reduce((sum,c)=>{
    const sets=c.team.pokemon.filter(set=>!species||base(set.species)===base(species));
    return sum+c.weight/weight*mean(sets.map(fn));
  },0);
  const cache=new Map<string,number>();
  const active=view.request.side.pokemon.filter(p=>p.active);
  const incoming=(set:PokemonSet,defenderState?:PokemonBattleState)=>mean((foeStates.length?foeStates:[undefined]).map(foe=>expected(enemy=>Math.max(0,...enemy.moves.filter(isDamagingMove).map(move=>pressure(enemy,set,move,state,foe,defenderState))),foe?.species)));
  const individual=(slot:number,command:string,partnerCommand:string|undefined):number=>{
    const key=`${slot}|${command}${/move \d+ -/.test(command)?`|${partnerCommand??''}`:''}`;if(cache.has(key))return cache.get(key)!;
    const actor=active[slot]??view.request.side.pokemon[slot];if(!actor)return 0;
    const actorState=Object.values(state.sides[view.side].pokemon).find(p=>p.active&&p.slot===`${view.side}${slot?'b':'a'}`);
    const set=ownSet(view,actor);
    let score=0;
    if(command.startsWith('switch ')) {
      const replacement=view.request.side.pokemon[Number(command.split(' ')[1])-1];
      if(replacement){const alternative=ownSet(view,replacement);score=style==='damage'?-20:-8+(incoming(set,actorState)-incoming(alternative))*0.45;}
    } else if(command.startsWith('move ')) {
      const match=/^move (\d+)(?: (-?\d+))?(?: (mega[xy]?))?$/.exec(command);
      const selected=match?view.request.active?.[slot]?.moves[Number(match[1])-1]:undefined;
      if(selected) {
        const move=gen.moves.get(toID(selected.id));const name=move?.name??selected.move;
        const target=Number(match?.[2]??0);
        const mega=Boolean(match?.[3]);
        if(target<0&&isPartnerHealing(name)) {
          const replacement=-target-1!==slot?/^switch (\d+)$/.exec(partnerCommand??''):null;
          const recipient=view.request.side.pokemon[replacement?Number(replacement[1])-1:-target-1];
          const hp=recipient?.condition.match(/^(\d+)\/(\d+)/);
          const hpPercent=hp?Number(hp[1])/Number(hp[2])*100:100;
          score=style==='tactical'?Math.min(50,100-hpPercent):0;
        } else if(isDamagingMove(name)) {
          if(target<0) {
            const ally=active[-target-1];score=ally?-pressure(set,ownSet(view,ally),name,state,actorState)*1.4:0;
          } else {
            const targets=isSpreadMove(name)?foeStates:foeStates.filter(foe=>foe.slot.endsWith(target===2?'b':'a'));
            score=(targets.length?targets:[undefined]).reduce((sum,foe)=>sum+expected(enemy=>pressure(set,enemy,name,state,actorState,foe,mega),foe?.species),0);
            if(move?.target==='allAdjacent') {const ally=active[1-slot];if(ally)score-=pressure(set,ownSet(view,ally),name,state,actorState)*0.7;}
            if(name==='Fake Out') {
              const lastSwitch=view.observations.findLastIndex(line=>/^\|(?:switch|drag)\|/.test(line)&&line.includes(`${view.side}${slot?'b':'a'}:`));
              const acted=view.observations.slice(lastSwitch+1).some(line=>line.startsWith(`|move|${view.side}${slot?'b':'a'}:`)||line.startsWith(`|cant|${view.side}${slot?'b':'a'}:`));
              score=acted?-30:score+(style==='tactical'?24:0);
            }
          }
        } else if(style==='tactical') {
          const danger=incoming(set,actorState);const hp=actorState?.hpPercent??100;
          if(['Protect','Detect','Spiky Shield','Baneful Bunker'].includes(name)) score=4+Math.min(35,danger*0.28)+(hp<40?8:0);
          else if(['Tailwind','Trick Room','Icy Wind','Electroweb'].includes(name)) score=state.field.trickRoomTurns&&name==='Trick Room'?-10:24;
          else if(['Follow Me','Rage Powder','Helping Hand','Wide Guard'].includes(name)) score=22;
          else if(['Swords Dance','Nasty Plot','Dragon Dance','Calm Mind','Quiver Dance','Bulk Up'].includes(name)) score=18-Math.min(20,danger*0.15);
          else if(['Recover','Roost','Slack Off','Synthesis','Moonlight','Shore Up'].includes(name)) score=Math.max(-10,70-hp);
          else if(['Taunt','Encore','Will-O-Wisp','Thunder Wave','Spore','Sleep Powder'].includes(name)) score=16;
          else score=2;
        }
        if(mega)score+=3;
      }
    }
    cache.set(key,score);return score;
  };
  const previewScores=view.request.teamPreview?view.ownTeam.pokemon.map(set=>{
    const offense=expected(enemy=>Math.max(0,...set.moves.filter(isDamagingMove).map(move=>pressure(set,enemy,move))));
    return offense-incoming(set)*0.25+(style==='tactical'&&set.moves.some(move=>['Tailwind','Trick Room','Fake Out'].includes(move))?8:0);
  }):[];
  const scores=view.legalCommands.map(command=>{
    const choices=command.split(',').map(choice=>choice.trim());
    const score=command.startsWith('team ')?[...command.slice(5)].reduce((sum,char,index)=>sum+(previewScores[Number(char)-1]??0)*(index<2?0.6:0.25),0)
      :choices.reduce((sum,choice,slot)=>sum+individual(slot,choice,choices[1-slot]),0);
    return {command,score,probability:0,reasons:[view.request.teamPreview?'Preview plan scored against actor beliefs.':'Both partner choices scored against actor beliefs; engine resolves interactions.',`Policy: ${style}; conditional tactical scores are not win probabilities.`]};
  });
  return scores.sort((a,b)=>b.score-a.score||a.command.localeCompare(b.command));
}

function supportedScores(view:PlayerView,belief:TeamBelief,style:PolicyStyle):ActionProbability[] {
  const state=publicBattleState(view);
  return scoreActions(view,belief,style).filter(action=>Number.isFinite(action.score)&&!unsupportedAction(view,state,action.command));
}

function normalizedActions(scores:ActionProbability[],style:PolicyStyle,reason:string):ActionProbability[] {
  if(!scores.length)return [];
  const best=Math.max(...scores.map(entry=>entry.score));
  const soft=scores.map(entry=>Math.exp((entry.score-best)/(style==='damage'?12:18)));
  const total=soft.reduce((sum,n)=>sum+n,0);
  return scores.map((entry,index)=>({...entry,probability:soft[index]!/total,reasons:[...entry.reasons,reason]}));
}

/** Fast sampling is restricted to a score band within the top fraction, including ties. */
export function actionDistribution(view:PlayerView,belief:TeamBelief,style:PolicyStyle='tactical',options:ActionSelectionOptions={}):ActionProbability[] {
  const fraction=options.topFraction??0.1,gap=options.maxScoreGap??(style==='damage'?12:18);
  if(!Number.isFinite(fraction)||fraction<=0||fraction>1)throw new Error('topFraction must be greater than zero and at most one');
  if(!Number.isFinite(gap)||gap<0)throw new Error('maxScoreGap must be finite and nonnegative');
  const scores=supportedScores(view,belief,style);
  if(!scores.length)return [];
  const cutoff=Math.max(scores[Math.ceil(scores.length*fraction)-1]!.score,scores[0]!.score-gap);
  const retained=scores.filter(action=>action.score>=cutoff);
  return normalizedActions(retained,style,`Sampled only from ${retained.length}/${scores.length} supported plans; top ${fraction*100}% including ties, maximum score gap ${gap}; no uniform exploration floor.`);
}

/** Planning can inspect low-damage defensive plans without making them random baseline plays. */
export function planningActions(view:PlayerView,belief:TeamBelief,limit=8):ActionProbability[] {
  if(!Number.isInteger(limit)||limit<1||limit>4096)throw new Error('Planning limit must be 1–4096');
  const scores=supportedScores(view,belief,'tactical');
  if(!scores.length)return [];
  const selected=[scores[0]!];
  const families=new Map(scores.map(action=>[action.command,planningFamilies(view,action.command)]));
  const wanted=['protect','speed','support','switch','setup'].flatMap(family=>[`${family}:0`,`${family}:1`]);
  for(const family of wanted) {
    if(selected.length>=limit)break;
    if(selected.some(action=>families.get(action.command)!.includes(family)))continue;
    const representative=scores.find(action=>families.get(action.command)!.includes(family));
    if(representative)selected.push(representative);
  }
  for(const action of scores) {
    if(selected.length>=limit)break;
    if(!selected.includes(action))selected.push(action);
  }
  // Preserve diversity order for bounded search, with actual normalized prior weights.
  return normalizedActions(selected,'tactical',`Diverse planning pool: ${selected.length}/${scores.length} supported plans; defensive families retained before the size cap.`);
}
