import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {enumerateLegalCommands, type ChoiceRequest, type PlayerSide} from '../simulation/engine.js';

// Human battles and simulations use the same pinned Champions engine.
const require = createRequire(import.meta.url);
const {Battle, Teams, TeamValidator, Dex} = require('pokemon-showdown');
const {extractChannelMessages} = require('pokemon-showdown/dist/sim/battle.js');
export const BATTLE_PROFILE = Object.freeze({
  id: 'champions-vgc-2026-m-c', format: 'gen9championsvgc2026regmc',
  name: 'Champions VGC 2026 · Regulation M-C',
  revision: 'b1156ff19204e48089e2384eb2c9c1a8004f57ce',
  validFrom: '2026-09-09T02:00:00Z', validTo: '2026-12-02T02:00:00Z',
  timer: {previewMs: 90_000, turnMs: 45_000, playerMs: 420_000, battleMs: 1_200_000},
  rulesSource: 'https://news.pokemon-home.com/en/page/816.html',
});
export type SheetMode = 'open_sheet' | 'closed';
const clone = <T>(value:T):T => structuredClone(value);
const dex = Dex.mod('champions');

export interface SheetPokemon {species:string; moves:string[]; item:string; ability:string; nature:string}
export interface BattleView {
  side:PlayerSide; turn:number; ended:boolean; winner?:string;
  request:ChoiceRequest; observations:string[]; legalCommands:string[];
  ownTeam:unknown[]; opponentSheet:Array<SheetPokemon | {species:string}>;
  moveInfo:Record<string,{type:string;category:string;power:number;accuracy:number|true;priority:number;description:string}>;
}

/** Only the referee has access to this adapter; no raw state crosses a player boundary. */
export class HumanBattleEngine {
  private constructor(private battle:any,private rosters:any[][]) {}
  resetFrom(next:HumanBattleEngine):void {this.battle=next.battle;this.rosters=next.rosters;}
  static create(userPaste:string, agentPaste:string, mode:SheetMode) {
    const teams = [userPaste, agentPaste].map((paste, i) => {
      const team = Teams.import(paste);
      if (!team || team.length !== 6) throw new Error(`${i ? 'Agent' : 'User'} team must contain six Pokémon.`);
      if (team.some((set:any) => !set.ability || !set.nature || set.moves.length !== 4)) {
        throw new Error(`${i ? 'Agent' : 'User'} paste must specify an ability, nature and four moves for every Pokémon.`);
      }
      // Nicknames can contain arbitrary text and are unnecessary in this format.
      for (const set of team) set.name = dex.species.get(set.species).name;
      const errors = new TeamValidator(BATTLE_PROFILE.format).validateTeam(team);
      if (errors?.length) throw new Error(`${i ? 'Agent' : 'User'} team: ${errors.join('; ')}`);
      return team;
    });
    const random = randomBytes(8);
    const battle = new Battle({formatid:BATTLE_PROFILE.format,
      seed:[0,2,4,6].map(offset => random.readUInt16BE(offset)),
      p1:{name:'You',team:teams[0]},p2:{name:'Agent',team:teams[1]}});
    if (mode === 'open_sheet') battle.showOpenTeamSheets();
    return new HumanBattleEngine(battle,clone(teams));
  }
  static restore(state:Record<string,unknown>) {return new HumanBattleEngine(Battle.fromJSON(clone(state['battle'])),clone(state['rosters']) as any[][]);}
  snapshot():Record<string,unknown> {return {battle:clone(this.battle.toJSON()),rosters:clone(this.rosters)};}
  get ended():boolean {return this.battle.ended;}
  get turn():number {return this.battle.turn;}
  view(side:PlayerSide, mode:SheetMode):BattleView {
    const actor = this.battle.getSide(side);
    const ownTeam=this.rosters[side==='p1'?0:1]!;
    const foeTeam=this.rosters[side==='p1'?1:0]!;
    const request = clone(actor.activeRequest ?? {wait:true,side:actor.getRequestData()}) as ChoiceRequest;
    const channel = side === 'p1' ? 1 : 2;
    const observations = (extractChannelMessages(this.battle.log.join('\n'), [channel])[channel] as string[])
      .filter(line => !/^\|(?:t:|uhtml|uhtmlchange|debug|request)\|/.test(line))
      .map(line => {
        const parts=line.split('|');
        // Closed preview is species-only, including in the raw protocol channel.
        if(mode==='closed' && parts[1]==='poke' && parts[2]!==side) return `|poke|${parts[2]}|${parts[3]!.split(',')[0]}|`;
        return line;
      });
    // Sheet order is the original roster, never the opponent's selected four/order.
    const sheet = foeTeam.map((set:any) => mode === 'closed' ? {species:set.species} : {
      species:set.species, moves:[...set.moves], item:set.item, ability:set.ability, nature:set.nature,
    });
    const moveIds = new Set<string>(ownTeam.flatMap((set:any) => set.moves));
    if(mode === 'open_sheet') for(const set of sheet) for(const move of set.moves ?? []) moveIds.add(move);
    for(const line of observations) if(line.startsWith('|move|')) moveIds.add(line.split('|')[3]!);
    const moveInfo = Object.fromEntries([...moveIds].map(id => {
      const move = dex.moves.get(id);
      return [move.id,{type:move.type,category:move.category,power:move.basePower,accuracy:move.accuracy,
        priority:move.priority,description:dex.loadTextData().Moves[move.id]?.desc || ''}];
    }));
    return {side,turn:this.turn,ended:this.ended,...(this.ended?{winner:this.battle.winner || 'draw'}:{}),
      request,observations,legalCommands:this.ended?[]:enumerateLegalCommands(request),
      ownTeam:clone(ownTeam),opponentSheet:sheet,moveInfo};
  }
  /** Validate without advancing. Persist legitimate hidden trap/disable request updates. */
  choose(side:PlayerSide, command:string):string | undefined {
    const actor = this.battle.getSide(side);
    if (!actor.choose(command) || !actor.isChoiceDone()) {
      const error = actor.choice.error || 'Incomplete choice';
      actor.clearChoice();
      return error;
    }
    return undefined;
  }
  restart(mode:SheetMode):HumanBattleEngine {return HumanBattleEngine.create(Teams.export(this.rosters[0]),Teams.export(this.rosters[1]),mode);}
  automaticChoice(side:PlayerSide):void {
    const actor = this.battle.getSide(side);
    actor.clearChoice();
    actor.autoChoose();
    this.battle.add('message', `${side==='p1'?'Your':'Agent’s'} selection timer expired. A choice was selected automatically.`);
  }
  automaticUserChoice():void {this.automaticChoice('p1');}
  timeout(sides:PlayerSide[]):void {
    this.battle.add('message', 'Player time expired.');
    if(sides.length===2)this.battle.tie();else this.battle.win(sides[0]==='p1'?'p2':'p1');
  }
  resolve():void {this.battle.commitChoices();}
  forfeitUser():void {this.battle.add('message','Your player time expired or you forfeited.');this.battle.win('p2');}
  tiebreak():void {this.battle.tiebreak();}
}
