import {describe, expect, it} from 'vitest';

import {ChampionsBattleDataProvider} from '../src/meta/providers/champions-battle-data.js';
import {VgcPastesProvider} from '../src/meta/providers/vgc-pastes.js';
import {MetaRefreshService} from '../src/meta/providers/refresh.js';
import {hydrateMetaTeam, synthesizeUsageSet} from '../src/meta/inference/hypotheses.js';
import {SqliteRepository} from '../src/storage/repository.js';
import type {MetaTeam, SourceReference} from '../src/domain/contracts.js';
import type {RegulationProfile} from '../src/regulation/profile.js';

const clock = () => new Date('2026-09-04T00:00:00Z');
const header = 'pokemon,category,rank,name,percentage\n';
const source: SourceReference = {provider: 'vgc-pastes', retrievedAt: clock().toISOString()};
const profile: RegulationProfile = {
  id: 'fixture', name: 'Fixture', game: 'champions', generation: 0, level: 50,
  gameType: 'Doubles', teamSize: 6, battleTeamSize: 4, acceptedFormats: ['fixture'],
  sources: {
    championsBattleData: {baseUrl: 'https://battle.test', format: 'Doubles', season: 'M5', days: 7},
    vgcPastes: {spreadsheetId: 'sheet', gid: '7'},
    holidayOugi: {dataset: 'fixture', files: []},
  },
  evaluation: {maxMetaTeams: 12, maxReturnedFindings: 8},
};
const csvUrl = 'https://docs.google.com/spreadsheets/d/sheet/export?format=csv&gid=7';

function fetchRoutes(routes: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    return routes[url] === undefined ? new Response('missing', {status: 404}) : new Response(routes[url]);
  }) as typeof fetch;
}

function entry(name = 'Garchomp', sources = [
  {season: 'M5', format: 'Doubles', path: 'new.csv', date: '01_09_2026', daily: true},
]) {
  return {name, showdownId: name.toLowerCase(), battleDataCsvs: sources};
}

function index(pokemon = [entry()]) {
  return JSON.stringify({generatedAt: '2026-09-03T00:00:00Z', dataVersion: 'v1', pokemon});
}

function battle(routes: Record<string, string>) {
  return new ChampionsBattleDataProvider({fetch: fetchRoutes(routes), throttleMs: 0, now: clock});
}

