import {createRequire} from 'node:module';
import {STAT_IDS, type PokemonTeam, type PokemonSet} from '../domain/contracts.js';

// The exact upstream source is built by postinstall. Keep its mutable internal types
// behind this module; no engine object is ever exposed to a policy.
const require = createRequire(import.meta.url);
const {Battle, Dex, TeamValidator, PRNG} = require('pokemon-showdown');
const {extractChannelMessages} = require('pokemon-showdown/dist/sim/battle.js');
export const ENGINE_PROFILE = Object.freeze({
  revision:'b1156ff19204e48089e2384eb2c9c1a8004f57ce',
  format:'gen9championsvgc2026regmc', mod:'champions', generation:9,
  calculatorGeneration:0, version:'showdown-champions-mc-v1',
});
export type PlayerSide = 'p1'|'p2';
export type InformationMode = 'closed'|'open_sheet'|'replay_observed';
export type EngineSeed = [number,number,number,number];
export interface RequestPokemon {
  ident:string; details:string; condition:string; active:boolean;
  stats:Record<string,number>; moves:string[]; baseAbility:string; item:string; ability?:string;
}
export interface RequestMove {move:string;id:string;pp?:number;maxpp?:number;target?:string;disabled?:boolean|string}
export interface ChoiceRequest {
  wait?:boolean;teamPreview?:boolean;maxChosenTeamSize?:number;forceSwitch?:boolean[];
  side:{name:string;id:PlayerSide;pokemon:RequestPokemon[]};
  active?:Array<{moves:RequestMove[];trapped?:boolean;maybeTrapped?:boolean;canMegaEvo?:boolean;canMegaEvoX?:boolean;canMegaEvoY?:boolean}>;
}
export interface PlayerView {
  side:PlayerSide; turn:number; ownTeam:PokemonTeam; request:ChoiceRequest;
  observations:string[]; legalCommands:string[]; ended:boolean; winner?:PlayerSide|'draw';
  informationMode:InformationMode;
}
export interface EngineOptions {teams:Record<PlayerSide,PokemonTeam>;seed:EngineSeed;informationMode?:InformationMode}
/** Privileged worker-only checkpoint. Never pass this object to a player policy. */
export interface EngineCheckpoint {version:1;engineRevision:string;options:EngineOptions;state:Record<string,unknown>;reconstruction?:{kind:'public-prefix-sampled';decisionTurn:number;publicPrefixHash:string;conditioningAttempts:number;warnings:string[]}}
const copy = <T>(value:T):T => JSON.parse(JSON.stringify(value)) as T;
const dex = Dex.mod('champions');
export interface MoveMetadata {accuracy:number|true;priority:number;target:string;category:string;type:string;basePower:number}
export function moveMetadata(name:string):Readonly<MoveMetadata> {
  const move=dex.moves.get(name);
  if(!move.exists)throw new Error(`Unknown move: ${name}`);
  return Object.freeze({accuracy:move.accuracy,priority:move.priority,target:move.target,category:move.category,type:move.type,basePower:move.basePower});
}
export class EngineChoiceError extends Error {
  constructor(readonly side:PlayerSide,readonly retryable:boolean,message:string) {
    super(message);this.name='EngineChoiceError';
  }
}
function canonicalSet(set:PokemonSet) {
  let species = dex.species.get(set.species);
  if (species.id === 'aegislashblade') species=dex.species.get('Aegislash');
  if (!species.exists) throw new Error(`Unknown Champions species: ${set.species}`);
  return {
    name:set.nickname || species.name, species:species.name,
    item:set.item ? dex.items.get(set.item).name : '', ability:set.ability ? dex.abilities.get(set.ability).name : species.abilities['0'],
    nature:set.nature || 'Hardy', moves:set.moves.map(move=>dex.moves.get(move).name),
    evs:Object.fromEntries(STAT_IDS.map(stat=>[stat,set.skillPoints[stat] ?? 0])),
    ivs:Object.fromEntries(STAT_IDS.map(stat=>[stat,set.ivs[stat] ?? 31])),
    level:set.level, ...(set.gender ? {gender:set.gender} : {}), shiny:set.shiny ?? false,
  };
}
export function validateEngineTeam(team:PokemonTeam): string[] {
  try { return new TeamValidator(ENGINE_PROFILE.format).validateTeam(team.pokemon.map(canonicalSet)) || []; }
  catch(error) { return [error instanceof Error ? error.message : String(error)]; }
}
/** Public-data synthetic baseline, not an empirical joint-set prior. */
export function completePreviewTeam(preview:string[]):PokemonTeam {
  const team:PokemonTeam={pokemon:preview.map(name=> {
    const species=dex.species.get(name);
    if (!species.exists) throw new Error(`Unknown Champions species: ${name}`);
    const learnset=dex.species.getLearnsetData(species.id).learnset;
    if (!learnset) throw new Error(`No Champions learnset for ${name}`);
    const physical=species.baseStats.atk>=species.baseStats.spa;
    const moves=Object.keys(learnset).map(id=>dex.moves.get(id)).filter(move=>move.exists && !move.isNonstandard && move.basePower>0 && !move.selfdestruct && !move.ohko && !move.selfSwitch && !move.self?.volatileStatus && !['recharge','lockedmove'].includes(move.self?.volatileStatus || ''));
    const score=(move:any) => (species.types.includes(move.type)?1.5:1)*(move.category===(physical?'Physical':'Special')?1:0.6)*Math.min(move.basePower,100)*(typeof move.accuracy==='number'?move.accuracy/100:1);
    moves.sort((a,b)=>score(b)-score(a) || a.id.localeCompare(b.id));
    const chosen=moves.slice(0,3).map(move=>move.name);
    if (learnset.protect) chosen.push('Protect');
    if (!chosen.length) throw new Error(`No supported moves for ${name}`);
    return {species:species.name,ability:species.abilities['0'],nature:physical?'Adamant':'Modest',moves:chosen,skillPoints:physical?{atk:32,spe:32,hp:2}:{spa:32,spe:32,hp:2},ivs:{},level:50};
  })};
  const errors=validateEngineTeam(team); if(errors.length) throw new Error(errors.join('; '));
  return team;
}
function permutations(values:number[],count:number):string[] {
  if(!count)return [''];
  return values.flatMap(value=>permutations(values.filter(v=>v!==value),count-1).map(tail=>`${value}${tail}`));
}
/** Enumerate the actor's permitted commands solely from its own request.
 * Hidden trapping/disabling discoveries are handled by the engine on submission.
 */
