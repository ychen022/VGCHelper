import type {BattleState} from '../domain/contracts.js';
import type {PlayerView} from './engine.js';
import {isDamagingMove} from '../calc/champions.js';

const protect=new Set(['protect','detect','spikyshield','banefulbunker','kingsshield','silktrap','burningbulwark','obstruct']);
const speed=new Set(['tailwind','trickroom','icywind','electroweb']);
const support=new Set(['helpinghand','followme','ragepowder','wideguard','quickguard']);
const setup=new Set(['swordsdance','nastyplot','dragondance','calmmind','quiverdance','bulkup']);
const id=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]/g,'');
export const isPartnerHealing=(name:string)=>['healpulse','floralhealing','pollenpuff'].includes(id(name));

function moveChoice(view:PlayerView,slot:number,command:string) {
  const match=/^move (\d+)(?: (-?\d+))?(?: mega[xy]?)?$/.exec(command);
  const move=match?view.request.active?.[slot]?.moves[Number(match[1])-1]:undefined;
  return move?{move,target:Number(match?.[2]??0)}:undefined;
}

/** Engine legality and policy support are distinct. No opposing private state is accepted. */
export function unsupportedAction(view:PlayerView,state:BattleState,command:string):string|undefined {
  if(command.startsWith('team '))return undefined;
  const parts=command.split(',').map(part=>part.trim());
  const opponent=view.side==='p1'?'p2':'p1';
  const foes=Object.values(state.sides[opponent].pokemon);
  for(const [slot,part] of parts.entries()) {
    if(!part.startsWith('move '))continue;
    const selected=moveChoice(view,slot,part);
    if(!selected)return 'Move is absent from the current request.';
    const {move,target}=selected;
    if(target<0) {
      const allySlot=-target-1;
      const replacement=/^switch (\d+)$/.exec(parts[allySlot]??'');
      const ally=view.request.side.pokemon[replacement?Number(replacement[1])-1:allySlot];
      if(!ally||ally.condition.endsWith(' fnt'))return 'The allied target will not be alive in that slot.';
      // Intentional ally damage needs an evaluated benefit. The fast policy does
      // not model those combinations; an engine-legal command is not evidence of one.
      if(!isPartnerHealing(move.id)&&(isDamagingMove(move.move)||!['adjacentAlly','adjacentAllyOrSelf'].includes(move.target??''))) {
        return 'Intentional friendly damage or hostile status has no modeled benefit in this policy.';
      }
      if(id(move.id)==='helpinghand') {
        const partner=moveChoice(view,allySlot,parts[allySlot]??'');
        if(!partner||!isDamagingMove(partner.move.move)||(partner.target<0&&isPartnerHealing(partner.move.id)))return 'Helping Hand has no partner attack to support.';
      }
    }
    if(target>0&&isPartnerHealing(move.id)&&id(move.id)!=='pollenpuff')return 'Healing an opponent has no modeled benefit in this policy.';
    if(target>0&&foes.length&&!foes.some(foe=>foe.active&&!foe.fainted&&foe.slot===`${opponent}${target===2?'b':'a'}`)) {
      return 'Use the living opposing slot instead of a redundant empty-slot target.';
    }
    if(id(move.id)==='fakeout') {
      const actor=`${view.side}${slot?'b':'a'}:`;
      const entered=view.observations.findLastIndex(line=>/^\|(?:switch|drag)\|/.test(line)&&line.includes(actor));
      if(view.observations.slice(entered+1).some(line=>line.startsWith(`|move|${actor}`)||line.startsWith(`|cant|${actor}`))) {
        return 'Fake Out is no longer available on this stay.';
      }
    }
  }
  return undefined;
}

/** Families preserve different strategic purposes before a planner's size cap. */
export function planningFamilies(view:PlayerView,command:string):string[] {
  if(command.startsWith('team '))return [];
  return command.split(',').flatMap((part,slot)=>{
    if(part.trim().startsWith('switch '))return [`switch:${slot}`];
    const selected=moveChoice(view,slot,part.trim());
    if(!selected)return [];
    const name=id(selected.move.id);
    const family=protect.has(name)?'protect':speed.has(name)?'speed':support.has(name)||(selected.target<0&&isPartnerHealing(name))?'support':setup.has(name)?'setup':undefined;
    return family?[`${family}:${slot}`]:[];
  });
}
