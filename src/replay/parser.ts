import {Protocol} from '@pkmn/protocol';
import {Generations, toID} from '@smogon/calc';

import type {
  BattleState,
  NormalizedEvent,
  ParsedReplay,
  PokemonBattleState,
  ReplayDocument,
  SideBattleState,
  TurnState,
} from '../domain/contracts.js';
import {VgcError} from '../errors.js';
import {readOpenSheet} from './sheets.js';

function emptySide(): SideBattleState {
  return {pokemon: {}, activeSlots: []};
}

export function emptyBattleState(): BattleState {
  return {
    turn: 0,
    sides: {p1: emptySide(), p2: emptySide()},
    field: {},
  };
}

function cloneState(state: BattleState): BattleState {
  return structuredClone(state);
}

function syncActiveSlots(side: SideBattleState): void {
  side.activeSlots = [
    ...new Set(
      Object.values(side.pokemon)
        .filter((pokemon) => pokemon.active && !pokemon.fainted)
        .map((pokemon) => pokemon.slot),
    ),
  ].sort();
}

function decrement(
  target: Record<string, unknown>,
  key: string,
  amount: number,
): void {
  const current = target[key];
  if (typeof current !== 'number') return;
  const next = current - amount;
  if (next > 0) target[key] = next;
  else delete target[key];
}

function advanceTurn(state: BattleState, nextTurn: number): void {
  const amount = Math.max(0, nextTurn - state.turn);
  if (!amount) return;
  for (const side of Object.values(state.sides)) {
    for (const pokemon of Object.values(side.pokemon)) {
      pokemon.volatileConditions = (pokemon.volatileConditions ?? []).filter(effect => !pokemon.singleTurnConditions?.includes(effect));
      pokemon.singleTurnConditions = [];
    }
    const counters = side as unknown as Record<string, unknown>;
    decrement(counters, 'tailwindTurns', amount);
    decrement(counters, 'reflectTurns', amount);
    decrement(counters, 'lightScreenTurns', amount);
    decrement(counters, 'auroraVeilTurns', amount);
  }
  const field = state.field as unknown as Record<string, unknown>;
  decrement(field, 'trickRoomTurns', amount);
  decrement(field, 'gravityTurns', amount);
}

function tags(
  values: Record<string, string | true | undefined>,
): Record<string, string | true> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string | true] => entry[1] !== undefined,
    ),
  );
}

export function normalizeEvents(log: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  let turn = 0;

  for (const raw of log.split(/\r?\n/)) {
    if (!raw.startsWith('|') || raw === '|') continue;
    if (raw.startsWith('|showteam|')) {
      const parts = raw.split('|');
      events.push({index: events.length, turn, type: 'showteam', args: [parts[2] ?? '', parts.slice(3).join('|')], tags: {}, raw});
      continue;
    }
    let parsed: ReturnType<typeof Protocol.parseBattleLine>;
    try {
      parsed = Protocol.parseBattleLine(raw);
    } catch (error) {
      throw new VgcError(
        'INVALID_REPLAY',
        `Malformed Pokemon Showdown protocol line ${events.length + 1}`,
        {raw},
        {cause: error},
      );
    }
    const [type, ...args] = parsed.args.map(String);
    if (!type) continue;
    if (type === 'turn') {
      const next = Number(args[0]);
      if (!Number.isSafeInteger(next) || next <= turn || next > 10000) {
        throw new VgcError('INVALID_REPLAY', 'Invalid or non-increasing turn counter', {raw});
      }
      turn = next;
    }
    events.push({
      index: events.length,
      turn,
      type,
      args,
      tags: tags(parsed.kwArgs),
      raw,
    });
  }

  return events;
}

interface Ident {
  side: 'p1' | 'p2';
  slot: string;
  nickname: string;
  key: string;
}

function parseIdent(value?: string): Ident | undefined {
  if (!value) return undefined;
  const match = /^(p[12])([a-z])?:\s*(.+)$/i.exec(value);
  if (!match?.[1] || !match[3]) return undefined;
  const side = match[1].toLowerCase() as 'p1' | 'p2';
  const slot = `${side}${match[2]?.toLowerCase() ?? ''}`;
  const nickname = match[3].trim();
  return {
    side,
    slot,
    nickname,
    key: `${side}:${nickname.toLowerCase()}`,
  };
}

function speciesFromDetails(value?: string): string | undefined {
  return value?.split(',')[0]?.trim().replace(/-\*$/, '') || undefined;
}

