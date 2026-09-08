import type {PlayerView} from './engine.js';
import {
  contextualActionWeights,
  isActionPriorAdoptable,
  type ContextualActionPriorArtifact,
  type PublicActionFeatures,
} from './learning.js';
import {publicBattleState, type ActionProbability} from './policy.js';

interface MoveComponent {
  slot:number;
  key:string;
  context:Pick<PublicActionFeatures,'species'|'turn'|'publicBoard'>;
}

function choiceShape(command:string):string {
  if(command.startsWith('team '))return 'preview';
  return command.split(',').map(choice=>choice.trim().split(' ')[0]??'unknown').join(',');
}

function moveComponents(view:PlayerView,command:string):MoveComponent[] {
  if(command.startsWith('team '))return [];
  const state=publicBattleState(view);
  const active=view.request.side.pokemon.filter(pokemon=>pokemon.active);
  const publicActive=Object.values(state.sides).flatMap(side=>Object.values(side.pokemon)).filter(pokemon=>pokemon.active&&!pokemon.fainted);
  const components:MoveComponent[]=[];
  for(const [slot,raw] of command.split(',').entries()) {
    const match=/^move (\d+)(?: (-?\d+))?/.exec(raw.trim());
    if(!match)continue;
    const moveIndex=Number(match[1])-1;
    const move=view.request.active?.[slot]?.moves[moveIndex];
    const actor=active[slot];
    if(!move||!actor)continue;
    const actorSlot=`${view.side}${slot===0?'a':'b'}`;
    const species=actor.details.split(',')[0]?.trim()||'Unknown';
    const publicBoard=publicActive.filter(pokemon=>pokemon.slot!==actorSlot).map(pokemon=>pokemon.species??pokemon.nickname).filter(Boolean).sort();
    const target=match[2]??'none';
    components.push({slot,key:`move:${move.move}:${target}`,context:{species,turn:view.turn,publicBoard}});
  }
  return components;
}

/**
 * Blend a validated human-action prior into an existing view-only distribution.
 * Switch and preview mass is preserved; rejected artifacts are an exact no-op.
 */
export function mixLearnedActionPrior(
  view:PlayerView,
  distribution:ActionProbability[],
  artifact?:ContextualActionPriorArtifact,
  weight=0.15,
):ActionProbability[] {
  if(!artifact||!isActionPriorAdoptable(artifact)||weight===0||!distribution.length)return distribution;
  if(!Number.isFinite(weight)||weight<0||weight>1)throw new RangeError('Learned action-prior weight must be between zero and one');
  const parsed=distribution.map(action=>({action,shape:choiceShape(action.command),components:moveComponents(view,action.command)}));
  const legalBySlot=new Map<number,Map<string,MoveComponent>>();
  for(const entry of parsed)for(const component of entry.components) {
    const choices=legalBySlot.get(component.slot)??new Map<string,MoveComponent>();
    choices.set(component.key,component);legalBySlot.set(component.slot,choices);
  }
  const weightsBySlot=new Map<number,Record<string,number>>();
  for(const [slot,choices] of legalBySlot) {
    const first=choices.values().next().value as MoveComponent|undefined;
    if(first)weightsBySlot.set(slot,contextualActionWeights(artifact,first.context,[...choices.keys()]));
  }
  const learnedFactor=(entry:(typeof parsed)[number])=>entry.components.reduce((factor,component)=>
    factor*(weightsBySlot.get(component.slot)?.[component.key]??1),1);
  const adjusted=new Map<ActionProbability,number>();
  for(const shape of new Set(parsed.map(entry=>entry.shape))) {
    const group=parsed.filter(entry=>entry.shape===shape);
    const groupMass=group.reduce((sum,entry)=>sum+entry.action.probability,0);
    if(!group.some(entry=>entry.components.length)) {
      for(const entry of group)adjusted.set(entry.action,entry.action.probability);
      continue;
    }
    const denominator=group.reduce((sum,entry)=>sum+entry.action.probability*learnedFactor(entry),0);
    for(const entry of group)adjusted.set(entry.action,denominator>0
      ? groupMass*entry.action.probability*learnedFactor(entry)/denominator
      : entry.action.probability);
  }
  const mixed=distribution.map(action=>({...action,probability:(1-weight)*action.probability+weight*(adjusted.get(action)??action.probability)}));
  const total=mixed.reduce((sum,action)=>sum+action.probability,0);
  return total>0?mixed.map(action=>({...action,probability:action.probability/total})):distribution;
}
