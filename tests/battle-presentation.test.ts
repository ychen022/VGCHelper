import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';
import {HumanBattleEngine,type BattleView} from '../src/battle/engine.js';
import {battleDownloadFilename} from '../src/battle/http.js';

type DisplayView=Pick<BattleView,'observations'|'ownTeam'|'opponentSheet'>;
const display=runInNewContext(readFileSync('src/battle/web/presentation.js','utf8')+'\nBattleDisplay;') as {
  hpText:(condition:string,opponent:boolean)=>string;
  conditions:(view:DisplayView)=>{field:string[];p1:string[];p2:string[]};
  rosters:(view:DisplayView&Partial<Pick<BattleView,'turn'|'request'>>)=>Record<'p1'|'p2',Array<{species:string;form:string;state:string;condition:string|null;active:boolean}>>;
  moveOutcome:(line:string)=>[string,string,string]|null;
  fieldEvent:(line:string)=>[string,string,string]|null;
};
const fromLog=(observations:string[]):DisplayView=>({observations,ownTeam:[],opponentSheet:[]});
describe('local battle presentation',()=>{
  it('attributes terrain to the correct side when both leads are Rillaboom, in engine activation order',()=>{
    const sample=readFileSync('examples/sample-team.txt','utf8').replace(/\r\n/g,'\n');
    const team=(fast:boolean)=>sample.replace(/^Garchomp[\s\S]*?(?=\n\n)/,`Rillaboom @ Miracle Seed\nAbility: Grassy Surge\nEVs: ${fast?'32 Atk / 32 Spe / 2 HP':'32 HP / 32 Atk / 2 SpD'}\n${fast?'Jolly':'Adamant'} Nature\n- Fake Out\n- Grassy Glide\n- Wood Hammer\n- U-turn`);
    for(const userFast of [true,false]){
      const e=HumanBattleEngine.create(team(userFast),team(!userFast),'closed');
      e.choose('p1','team 1234');e.choose('p2','team 1234');e.resolve();
      const messages=e.view('p1','closed').observations.map(line=>display.fieldEvent(line)?.[1]).filter(Boolean);
      // Showdown emits the successful setter only when the other ability would set the same terrain.
      expect(messages).toEqual([`${userFast?'Your':'Opposing'} Rillaboom's Grassy Surge started Grassy Terrain!`]);
    }
  });
  it('labels ability weather setters without conflating upkeep, move starts or field endings',()=>{
    const log=['|-weather|RainDance|[from] ability: Drizzle|[of] p2a: Pelipper',
      '|-weather|SunnyDay|[of] p1b: Torkoal|[from] ability: Drought','|-weather|SunnyDay|[upkeep]'];
    expect(log.map(line=>display.fieldEvent(line)?.[1])).toEqual([
      "Opposing Pelipper's Drizzle started Rain!","Your Torkoal's Drought started Sun!",'Sun continues.',
    ]);
    expect(display.fieldEvent('|-fieldstart|move: Grassy Terrain')?.[1]).toBe('Grassy Terrain began.');
    expect(display.fieldEvent('|-fieldend|move: Grassy Terrain')?.[1]).toBe('Grassy Terrain ended.');
    expect(display.fieldEvent('|-weather|SunnyDay')?.[1]).toBe('Sun began.');
    expect(display.fieldEvent('|-weather|none')?.[1]).toBe('The weather cleared.');
    expect(display.fieldEvent('|-fieldstart|move: Electric Terrain|[from] ability: Electric Surge')?.[1]).toBe('Electric Surge started Electric Terrain!');
  });
  it('keeps unseen opponents unconfirmed while showing the human’s selected reserves',()=>{
    const paste=readFileSync('examples/sample-team.txt','utf8'),e=HumanBattleEngine.create(paste,paste,'closed');
    const before=display.rosters(e.view('p1','closed'));
    expect(before.p2).toHaveLength(6);expect(before.p2.every(mon=>mon.state==='unknown'&&mon.condition===null)).toBe(true);
    e.choose('p1','team 6123');e.choose('p2','team 1256');e.resolve();
    const view=e.view('p1','closed'),rosters=display.rosters(view);
    expect(rosters.p1.map(mon=>mon.state)).toEqual(['alive','alive','alive','not-selected','not-selected','alive']);
    expect(rosters.p1.filter(mon=>mon.active).map(mon=>mon.species)).toEqual(['Garchomp','Dragonite']);
    expect(rosters.p2.map(mon=>mon.state)).toEqual(['alive','alive','unknown','unknown','unknown','unknown']);
    expect(rosters.p2.filter(mon=>mon.state==='unknown').every(mon=>mon.condition===null)).toBe(true);
    expect(display.rosters(HumanBattleEngine.restore(e.snapshot()).view('p1','closed'))).toEqual(rosters);
    const alternative=HumanBattleEngine.create(paste,paste,'closed');alternative.choose('p1','team 6123');alternative.choose('p2','team 1234');alternative.resolve();
    expect(display.rosters(alternative.view('p1','closed')).p2).toEqual(rosters.p2);
  });
  it('tracks bench HP, status, fainting, swaps and Mega forms without duplicating roster entries',()=>{
    const view={...fromLog([
      '|switch|p2a: Dragonite|Dragonite, L50|100/100','|switch|p2b: Garchomp|Garchomp, L50|100/100',
      '|-damage|p2a: Dragonite|52/100','|-status|p2a: Dragonite|brn','|detailschange|p2a: Dragonite|Dragonite-Mega, L50',
      '|swap|p2a: Dragonite|1','|-damage|p2b: Dragonite|32/100 brn',
      '|switch|p2b: Whimsicott|Whimsicott, L50|100/100','|-sethp|p2a: Garchomp|40/100|p2b: Whimsicott|20/100',
      '|faint|p2b: Whimsicott',
    ]),opponentSheet:['Dragonite','Garchomp','Whimsicott','Kingambit'].map(species=>({species}))};
    const mons=display.rosters(view).p2;
    expect(mons).toHaveLength(4);
    expect(mons[0]).toMatchObject({species:'Dragonite',form:'Dragonite-Mega',condition:'32/100 brn',active:false,state:'alive'});
    expect(mons[1]).toMatchObject({condition:'40/100',active:true});
    expect(mons[2]).toMatchObject({condition:'0 fnt',active:false,state:'fainted'});
    expect(mons[3]).toMatchObject({condition:null,state:'unknown'});
    expect(display.rosters({...view,observations:[]}).p2.every(mon=>mon.state==='unknown')).toBe(true);
  });
  it('undoes an Illusion disguise when the real entrant is revealed without an HP field',()=>{
    const view={...fromLog(['|switch|p2a: Garchomp|Garchomp, L50|100/100','|-damage|p2a: Garchomp|67/100','|replace|p2a: Zoroark|Zoroark, L50']),opponentSheet:[{species:'Garchomp'},{species:'Zoroark'}]};
    expect(display.rosters(view).p2).toEqual([
      {species:'Garchomp',form:'Garchomp',state:'unknown',condition:null,active:false},
      {species:'Zoroark',form:'Zoroark',state:'alive',condition:'67/100',active:true},
    ]);
  });
  it('distinguishes failed Protect from successful protection and a blocked attack',()=>{
    expect(display.moveOutcome('|-fail|p1a: Archaludon')).toEqual(['p',"Archaludon's move failed!",'failed']);
    expect(display.moveOutcome('|-fail|p1a: Archaludon|move: Protect')?.[1]).toBe("Archaludon's Protect failed!");
    expect(display.moveOutcome('|-singleturn|p1a: Archaludon|Protect')?.[1]).toBe('Archaludon protected itself with Protect!');
    expect(display.moveOutcome('|-activate|p2a: Archaludon|move: Protect')?.[1]).toBe('Opposing Archaludon blocked the attack with Protect!');
    expect(display.moveOutcome('|cant|p1a: Archaludon|flinch')?.[1]).toContain('flinched');
    expect(display.moveOutcome('|-notarget')?.[1]).toBe('But there was no target!');
    expect(display.moveOutcome('|-fail|p1a: Archaludon|heal')?.[1]).toContain('HP is already full');
    expect(display.moveOutcome('|move|p1a: Archaludon|Protect|p1a: Archaludon|[still]')).toBeNull();
  });
  it('labels public opponent HP as percentages while retaining exact own HP and statuses',()=>{
    expect(display.hpText('73/100 par',true)).toBe('73% par');
    expect(display.hpText('100/100',true)).toBe('100%');
    expect(display.hpText('0 fnt',true)).toBe('0% fnt');
    expect(display.hpText('132/183 brn',false)).toBe('132/183 brn');
  });
  it('tracks side conditions independently using actual Showdown end-of-round messages',()=>{
    const paste=readFileSync('examples/sample-team.txt','utf8');
    const engine=HumanBattleEngine.create(paste,paste,'closed');
    engine.choose('p1','team 1234');engine.choose('p2','team 1234');engine.resolve();
    for(let turn=1;turn<=4;turn++){
      engine.choose('p1',turn===1?'move 4, move 2':'move 4, move 4');
      engine.choose('p2',turn===2?'move 4, move 2':'move 4, move 4');engine.resolve();
      const effects=display.conditions(engine.view('p1','closed'));
      expect(effects.p1).toEqual(turn===4?[]:[`Tailwind (${4-turn}/4 turns)`]);
      expect(effects.p2).toEqual(turn<2?[]:[`Tailwind (${5-turn}/4 turns)`]);
      expect(effects.field).toEqual([]);
      expect(display.conditions(HumanBattleEngine.restore(engine.snapshot()).view('p1','closed'))).toEqual(effects);
    }
  });
  it('does not spend a turn on preview weather or mid-turn replacements, or reset weather on upkeep',()=>{
    const log=['|-weather|RainDance|[from] ability: Drizzle|[of] p2a: Pelipper','|turn|1'];
    expect(display.conditions(fromLog(log)).field).toEqual(['Rain (5–8/5–8 turns)']);
    log.push('|-weather|RainDance|[upkeep]','|upkeep','|switch|p1a: Garchomp|Garchomp, L50|183/183','|turn|2');
    expect(display.conditions(fromLog(log)).field).toEqual(['Rain (4–7/5–8 turns)']);
    log.push('|-weather|Snowscape');
    expect(display.conditions(fromLog(log)).field).toEqual(['Snow (5–8/5–8 turns)']);
    log.push('|-weather|none');expect(display.conditions(fromLog(log)).field).toEqual([]);
  });
  it('uses permitted held items for screen durations and narrows a hidden range only from evidence',()=>{
    const observations=['|switch|p2a: Whimsicott|Whimsicott, L50|100/100','|move|p2a: Whimsicott|Light Screen|p2a: Whimsicott','|-sidestart|p2: Agent|move: Light Screen','|upkeep'];
    const hidden=fromLog(observations);
    expect(display.conditions(hidden).p2).toEqual(['Light Screen (4–7/5–8 turns)']);
    const open=(item:string):DisplayView=>({...hidden,opponentSheet:[{species:'Whimsicott',item,ability:'Prankster',nature:'Timid',moves:['Light Screen']}]});
    expect(display.conditions(open('Light Clay')).p2).toEqual(['Light Screen (7/8 turns)']);
    expect(display.conditions(open('Focus Sash')).p2).toEqual(['Light Screen (4/5 turns)']);
    const withoutItem=[...observations];withoutItem.splice(1,0,'|-enditem|p2a: Whimsicott|Light Clay');
    expect(display.conditions({...open('Light Clay'),observations:withoutItem}).p2).toEqual(['Light Screen (4/5 turns)']);
    observations.push('|upkeep','|upkeep','|upkeep','|upkeep');
    expect(display.conditions(hidden).p2).toEqual(['Light Screen (3/8 turns)']);
  });
  it('keeps shared conditions separate, swaps side effects, and clears expired or removed conditions',()=>{
    const log=['|-sidestart|p1: You|move: Tailwind','|-sidestart|p2: Agent|Stealth Rock','|-fieldstart|move: Trick Room',
      '|-fieldstart|move: Psychic Terrain','|-singleturn|p1a: Garchomp|Wide Guard','|-swapsideconditions','|upkeep'];
    expect(display.conditions(fromLog(log))).toEqual({field:['Trick Room (4/5 turns)','Psychic Terrain (4–7/5–8 turns)'],p1:['Stealth Rock (∞/∞ turns)'],p2:['Tailwind (3/4 turns)']});
    log.push('|-fieldend|move: Trick Room','|-fieldend|move: Psychic Terrain','|-sideend|p1: You|Stealth Rock','|-sideend|p2: Agent|move: Tailwind');
    expect(display.conditions(fromLog(log))).toEqual({field:[],p1:[],p2:[]});
    expect(display.conditions(fromLog([]))).toEqual({field:[],p1:[],p2:[]});
  });
  it('names both downloads using the Showdown format name and local timestamp',()=>{
    const date=new Date(2026,8,4,3,5,7),format='[Gen 9 Champions] VGC 2026 Reg M-C';
    expect(battleDownloadFilename(format,'html',date)).toBe('Gen9ChampionsVGC2026RegMC-sim-2026-09-04-03-05-07.html');
    expect(battleDownloadFilename(format,'log',date)).toBe('Gen9ChampionsVGC2026RegMC-sim-2026-09-04-03-05-07.log');
    expect(battleDownloadFilename('[Gen 9] OU','html',date)).toBe('Gen9OU-sim-2026-09-04-03-05-07.html');
  });
});