function health(value?: string): Pick<PokemonBattleState, 'hpPercent' | 'hp' | 'status' | 'fainted'> {
  if (!value) return {fainted: false};
  const [fraction, status] = value.trim().split(/\s+/, 2);
  if (!fraction) return {fainted: status === 'fnt'};
  if (fraction === '0' || fraction.startsWith('0/')) {
    return {
      hpPercent: 0,
      ...(status && status !== 'fnt' ? {status} : {}),
      fainted: true,
    };
  }
  const [current, maximum] = fraction.split('/').map(Number);
  const hpPercent =
    Number.isFinite(current) && Number.isFinite(maximum) && maximum
      ? Number(((current! / maximum!) * 100).toFixed(2))
      : undefined;
  return {
    ...(hpPercent !== undefined ? {hpPercent} : {}),
    ...(hpPercent !== undefined && current !== undefined && maximum ? {hp: {
      current, maximum, exact: maximum !== 100 && maximum !== 48,
      percentRange: [Math.max(0, hpPercent - (maximum === 100 || maximum === 48 ? 100 / maximum : 0)), hpPercent] as [number, number],
    }} : {}),
    ...(status && status !== 'fnt' ? {status} : {}),
    fainted: status === 'fnt',
  };
}

function getPokemon(
  state: BattleState,
  ident: Ident,
  create = true,
): PokemonBattleState | undefined {
  const side = state.sides[ident.side];
  let pokemon = side.pokemon[ident.key];
  if (!pokemon && create) {
    pokemon = {
      side: ident.side,
      slot: ident.slot,
      nickname: ident.nickname,
      active: false,
      fainted: false,
      boosts: {},
      moves: [],
    };
    side.pokemon[ident.key] = pokemon;
  }
  return pokemon;
}

function activate(
  state: BattleState,
  ident: Ident,
  details?: string,
  hp?: string,
): void {
  const side = state.sides[ident.side];
  for (const pokemon of Object.values(side.pokemon)) {
    if (pokemon.slot === ident.slot) {
      pokemon.active = false;
      pokemon.boosts = {};
      pokemon.volatileConditions = [];
    }
  }

  const pokemon = getPokemon(state, ident)!;
  pokemon.slot = ident.slot;
  pokemon.nickname = ident.nickname;
  pokemon.active = true;
  pokemon.fainted = false;
  pokemon.boosts = {};
  const species = speciesFromDetails(details);
  if (species) pokemon.species = species;
  const sheet = side.teamSheet?.find((set) => set.species === species);
  if (sheet) {
    if (!pokemon.itemConsumed && !pokemon.itemRemoved && sheet.item) pokemon.item = sheet.item;
    if (!pokemon.ability && sheet.ability) pokemon.ability = sheet.ability;
    pokemon.moves = [...new Set([...pokemon.moves, ...sheet.moves])];
  }
  const currentHealth = health(hp);
  Object.assign(pokemon, currentHealth);
  if (!currentHealth.status) delete pokemon.status;
  syncActiveSlots(side);
}

function normalizeEffect(value?: string): string {
  return (value ?? '').replace(/^(?:move|ability|item):\s*/i, '').trim();
}

function applySideCondition(
  side: SideBattleState,
  condition: string,
  active: boolean,
): void {
  const key = condition.toLowerCase().replace(/[^a-z]/g, '');
  side.conditions = side.conditions ?? [];
  if (active && !side.conditions.includes(condition)) side.conditions.push(condition);
  if (!active) side.conditions = side.conditions.filter((entry) => entry !== condition);
  if (key === 'tailwind') {
    if (active) side.tailwindTurns = 4;
    else delete side.tailwindTurns;
  }
  if (key === 'reflect') {
    if (active) side.reflectTurns = 5;
    else delete side.reflectTurns;
  }
  if (key === 'lightscreen') {
    if (active) side.lightScreenTurns = 5;
    else delete side.lightScreenTurns;
  }
  if (key === 'auroraveil') {
    if (active) side.auroraVeilTurns = 5;
    else delete side.auroraVeilTurns;
  }
}

function setFieldEffect(state: BattleState, effect: string, active: boolean): void {
  const key = effect.toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'trickroom') {
    if (active) state.field.trickRoomTurns = 5;
    else delete state.field.trickRoomTurns;
  }
  if (key === 'gravity') {
    if (active) state.field.gravityTurns = 5;
    else delete state.field.gravityTurns;
  }
  const terrain =
    key.includes('electricterrain') ? 'Electric'
    : key.includes('grassyterrain') ? 'Grassy'
    : key.includes('psychicterrain') ? 'Psychic'
    : key.includes('mistyterrain') ? 'Misty'
    : undefined;
  if (terrain && active) state.field.terrain = terrain;
  if (terrain && !active) delete state.field.terrain;
}