export function enumerateLegalCommands(request:ChoiceRequest):string[] {
  if(request.wait) return [];
  if(request.teamPreview) return permutations(request.side.pokemon.map((_,i)=>i+1),request.maxChosenTeamSize || 4).map(order=>`team ${order}`);
  const reserves=request.side.pokemon.map((p,i)=>({p,index:i+1})).filter(({p})=>!p.active && !p.condition.endsWith(' fnt'));
  const slots=request.forceSwitch?.length ?? request.active?.length ?? 0;
  let joint:string[][]=[[]];
  for(let slot=0;slot<slots;slot++) {
    const own=request.side.pokemon[slot];
    const active=request.active?.[slot];
    let choices:string[]=[];
    if(request.forceSwitch) {
      if(!request.forceSwitch[slot]) choices=['pass'];
      else { choices=reserves.map(({index})=>`switch ${index}`); if(reserves.length<request.forceSwitch.filter(Boolean).length) choices.push('pass'); }
    } else if(!own || own.condition.endsWith(' fnt')) choices=['pass'];
    else if(active) {
      for(const [index,move] of active.moves.entries()) {
        if(move.disabled || move.pp===0)continue;
        const targets = ['normal','any','adjacentFoe'].includes(move.target || '') ? [1,2,...(move.target==='adjacentFoe'?[]:[-(2-slot)])] : move.target==='adjacentAlly' ? [-(2-slot)] : move.target==='adjacentAllyOrSelf' ? [-1,-2] : [0];
        const megas=['',...(active.canMegaEvo?[' mega']:[]),...(active.canMegaEvoX?[' megax']:[]),...(active.canMegaEvoY?[' megay']:[])];
        for(const target of targets) for(const mega of megas) choices.push(`move ${index+1}${target?` ${target}`:''}${mega}`);
      }
      if(!active.trapped) choices.push(...reserves.map(({index})=>`switch ${index}`));
    }
    joint=joint.flatMap(prefix=>choices.map(choice=>[...prefix,choice])).filter(parts=>{
      const switches=parts.filter(p=>p.startsWith('switch '));
      return new Set(switches).size===switches.length && parts.filter(p=>/ mega[xy]?$/.test(p)).length<=1;
    });
  }
  if(request.forceSwitch) {
    const count=Math.min(reserves.length,request.forceSwitch.filter(Boolean).length);
    joint=joint.filter(parts=>parts.filter(p=>p.startsWith('switch ')).length===count);
  }
  return joint.map(parts=>parts.join(', '));
}
export class EngineSession {
  #battle:any;
  #options:EngineOptions;
  #reconstruction:EngineCheckpoint['reconstruction'];
  private constructor(options:EngineOptions,battle:any,reconstruction?:EngineCheckpoint['reconstruction']) {this.#options=copy(options);this.#battle=battle;this.#reconstruction=reconstruction?copy(reconstruction):undefined;}
  static create(options:EngineOptions):EngineSession {
    const teams={p1:options.teams.p1.pokemon.map(canonicalSet),p2:options.teams.p2.pokemon.map(canonicalSet)};
    for(const side of ['p1','p2'] as const) {
      const errors=new TeamValidator(ENGINE_PROFILE.format).validateTeam(teams[side]);
      if(errors?.length)throw new Error(`${side}: ${errors.join('; ')}`);
    }
    const battle=new Battle({formatid:ENGINE_PROFILE.format,seed:options.seed,
      p1:{name:'p1',team:teams.p1},p2:{name:'p2',team:teams.p2}});
    if(options.informationMode==='open_sheet')battle.showOpenTeamSheets();
    return new EngineSession(options,battle);
  }
  view(side:PlayerSide):PlayerView {
    const battle=this.#battle;
    const actor=battle.getSide(side);
    const request=copy(actor.activeRequest ?? {wait:true,side:actor.getRequestData()}) as ChoiceRequest;
    const observations=extractChannelMessages(battle.log.join('\n'),[side==='p1'?1:2])[side==='p1'?1:2] as string[];
    return {side,turn:battle.turn,ownTeam:copy(this.#options.teams[side]),request,
      observations:observations.filter(line=>!line.startsWith('|t:|')),legalCommands:battle.ended?[]:enumerateLegalCommands(request),ended:battle.ended,
      informationMode:this.#options.informationMode || 'closed',
      ...(battle.ended?{winner:(battle.winner || 'draw') as PlayerSide|'draw'}:{})};
  }
  step(commands:{p1?:string|undefined;p2?:string|undefined}):void {
    if(this.#battle.ended)throw new Error('Battle has ended');
    // Validate both against the same pre-resolution requests, then commit together.
    for(const side of ['p1','p2'] as const) {
      const view=this.view(side); if(view.request.wait)continue;
      if(!commands[side] || !view.legalCommands.includes(commands[side]!)) throw new Error(`Invalid ${side} command: ${commands[side]}`);
    }
    for(const side of ['p1','p2'] as const) {
      const actor=this.#battle.getSide(side);if(actor.activeRequest.wait)continue;
      const requestBefore=JSON.stringify(actor.activeRequest);
      if(!actor.choose(commands[side]) || !actor.isChoiceDone()) {
        const error=actor.choice.error;for(const other of this.#battle.sides)other.clearChoice();
        throw new EngineChoiceError(side,requestBefore!==JSON.stringify(actor.activeRequest),`Engine rejected ${side}: ${error}`);
      }
    }
    this.#battle.commitChoices();
  }
  /** Worker-only future-outcome resampling; never part of a player view. */
  reseed(seed:EngineSeed):void { this.#battle.prng = new PRNG(seed); }
  snapshot():EngineCheckpoint {return {version:1,engineRevision:ENGINE_PROFILE.revision,options:copy(this.#options),state:copy(this.#battle.toJSON()),...(this.#reconstruction?{reconstruction:copy(this.#reconstruction)}:{})};}
  static restore(checkpoint:EngineCheckpoint):EngineSession {
    if(checkpoint.version!==1 || checkpoint.engineRevision!==ENGINE_PROFILE.revision)throw new Error('Incompatible engine checkpoint');
    return new EngineSession(checkpoint.options,Battle.fromJSON(copy(checkpoint.state)),checkpoint.reconstruction);
  }
}






