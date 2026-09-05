import {Field, Generations, Pokemon, toID} from '@smogon/calc';
import type {State} from '@smogon/calc';
import {getFinalSpeed} from '@smogon/calc/dist/mechanics/util.js';
import {calculateChampionsDamage, movePriority} from '../../calc/champions.js';
import type {DamageRequest, PokemonPosition, PokemonSet} from '../../domain/contracts.js';
import {VgcError} from '../../errors.js';

const generation = Generations.get(0);
export interface BattlePokemon extends PokemonSet {
  position: PokemonPosition;
  protectedByArmorTail?: boolean;
  friendGuard?: boolean;
  weather?: string;
}
export interface BattleLeadState {
  user: BattlePokemon[];
  opponent: BattlePokemon[];
  weather?: string;
  notes: string[];
}

export function megaForm(set: PokemonSet): {base: string; mega: string} | undefined {
  const item = set.item ? generation.items.get(toID(set.item)) : undefined;
  for (const [base, mega] of Object.entries(item?.megaStone ?? {})) {
    if ([base,mega].some(s=>toID(s)===toID(set.species)) ||
      (base === 'Floette-Eternal' && set.species === 'Floette-Mega')) return {base,mega};
  }
  return undefined;
}

export function megaChoices(sets: PokemonSet[]): Array<string | null> {
  return [null,...sets.filter(s=>megaForm(s)).map(s=>s.species)];
}

function defaultAbility(species: string): string {
  return new Pokemon(generation,species).ability!;
}

function basePosition(set: PokemonSet): BattlePokemon {
  const form=megaForm(set);
  const species=form?.base ?? (set.species==='Aegislash'?'Aegislash-Shield':set.species);
  const megaAbility=form ? defaultAbility(form.mega) : undefined;
  const ability=set.ability && set.ability!==megaAbility ? set.ability : defaultAbility(species);
  return {...structuredClone(set),position:{species,ability,boosts:{}}};
}

export function battleSpeed(set: BattlePokemon, weather:string|undefined=set.weather): number {
  const pokemon=new Pokemon(generation,set.position.species ?? set.species,{
    level:set.level,nature:set.nature ?? 'Serious',evs:set.skillPoints,ivs:set.ivs,
    ...(set.item?{item:set.item}:{}),...(set.position.ability?{ability:set.position.ability}:{}),
    ...(set.position.boosts?{boosts:set.position.boosts}:{}),
  });
  const field=new Field(weather?{weather:weather as NonNullable<State.Field['weather']>}:{});
  return getFinalSpeed(generation,pokemon,field,field.attackerSide);
}

export function battleMaxHp(set: BattlePokemon): number {
  return new Pokemon(generation,set.position.species ?? set.species,{
    level:set.level,nature:set.nature ?? 'Serious',evs:set.skillPoints,ivs:set.ivs,
  }).maxHP();
}

const weatherAbilities: Record<string,string>={Drought:'Sun',Drizzle:'Rain','Sand Stream':'Sand','Snow Warning':'Snow'};
const intimidateImmunity=new Set(['Clear Body','White Smoke','Full Metal Body','Hyper Cutter','Inner Focus','Own Tempo','Oblivious','Scrappy']);