describe('source integrity', () => {
  it('selects the chronologically latest daily snapshot without pooling daily percentages', async () => {
    const provider = battle({
      'https://battle.test/data/pokemon-index.json': index([entry('Garchomp', [
        {season: 'M5', format: 'Doubles', path: 'old.csv', date: '31_08_2026', daily: true},
        {season: 'M5', format: 'Doubles', path: 'new.csv', date: '01_09_2026', daily: true},
      ])]),
      'https://battle.test/old.csv': header + 'Garchomp,move,1,Earthquake,90%\n',
      'https://battle.test/new.csv': header + 'Garchomp,move,1,Protect,60%\n',
    });
    const result = await provider.fetch(profile, ['Garchomp']);
    expect(result.data.map(row => row.name)).toEqual(['Protect']);
    expect(result.data[0]?.source).toMatchObject({sourceDate: '2026-09-01', season: 'M5', format: 'Doubles'});
  });

  it('rejects an indexed species with no matching season instead of activating partial coverage', async () => {
    const provider = battle({
      'https://battle.test/data/pokemon-index.json': index([entry(), entry('Pikachu', [])]),
      'https://battle.test/new.csv': header + 'Garchomp,move,1,Protect,60%\n',
    });
    await expect(provider.fetch(profile, ['Garchomp', 'Pikachu'])).rejects.toMatchObject({code: 'SOURCE_SCHEMA_CHANGED'});
  });

  it.each([
    ['empty CSV', header],
    ['wrong species CSV', header + 'Pikachu,move,1,Protect,60%\n'],
  ])('rejects %s', async (_label, csv) => {
    const provider = battle({'https://battle.test/data/pokemon-index.json': index(), 'https://battle.test/new.csv': csv});
    await expect(provider.fetch(profile, ['Garchomp'])).rejects.toMatchObject({code: 'SOURCE_SCHEMA_CHANGED'});
  });

  it('does not borrow usage from another regional form', async () => {
    const provider = battle({
      'https://battle.test/data/pokemon-index.json': index([entry('Raichu')]),
      'https://battle.test/new.csv': header + 'Raichu,move,1,Protect,60%\n',
    });
    await expect(provider.fetch(profile, ['Raichu-Alola'])).rejects.toMatchObject({code: 'SOURCE_SCHEMA_CHANGED'});
  });

  it.each([
    ['Sinistcha-Masterpiece', 'Sinistcha', 'sinistcha'],
    ['Vivillon', 'Vivillon Fancy Pattern', 'vivillonfancy'],
  ])('uses an explicit cosmetic usage alias for %s while retaining source attribution', async (requested, name, showdownId) => {
    const provider = battle({
      'https://battle.test/data/pokemon-index.json': index([{...entry(name), showdownId}]),
      'https://battle.test/new.csv': header + `${name},move,1,Protect,60%\n`,
    });
    const result = await provider.fetch(profile, [requested]);
    expect(result.data[0]?.pokemon).toBe(requested);
    expect(result.data[0]?.source.url).toBe('https://battle.test/new.csv');
  });

  it('does not duplicate a usage marginal when base and Mega rosters request the same CSV', async () => {
    const provider = battle({
      'https://battle.test/data/pokemon-index.json': index(),
      'https://battle.test/new.csv': header + 'Garchomp,move,1,Protect,60%\n',
    });
    const result = await provider.fetch(profile, ['Garchomp', 'Garchomp-Mega']);
    expect(result.data).toHaveLength(1);
  });

  it('refreshes published rosters with explicit missing-usage warnings retained on cache hits', async () => {
    const routes = {
      [csvUrl]: 'Team ID,Team Description,Pokepaste,Pokemon 1,Pokemon 2\nA1,Fixture,,Garchomp,Floette-Eternal-Mega\n',
      'https://battle.test/data/pokemon-index.json': index(),
      'https://battle.test/new.csv': header + 'Garchomp,move,1,Protect,60%\n',
    };
    const repository = new SqliteRepository(':memory:');
    const fetcher = fetchRoutes(routes);
    const service = new MetaRefreshService(repository, new ChampionsBattleDataProvider({fetch: fetcher, now: clock}), new VgcPastesProvider({fetch: fetcher, now: clock}), {now: clock});
    try {
      const first = await service.refresh(profile);
      expect(first.teams[0]?.roster).toEqual(['Garchomp', 'Floette-Eternal-Mega']);
      expect(first.warnings.join(' ')).toContain('Floette-Eternal-Mega');
      const cached = await service.refresh(profile);
      expect(cached.cached).toBe(true);
      expect(cached.warnings).toEqual(first.warnings);
    } finally { repository.close(); }
  });

  it('rejects an index that assigns the same CSV to two distinct species', async () => {
    const provider = battle({
      'https://battle.test/data/pokemon-index.json': index([entry(), entry('Pikachu')]),
      'https://battle.test/new.csv': header + 'Pikachu,move,1,Protect,60%\n',
    });
    await expect(provider.fetch(profile, ['Garchomp', 'Pikachu'])).rejects.toMatchObject({code: 'SOURCE_SCHEMA_CHANGED'});
  });

  it('rejects invalid Champions skill-point spreads before caching them', async () => {
    const provider = battle({
      'https://battle.test/data/pokemon-index.json': index(),
      'https://battle.test/new.csv': 'pokemon,category,rank,name,percentage,hp_points,attack_points,defense_points,sp_atk_points,sp_def_points,speed_points\nGarchomp,stat_points,1,,60%,0,33,0,0,0,32\n',
    });
    await expect(provider.fetch(profile, ['Garchomp'])).rejects.toMatchObject({code: 'SOURCE_SCHEMA_CHANGED'});
  });

  it('requires explicit regulation binding when configured', async () => {
    const provider = battle({
      'https://battle.test/data/pokemon-index.json': index(),
      'https://battle.test/new.csv': header + 'Garchomp,move,1,Protect,60%\n',
    });
    await expect(provider.fetch({baseUrl: 'https://battle.test', regulationId: 'fixture', pokemon: ['Garchomp'], season: 'M5', requireBinding: true})).rejects.toMatchObject({code: 'CONFIGURATION_ERROR'});
  });

  it('rejects snapshots outside an explicitly bound regulation window', async () => {
    const provider = battle({
      'https://battle.test/data/pokemon-index.json': index(),
      'https://battle.test/new.csv': header + 'Garchomp,move,1,Protect,60%\n',
    });
    await expect(provider.fetch({baseUrl: 'https://battle.test', regulationId: 'fixture', pokemon: ['Garchomp'], season: 'M5', binding: {regulationId: 'fixture', season: 'M5', validFrom: '2026-07-01', validTo: '2026-08-31'}})).rejects.toMatchObject({code: 'SOURCE_SCHEMA_CHANGED'});
  });

  it('selects the latest snapshot inside the bound regulation dates even when newer data exists', async () => {
    const provider = battle({
      'https://battle.test/data/pokemon-index.json': index([entry('Garchomp', [
        {season: 'M5', format: 'Doubles', path: 'old.csv', date: '31_08_2026', daily: true},
        {season: 'M5', format: 'Doubles', path: 'new.csv', date: '01_09_2026', daily: true},
      ])]),
      'https://battle.test/old.csv': header + 'Garchomp,move,1,Protect,60%\n',
      'https://battle.test/new.csv': header + 'Garchomp,move,1,Earthquake,90%\n',
    });
    const result = await provider.fetch({baseUrl: 'https://battle.test', regulationId: 'fixture', pokemon: ['Garchomp'], season: 'M5', binding: {regulationId: 'fixture', season: 'M5', validFrom: '2026-08-01', validTo: '2026-08-31'}});
    expect(result.data.map(row => row.name)).toEqual(['Protect']);
    expect(result.data[0]?.source).toMatchObject({regulationVerified: true, regulationId: 'fixture', sourceDate: '2026-08-31'});
  });

  it('preserves published fields and identifies an omitted spread as unknown', async () => {
    const provider = new VgcPastesProvider({fetch: fetchRoutes({
      [csvUrl]: 'Team ID,Team Description,Pokepaste,Pokemon 1\nA1,Fixture,https://pokepast.es/abc,Garchomp\n',
      'https://pokepast.es/abc/raw': 'Garchomp @ Life Orb\nAbility: Rough Skin\nJolly Nature\n- Protect\n- Earthquake\n- Dragon Claw\n- Rock Slide\n',
    }), throttleMs: 0, now: clock});
    const result = await provider.fetch(profile);
    const set = result.data[0]?.pokemon[0];
    expect(set?.item).toBe('Life Orb');
    expect(set?.skillPoints).toEqual({});
    expect(set?.provenance?.item?.knowledge).toBe('known');
    expect(set?.provenance?.skillPoints?.knowledge).toBe('unknown');
    expect(set?.provenance?.moves?.knowledge).toBe('known');
  });

  it('rejects a paste whose species disagree with its roster despite equal lengths', async () => {
    const provider = new VgcPastesProvider({fetch: fetchRoutes({
      [csvUrl]: 'Team ID,Team Description,Pokepaste,Pokemon 1\nA1,Fixture,https://pokepast.es/abc,Garchomp\n',
      'https://pokepast.es/abc/raw': 'Pikachu @ Light Ball\nAbility: Static\n- Thunderbolt\n',
    }), throttleMs: 0});
    await expect(provider.fetch(profile)).rejects.toMatchObject({code: 'SOURCE_SCHEMA_CHANGED'});
  });

  it('keeps both active source snapshots after a supplied paste becomes unavailable', async () => {
    const routes = {
      [csvUrl]: 'Team ID,Team Description,Pokepaste,Pokemon 1\nA1,Fixture,https://pokepast.es/abc,Garchomp\n',
      'https://pokepast.es/abc/raw': 'Garchomp @ Life Orb\nAbility: Rough Skin\n- Protect\n',
      'https://battle.test/data/pokemon-index.json': index(),
      'https://battle.test/new.csv': header + 'Garchomp,move,1,Protect,60%\n',
    };
    const repository = new SqliteRepository(':memory:');
    const fetcher = fetchRoutes(routes);
    const service = new MetaRefreshService(repository, new ChampionsBattleDataProvider({fetch: fetcher, now: clock, throttleMs: 0}), new VgcPastesProvider({fetch: fetcher, now: clock, throttleMs: 0}), {now: clock});
    try {
      await service.refresh(profile);
      const active = repository.listLatestSourceSnapshots(profile.id, true).map(s => s.id);
      delete (routes as Record<string, string>)['https://pokepast.es/abc/raw'];
      await expect(service.refresh(profile, {force: true})).rejects.toMatchObject({code: 'SOURCE_UNAVAILABLE'});
      expect(repository.listLatestSourceSnapshots(profile.id, true).map(s => s.id)).toEqual(active);
      expect(repository.listMetaTeams(profile.id)[0]?.pokemon[0]?.item).toBe('Life Orb');
    } finally {
      repository.close();
    }
  });

  it('does not attribute an assumed neutral nature to unrelated usage rows', () => {
    const set = synthesizeUsageSet('Garchomp', [{pokemon: 'Garchomp', category: 'move', name: 'Protect', rank: 1, percentage: 60, source}]);
    expect(set.provenance?.nature?.knowledge).toBe('unknown');
    expect(set.provenance?.nature?.source).toContain('assumption');
  });

  it('does not retain an exact-set label after filling absent sets with usage synthesis', () => {
    const team: MetaTeam = {id: 'A', regulationId: 'fixture', name: 'Fixture', pokemon: [], roster: ['Garchomp'], exactSets: true, source};
    const result = hydrateMetaTeam(team, []);
    expect(result.exactSets).toBe(false);
    expect(result.pokemon[0]?.provenance?.species?.source).toContain('roster');
  });

  it('does not combine old cached daily marginals into a newer hypothetical set', () => {
    const old = {...source, sourceDate: '2026-08-31', url: 'https://battle.test/old.csv'};
    const latest = {...source, sourceDate: '2026-09-01', url: 'https://battle.test/new.csv'};
    const set = synthesizeUsageSet('Garchomp', [
      {pokemon: 'Garchomp', category: 'move', name: 'Earthquake', rank: 1, percentage: 99, source: old},
      {pokemon: 'Garchomp', category: 'item', name: 'Life Orb', rank: 1, percentage: 99, source: old},
      {pokemon: 'Garchomp', category: 'move', name: 'Protect', rank: 1, percentage: 60, source: latest},
    ]);
    expect(set.moves).toEqual(['Protect']);
    expect(set.item).toBeUndefined();
  });

  it('does not use a different verified regulation when hydrating a roster', () => {
    const team: MetaTeam = {id: 'A', regulationId: 'fixture', name: 'Fixture', pokemon: [], roster: ['Garchomp'], exactSets: false, source};
    const hydrated = hydrateMetaTeam(team, [{pokemon: 'Garchomp', category: 'item', name: 'Life Orb', rank: 1, percentage: 90, source: {...source, regulationVerified: true, regulationId: 'other'}}]);
    expect(hydrated.pokemon[0]?.item).toBeUndefined();
  });

  it('treats legacy usage snapshots without regulation verification as unclassified', () => {
    const set = synthesizeUsageSet('Garchomp', [{pokemon: 'Garchomp', category: 'item', name: 'Life Orb', rank: 1, percentage: 90, source: {...source, provider: 'champions-battle-data'}}]);
    expect(set.item).toBeUndefined();
  });

  it('returns an explicit contextual-only warning on an unbound usage refresh and cache hit', async () => {
    const routes = {
      [csvUrl]: 'Team ID,Team Description,Pokepaste,Pokemon 1\nA1,Fixture,,Garchomp\n',
      'https://battle.test/data/pokemon-index.json': index(),
      'https://battle.test/new.csv': header + 'Garchomp,move,1,Protect,60%\n',
    };
    const repository = new SqliteRepository(':memory:');
    const fetcher = fetchRoutes(routes);
    const service = new MetaRefreshService(repository, new ChampionsBattleDataProvider({fetch: fetcher, now: clock}), new VgcPastesProvider({fetch: fetcher, now: clock}), {now: clock});
    try {
      const first = await service.refresh(profile);
      expect(first.warnings?.join(' ')).toContain('unverified');
      const cached = await service.refresh(profile);
      expect(cached.cached).toBe(true);
      expect(cached.warnings).toEqual(first.warnings);
      expect(hydrateMetaTeam(first.teams[0]!, first.usage).pokemon[0]?.moves).toEqual([]);
      const verifiedProfile: RegulationProfile = {...profile, sources: {...profile.sources,
        championsBattleData: {...profile.sources.championsBattleData,
          binding: {regulationId: 'fixture', season: 'M5', validFrom: '2026-09-01', validTo: '2026-09-30'},
        },
      }};
      const verified = await service.refresh(verifiedProfile);
      expect(verified.cached).toBe(false);
      expect(verified.warnings).toEqual([]);
      expect(verified.usage[0]?.source.regulationVerified).toBe(true);
    } finally {
      repository.close();
    }
  });
});