function changeBoost(
  pokemon: PokemonBattleState,
  stat: string | undefined,
  amount: string | undefined,
  mode: 'add' | 'subtract' | 'set',
): void {
  if (!stat || stat === 'hp') return;
  const boost = Number(amount);
  if (!Number.isFinite(boost)) return;
  const boosts = pokemon.boosts as Record<string, number>;
  const current = boosts[stat] ?? 0;
  const next = mode === 'set' ? boost : current + (mode === 'add' ? boost : -boost);
  boosts[stat] = Math.max(-6, Math.min(6, next));
}

function revealFromTag(
  pokemon: PokemonBattleState,
  value?: string | true,
): void {
  if (typeof value !== 'string') return;
  const [kind, name] = value.split(':', 2).map((part) => part.trim());
  if (kind?.toLowerCase() === 'ability' && name) pokemon.ability = name;
  if (kind?.toLowerCase() === 'item' && name) {
    if (!pokemon.itemConsumed && !pokemon.itemRemoved) pokemon.item = name;
    pokemon.revealedItem = name;
  }
}

function applySwap(
  state: BattleState,
  source: Ident,
  targetValue?: string,
): void {
  const sourcePokemon = getPokemon(state, source, false);
  if (!sourcePokemon || !targetValue) return;
  const targetIdent = parseIdent(targetValue);
  if (targetIdent) {
    const targetPokemon = getPokemon(state, targetIdent, false);
    if (!targetPokemon) return;
    const sourceSlot = sourcePokemon.slot;
    sourcePokemon.slot = targetPokemon.slot;
    targetPokemon.slot = sourceSlot;
    syncActiveSlots(state.sides[source.side]);
    return;
  }

  const position = Number(targetValue);
  if (!Number.isInteger(position) || position < 0 || position > 2) return;
  const targetSlot = `${source.side}${String.fromCharCode('a'.charCodeAt(0) + position)}`;
  const targetPokemon = Object.values(state.sides[source.side].pokemon).find(
    (candidate) => candidate.active && candidate.slot === targetSlot,
  );
  if (targetPokemon) targetPokemon.slot = sourcePokemon.slot;
  sourcePokemon.slot = targetSlot;
  syncActiveSlots(state.sides[source.side]);
}

function itemWasRemoved(event: NormalizedEvent): boolean {
  const source = event.tags['from'];
  return (
    typeof source === 'string' &&
    /move:\s*(?:Knock Off|Thief|Covet|Incinerate|Bug Bite|Pluck|Corrosive Gas)/i.test(
      source,
    )
  );
}

