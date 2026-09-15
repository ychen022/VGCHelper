import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {Generations, toID} from '@smogon/calc';
import {loadRegulationProfile, formatMatches} from '../src/regulation/profile.js';
import {BATTLE_PROFILE} from '../src/battle/engine.js';
import {ENGINE_PROFILE, EngineSession, completePreviewTeam, validateEngineTeam} from '../src/simulation/engine.js';
import {calculateChampionsDamage} from '../src/calc/champions.js';
import {parsePartialShowdownTeam} from '../src/teams/parser.js';
import {ingestReplay} from '../src/replay/index.js';
import {isExplicitMC} from '../src/simulation/learning.js';
import {speciesIdentity} from '../src/simulation/identity.js';
import {VgcPastesProvider} from '../src/meta/providers/vgc-pastes.js';

describe('M-C defaults and historical isolation', () => {
  const profile = loadRegulationProfile();
  it('aligns the active profile, both engines, installed pin and corpus filter', () => {
    expect(profile.id).toBe('champions-vgc-2026-m-c');
    expect(BATTLE_PROFILE.id).toBe(profile.id);
    expect(BATTLE_PROFILE.format).toBe(ENGINE_PROFILE.format);
    expect(BATTLE_PROFILE.revision).toBe(ENGINE_PROFILE.revision);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies['pokemon-showdown']).toContain(ENGINE_PROFILE.revision);
    for (const format of profile.acceptedFormats) {
      expect(formatMatches(profile, format)).toBe(true);
      expect(isExplicitMC({id: 'synthetic', format, log: `|tier|${format}`, source: {provider: 'test'}})).toBe(true);
    }
    expect(formatMatches(profile, '[Gen 9 Champions] VGC 2026 Reg M-B')).toBe(false);
    expect(isExplicitMC({id: 'historical', formatId: 'gen9championsvgc2026regmb', log: '|tier|[Gen 9 Champions] VGC 2026 Reg M-B', source: {provider: 'test'}})).toBe(false);
  });

  it('keeps historical replays explicitly importable but rejects them and old checkpoints by default', () => {
    const content = readFileSync('examples/public-replays/gen9championsvgc2026regmb-2675724766.json', 'utf8');
    expect(() => ingestReplay({content}, profile)).toThrow(/does not match/);
    expect(() => ingestReplay({content}, loadRegulationProfile('champions-vgc-2026-m-b'))).not.toThrow();
    const team = completePreviewTeam(['Rillaboom', 'Garchomp', 'Whimsicott', 'Kingambit', 'Sneasler', 'Basculegion']);
    expect(validateEngineTeam(team)).toEqual([]);
    const checkpoint = EngineSession.create({teams: {p1: team, p2: team}, seed: [1, 2, 3, 4]}).snapshot();
    expect(() => EngineSession.restore({...checkpoint, engineRevision: '6b4bc34e44cc2541929cc4b8fff96e756ab3f268'})).toThrow(/Incompatible/);
  });

  it('parses M-C additions and calculates terrain and Mega-Z mechanics', () => {
    const team = parsePartialShowdownTeam(`Rillaboom @ Miracle Seed
Ability: Grassy Surge
Adamant Nature
- Grassy Glide

Garchomp @ Garchompite Z
Ability: Rough Skin
Timid Nature
- Dragon Pulse`, profile);
    const [attacker, defender] = team.pokemon;
    const input = {attacker: attacker!, defender: defender!, defenderPosition: {species: 'Garchomp'}, move: 'Grassy Glide'};
    const plain = calculateChampionsDamage(input);
    const terrain = calculateChampionsDamage({...input, field: {terrain: 'Grassy'}});
    expect(terrain.range[0]).toBeGreaterThan(plain.range[0]);
    const mega = calculateChampionsDamage({attacker: defender!, defender: attacker!, move: 'Dragon Pulse'});
    expect(mega.description).toContain('Garchomp-Mega-Z');
    expect(Generations.get(0).species.get(toID('Garchomp-Mega-Z'))?.abilities?.[0]).toBe('Levitate');
    expect(speciesIdentity('Garchomp-Mega-Z')).toBe('garchomp');
  });

  it('uses the verified M-C tab and rejects a mislabeled M-B team snapshot before loading pastes', async () => {
    expect(profile.sources.vgcPastes).toMatchObject({gid: '2001945654', teamIdPrefix: 'MC'});
    const csv = 'Team ID,Description,Pokepaste,Pokemon 1,Pokemon 2,Pokemon 3,Pokemon 4,Pokemon 5,Pokemon 6\nMB1,Historical,,Dragonite,Garchomp,Whimsicott,Kingambit,Sneasler,Basculegion';
    const provider = new VgcPastesProvider({fetch: async () => new Response(csv)});
    await expect(provider.fetch(profile)).rejects.toThrow(/do not match the configured regulation/);
  });
});
