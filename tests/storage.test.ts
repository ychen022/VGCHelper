import {describe, expect, it} from 'vitest';

import type {
  BattleState,
  MetaTeam,
  ParsedReplay,
} from '../src/domain/contracts.js';
import {VgcError} from '../src/errors.js';
import {SqliteRepository} from '../src/storage/repository.js';

const emptyState: BattleState = {
  turn: 0,
  sides: {
    p1: {pokemon: {}, activeSlots: []},
    p2: {pokemon: {}, activeSlots: []},
  },
  field: {},
};

function replay(hash: string): ParsedReplay {
  return {
    document: {
      sourceType: 'log',
      raw: 'raw',
      log: 'log',
      metadata: {id: `r-${hash}`, players: ['one', 'two']},
      contentHash: hash,
    },
    events: [],
    turns: [],
    initialState: emptyState,
    finalState: emptyState,
  };
}

function team(id: string, regulationId = 'reg-a'): MetaTeam {
  return {
    id,
    regulationId,
    name: id,
    pokemon: [],
    roster: ['Garchomp'],
    exactSets: false,
    source: {
      provider: 'fixture',
      retrievedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('SqliteRepository', () => {
  it('migrates, deduplicates JSON records, and persists analyses', () => {
    const storage = new SqliteRepository(':memory:');
    storage.initialize();
    const first = storage.saveSourceSnapshot({
      provider: 'fixture',
      regulationId: 'reg-a',
      data: {rows: [1]},
    });
    const duplicate = storage.saveSourceSnapshot({
      provider: 'fixture',
      regulationId: 'reg-a',
      data: {rows: [1]},
    });
    expect(duplicate.id).toBe(first.id);
    expect(storage.listSourceSnapshots('reg-a')).toHaveLength(1);

    const savedReplay = storage.saveReplay(replay('hash-one'));
    expect(storage.saveReplay(replay('hash-one')).id).toBe(savedReplay.id);
    expect(storage.getReplay(savedReplay.id)?.replay.document.log).toBe('log');

    const analysis = storage.saveAnalysis({
      type: 'replay',
      replayId: savedReplay.id,
      analysis: {summary: 'ok'},
    });
    expect(storage.getAnalysis<{summary: string}>(analysis.id)?.analysis.summary)
      .toBe('ok');
    expect(storage.listAnalyses('replay', {replayId: savedReplay.id}))
      .toHaveLength(1);
    storage.close();
  });

  it('activates teams and source snapshots in one transaction', () => {
    const storage = new SqliteRepository(':memory:');
    const source = storage.saveSourceSnapshot({
      provider: 'fixture',
      regulationId: 'reg-a',
      data: {version: 1},
    });
    storage.activateMetaSnapshot({
      regulationId: 'reg-a',
      teams: [team('one')],
      sourceSnapshotIds: [source.id],
    });
    expect(storage.listMetaTeams('reg-a').map((value) => value.id)).toEqual([
      'one',
    ]);
    expect(storage.getLatestSourceSnapshot('fixture', 'reg-a')?.active).toBe(
      true,
    );

    expect(() =>
      storage.activateMetaSnapshot({
        regulationId: 'reg-a',
        teams: [team('two')],
        sourceSnapshotIds: ['missing'],
      }),
    ).toThrow(VgcError);
    expect(storage.listMetaTeams('reg-a').map((value) => value.id)).toEqual([
      'one',
    ]);
    storage.close();
  });

  it('updates freshness when identical source content is revalidated', () => {
    const storage = new SqliteRepository(':memory:');
    const first = storage.saveSourceSnapshot({
      provider: 'test',
      regulationId: 'reg-a',
      data: {value: 1},
      retrievedAt: '2026-01-01T00:00:00.000Z',
    });
    const second = storage.saveSourceSnapshot({
      provider: 'test',
      regulationId: 'reg-a',
      data: {value: 1},
      retrievedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(second.id).toBe(first.id);
    expect(second.retrievedAt).toBe('2026-01-02T00:00:00.000Z');
    storage.close();
  });
});