export function applyEvent(state: BattleState, event: NormalizedEvent): void {
  const [first, second, third] = event.args;
  const ident = parseIdent(first);
  const pokemon = ident ? getPokemon(state, ident) : undefined;

  switch (event.type) {
    case 'showteam':
      if ((first === 'p1' || first === 'p2') && second) state.sides[first].teamSheet = readOpenSheet(second);
      break;
    case 'turn':
      advanceTurn(state, Number(first ?? state.turn));
      state.turn = Number(first ?? state.turn);
      break;
    case 'player':
      if ((first === 'p1' || first === 'p2') && second) {
        state.sides[first].player = second;
      }
      break;
    case 'poke':
      if ((first === 'p1' || first === 'p2') && second) {
        const side = state.sides[first];
        side.preview ??= [];
        const species = speciesFromDetails(second);
        if (species) side.preview.push(species);
      }
      break;
    case 'switch':
    case 'drag':
    case 'replace':
      if (ident) activate(state, ident, second, third);
      break;
    case 'swap':
      if (ident) applySwap(state, ident, second);
      break;
    case 'detailschange':
    case '-formechange':
      if (pokemon) {
        pokemon.species = speciesFromDetails(second) ?? normalizeEffect(second);
        if (/-Mega(?:-[XY])?$/.test(pokemon.species)) {
          const ability = Generations.get(0).species.get(toID(pokemon.species))?.abilities?.[0];
          if (ability) pokemon.ability = ability;
          else delete pokemon.ability;
        }
      }
      break;
    case 'move':
      if (pokemon && second && !pokemon.moves.includes(second)) pokemon.moves.push(second);
      break;
    case '-damage':
    case '-heal':
      if (pokemon) {
        Object.assign(pokemon, health(second));
        const owner = typeof event.tags['of'] === 'string' ? parseIdent(event.tags['of']) : undefined;
        revealFromTag(owner ? getPokemon(state, owner)! : pokemon, event.tags['from']);
      }
      break;
    case '-status':
      if (pokemon && second) pokemon.status = second;
      break;
    case '-curestatus':
      if (pokemon) delete pokemon.status;
      break;
    case '-boost':
      if (pokemon) changeBoost(pokemon, second, third, 'add');
      break;
    case '-unboost':
      if (pokemon) changeBoost(pokemon, second, third, 'subtract');
      break;
    case '-setboost':
      if (pokemon) changeBoost(pokemon, second, third, 'set');
      break;
    case '-clearboost':
    case '-clearallboost':
      if (event.type === '-clearallboost') {
        for (const side of Object.values(state.sides)) {
          for (const candidate of Object.values(side.pokemon)) candidate.boosts = {};
        }
      } else if (pokemon) {
        pokemon.boosts = {};
      }
      break;
    case '-item':
      if (pokemon && second) {
        pokemon.item = second;
        pokemon.revealedItem = second;
        delete pokemon.itemConsumed;
        delete pokemon.itemRemoved;
      }
      break;
    case '-enditem':
      if (pokemon && second) {
        pokemon.revealedItem = second;
        if (itemWasRemoved(event)) {
          pokemon.itemRemoved = true;
          delete pokemon.itemConsumed;
        } else {
          pokemon.itemConsumed = true;
          delete pokemon.itemRemoved;
        }
        delete pokemon.item;
      }
      break;
    case '-ability':
      if (pokemon && second) pokemon.ability = second;
      break;
    case '-activate':
      if (pokemon) {
        const effect = normalizeEffect(second);
        if (second?.toLowerCase().startsWith('ability:')) pokemon.ability = effect;
      }
      break;
    case '-mega':
      if (pokemon) {
        pokemon.megaEvolved = true;
        if (third) {pokemon.item = third; pokemon.revealedItem = third;}
      }
      break;
    case '-start':
    case '-end':
    case '-singleturn':
      if (pokemon && second) {
        const effect = normalizeEffect(second);
        pokemon.volatileConditions ??= [];
        if (event.type === '-end') pokemon.volatileConditions = pokemon.volatileConditions.filter((entry) => entry !== effect);
        else if (!pokemon.volatileConditions.includes(effect)) pokemon.volatileConditions.push(effect);
        if (event.type === '-singleturn') pokemon.singleTurnConditions = [...(pokemon.singleTurnConditions ?? []),effect];
      }
      break;
    case 'faint':
      if (pokemon) {
        pokemon.hpPercent = 0;
        pokemon.fainted = true;
        pokemon.active = false;
        syncActiveSlots(state.sides[pokemon.side]);
      }
      break;
    case '-weather': {
      const owner = typeof event.tags['of'] === 'string' ? parseIdent(event.tags['of']) : undefined;
      if (owner) revealFromTag(getPokemon(state, owner)!,event.tags['from']);
      const key = normalizeEffect(first).toLowerCase();
      if (event.tags['upkeep']) break;
      const selected =
        key === 'sunnyday' ? 'Sun'
        : key === 'raindance' ? 'Rain'
        : key === 'sandstorm' ? 'Sand'
        : key === 'hail' ? 'Hail'
        : key === 'snow' ? 'Snow'
        : first;
      if (key === 'none') delete state.field.weather;
      else if (selected) state.field.weather = selected;
      break;
    }
    case '-fieldstart':
      setFieldEffect(state, normalizeEffect(first), true);
      break;
    case '-fieldend':
      setFieldEffect(state, normalizeEffect(first), false);
      break;
    case '-sidestart':
    case '-sideend': {
      const sideMatch = /^(p[12])/.exec(first ?? '');
      if (sideMatch?.[1] === 'p1' || sideMatch?.[1] === 'p2') {
        applySideCondition(
          state.sides[sideMatch[1]],
          normalizeEffect(second),
          event.type === '-sidestart',
        );
      }
      break;
    }
  }
}

export function parseReplay(document: ReplayDocument): ParsedReplay {
  const events = normalizeEvents(document.log);
  if (events.length === 0) {
    throw new VgcError('INVALID_REPLAY', 'Replay contains no protocol events');
  }

  const state = emptyBattleState();
  let initialState = cloneState(state);
  const turns: TurnState[] = [];
  let current: TurnState | undefined;

  for (const event of events) {
    if (event.type === 'turn') {
      if (!current) initialState = cloneState(state);
      if (current) {
        current.afterEvents = cloneState(state);
        turns.push(current);
      }
      applyEvent(state, event);
      current = {
        turn: state.turn,
        beforeEvents: cloneState(state),
        events: [],
        afterEvents: cloneState(state),
      };
      continue;
    }

    applyEvent(state, event);
    if (current) current.events.push(event);
  }

  if (current) {
    current.afterEvents = cloneState(state);
    turns.push(current);
  }

  return {
    document,
    events,
    turns,
    initialState,
    finalState: cloneState(state),
  };
}
