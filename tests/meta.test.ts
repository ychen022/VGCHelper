import {describe, expect, it} from 'vitest';

import type {RegulationProfile} from '../src/regulation/profile.js';
import {ChampionsBattleDataProvider} from '../src/meta/providers/champions-battle-data.js';
import {
  VgcPastesProvider,
  extractPokepasteText,
} from '../src/meta/providers/vgc-pastes.js';
import {MetaRefreshService} from '../src/meta/providers/refresh.js';
import {SqliteRepository} from '../src/storage/repository.js';

const profile: RegulationProfile = {
  id: 'reg-a',
  name: 'Fixture regulation',
  game: 'champions',
  generation: 0,
  level: 50,
  gameType: 'Doubles',
  teamSize: 6,
  battleTeamSize: 4,
  acceptedFormats: ['fixture'],
  sources: {
    championsBattleData: {
      baseUrl: 'https://battle.test',
      format: 'Doubles',
      season: 'Current',
      days: 7,
    },
    vgcPastes: {spreadsheetId: 'sheet', gid: '7'},
    holidayOugi: {dataset: 'fixture', files: ['one']},
  },
  evaluation: {maxMetaTeams: 12, maxReturnedFindings: 8},
};

function fixtureFetch(routes: Readonly<Record<string, string>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const body = routes[url];
    return body === undefined
      ? new Response('missing', {status: 404})
      : new Response(body, {status: 200});
  }) as typeof fetch;
}

describe('ChampionsBattleDataProvider', () => {
  it('validates the index and maps requested Doubles CSV rows', async () => {
    const index = JSON.stringify({
      generatedAt: '2026-01-01T00:00:00Z',
      dataVersion: 'v1',
      defaultSeason: 'Current',
      pokemon: [
        {
          name: 'Garchomp',
          showdownId: 'garchomp',
          battleDataCsvs: [
            {
              season: 'Current',
              format: 'Doubles',
              path: 'data/Garchomp.csv',
            },
          ],
        },
      ],
    });
    const csv =
      'pokemon,category,rank,name,percentage,hp_points,attack_points,' +
      'defense_points,sp_atk_points,sp_def_points,speed_points\n' +
      'Garchomp,move,1,Protect,71.3%,,,,,,\n' +
      'Garchomp,stat_points,1,,20%,2,32,0,0,0,32\n';
    const provider = new ChampionsBattleDataProvider({
      fetch: fixtureFetch({
        'https://battle.test/data/pokemon-index.json': index,
        'https://battle.test/data/Garchomp.csv': csv,
      }),
      throttleMs: 0,
    });
    const result = await provider.fetch(profile, ['Garchomp']);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      category: 'move',
      percentage: 71.3,
    });
    expect(result.data[1]?.name).toBe(
      '2 HP / 32 Atk / 0 Def / 0 SpA / 0 SpD / 32 Spe',
    );
    expect(result.source.sourceVersion).toBe('v1');
  });
});

describe('VgcPastesProvider', () => {
  it('finds the real header and parses exact sets from an injected fetch', async () => {
    const csv = [
      'Repository title,,,,,,,,,,,',
      'Team ID,Category,Team Description,Full Name,Pokepaste,Date Shared,Event,Rank,Pokemon 1',
      'A1,Regional,A team,A Player,https://pokepast.es/abc,1 Jan 2026,Event,1st,Garchomp',
    ].join('\n');
    const paste =
      'Garchomp @ Life Orb\nAbility: Rough Skin\nLevel: 50\n' +
      'EVs: 32 Atk / 32 Spe\nJolly Nature\n- Protect\n';
    const provider = new VgcPastesProvider({
      fetch: fixtureFetch({
        'https://docs.google.com/spreadsheets/d/sheet/export?format=csv&gid=7':
          csv,
        'https://pokepast.es/abc/raw': paste,
      }),
      throttleMs: 0,
    });
    const result = await provider.fetch(profile);
    expect(result.data[0]).toMatchObject({
      id: 'A1',
      player: 'A Player',
      roster: ['Garchomp'],
      exactSets: true,
    });
    expect(result.data[0]?.pokemon[0]?.ability).toBe('Rough Skin');
  });

  it('extracts all sets from Pokepaste HTML', () => {
    expect(
      extractPokepasteText(
        '<article><pre>A &amp; B</pre></article><article><pre>C</pre></article>',
      ),
    ).toBe('A & B\n\nC');
  });
});

describe('MetaRefreshService', () => {
  it('stages both providers, activates once, and reuses a fresh cache', async () => {
    const csv =
      'Team ID,Team Description,Pokepaste,Pokemon 1\n' +
      'A1,A team,,Garchomp\n';
    const index = JSON.stringify({
      generatedAt: '2026-01-01T00:00:00Z',
      dataVersion: 'v1',
      pokemon: [
        {
          name: 'Garchomp',
          showdownId: 'garchomp',
          battleDataCsvs: [
            {
              season: 'Current',
              format: 'Doubles',
              path: 'Garchomp.csv',
            },
          ],
        },
      ],
    });
    const battleCsv =
      'pokemon,category,rank,name,percentage\n' +
      'Garchomp,move,1,Protect,50%\n';
    let requests = 0;
    const routes = {
      'https://docs.google.com/spreadsheets/d/sheet/export?format=csv&gid=7':
        csv,
      'https://battle.test/data/pokemon-index.json': index,
      'https://battle.test/Garchomp.csv': battleCsv,
    };
    const fetcher: typeof fetch = (async (
      input: string | URL | Request,
    ) => {
      requests++;
      return fixtureFetch(routes)(input);
    }) as typeof fetch;
    const clock = () => new Date('2026-01-01T00:00:00.000Z');
    const storage = new SqliteRepository(':memory:');
    const service = new MetaRefreshService(
      storage,
      new ChampionsBattleDataProvider({fetch: fetcher, now: clock}),
      new VgcPastesProvider({fetch: fetcher, now: clock}),
      {now: clock},
    );
    expect((await service.refresh(profile)).cached).toBe(false);
    expect(storage.listMetaTeams('reg-a')).toHaveLength(1);
    expect(storage.listLatestSourceSnapshots('reg-a')).toHaveLength(2);
    expect(requests).toBe(3);
    expect((await service.refresh(profile)).cached).toBe(true);
    expect(requests).toBe(3);
    storage.close();
  });
});