/** A fresh lead entry followed by an optional turn-one Mega; no previous switches or setup. */
export function buildBattleState(userSets: PokemonSet[], opponentSets: PokemonSet[], userMega: string|null, opponentMega: string|null): BattleLeadState {
  for (const [sets,selection] of [[userSets,userMega],[opponentSets,opponentMega]] as const) {
    if (selection!==null && !sets.some(s=>s.species===selection && megaForm(s))) {
      throw new VgcError('INVALID_INPUT',`Mega selection ${selection} is not an eligible active stone holder`);
    }
  }
  const user=userSets.map(basePosition), opponent=opponentSets.map(basePosition);
  const notes=['Fresh entry abilities resolve before the selected turn-one Mega Evolution. Holding Mega leaves all active stone holders in base form.'];
  for(const [original,base] of [...userSets.map((s,i)=>[s,user[i]!] as const),...opponentSets.map((s,i)=>[s,opponent[i]!] as const)]) {
    if(megaForm(original) && original.ability!==base.position.ability) notes.push(`${original.species} pre-Mega ability is not established by the export; ${base.position.ability} is an assumed base ability. Entry effects and holding-Mega results are conditional on that assumption.`);
  }
  let weather: string|undefined;
  const entries=[...user,...opponent].sort((a,b)=>battleSpeed(b)-battleSpeed(a));
  const intimidate=(actor:BattlePokemon)=>{
    for(const target of (user.includes(actor)?opponent:user)) {
      if(intimidateImmunity.has(target.position.ability ?? '') || target.item==='Clear Amulet') continue;
      const boosts=target.position.boosts!;
      boosts.atk=Math.min(6,Math.max(-6,(boosts.atk??0)+(['Contrary','Guard Dog'].includes(target.position.ability??'')?1:target.position.ability==='Simple'?-2:-1)));
      if(target.position.ability==='Competitive') boosts.spa=Math.min(6,(boosts.spa??0)+2);
      if(target.position.ability==='Defiant') boosts.atk=Math.min(6,(boosts.atk??0)+2);
    }
  };
  for (const actor of entries) {
    const entryWeather=weatherAbilities[actor.position.ability ?? ''];
    if(entryWeather) weather=entryWeather;
    if(actor.position.ability==='Intimidate') intimidate(actor);
  }
  for(const actor of entries) {
    if(actor.species!==(user.includes(actor)?userMega:opponentMega)) continue;
    const form=megaForm(actor)!;
    const previousAbility=actor.position.ability;
    actor.position.species=form.mega;
    actor.position.ability=defaultAbility(form.mega);
    const megaWeather=weatherAbilities[actor.position.ability];
    if(megaWeather) weather=megaWeather;
    if(actor.position.ability==='Intimidate' && previousAbility!=='Intimidate') intimidate(actor);
  }
  for(const allies of [user,opponent]) for(const actor of allies) {
    actor.protectedByArmorTail=allies.some(s=>['Armor Tail','Dazzling','Queenly Majesty'].includes(s.position.ability??''));
    actor.friendGuard=allies.some(s=>s!==actor && s.position.ability==='Friend Guard');
    if(weather) actor.weather=weather;
  }
  const setters=entries.filter(s=>weatherAbilities[s.position.ability??'']);
  if(setters.some((s,i)=>setters.slice(i+1).some(t=>battleSpeed(s)===battleSpeed(t) && s.position.ability!==t.position.ability))) {
    notes.push('Competing weather setters have a Speed tie; this deterministic branch is conditional, not a resolved weather probability.');
  }
  return {user,opponent,...(weather?{weather}:{}),notes};
}

export function battleDamage(attacker: BattlePokemon, defender: BattlePokemon, move: string, weather?: string, field: DamageRequest['field']={}): ReturnType<typeof calculateChampionsDamage> {
  const result=calculateChampionsDamage({attacker,defender,move,
    attackerPosition:attacker.position,defenderPosition:defender.position,
    field:{...field,...(weather?{weather}:{}),isFriendGuard:defender.friendGuard ?? false,
      isProtected:field.isProtected ?? false},
  });
  const ignoresAbility=['Mold Breaker','Teravolt','Turboblaze'].includes(attacker.position.ability??'');
  if(movePriority(move)>0 && defender.protectedByArmorTail && !ignoresAbility) {
    return {...result,damage:[0],damageDistribution:[{damage:0,probability:1}],range:[0,0],percentRange:[0,0],
      description:`${move} is blocked by the defending side's priority-blocking ability.`,
      assumptions:[...result.assumptions,'Armor Tail/Dazzling/Queenly Majesty blocks priority independently of Protect; Feint does not bypass it.']};
  }
  return result;
}
