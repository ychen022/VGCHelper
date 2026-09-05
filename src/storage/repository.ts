import {mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';

import Database from 'better-sqlite3';

import type {MetaTeam, ParsedReplay} from '../domain/contracts.js';
import {VgcError, errorMessage} from '../errors.js';
import {dataDirectory} from '../util/fs.js';
import {newId, sha256} from '../util/hash.js';
import {migrations} from './migrations.js';
import type {
  ActivateMetaInput,
  AnalysisInput,
  AnalysisRecord,
  ReplayRecord,
  SourceSnapshot,
  SourceSnapshotInput,
} from './types.js';

interface SnapshotRow {
  id: string;
  provider: string;
  regulation_id: string;
  retrieved_at: string;
  source_version: string | null;
  url: string | null;
  content_hash: string;
  payload_json: string;
  active: number;
}

interface ReplayRow {
  id: string;
  content_hash: string;
  created_at: string;
  replay_json: string;
}

interface AnalysisRow {
  id: string;
  replay_id: string | null;
  regulation_id: string | null;
  analysis_type: string;
  content_hash: string;
  created_at: string;
  analysis_json: string;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new VgcError(
      'STORAGE_ERROR',
      'Value cannot be serialized as JSON',
      undefined,
      {cause: error},
    );
  }
}

function parse<T>(json: string, entity: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new VgcError(
      'STORAGE_ERROR',
      `Stored ${entity} contains invalid JSON`,
      undefined,
      {cause: error},
    );
  }
}

function snapshotFromRow<T>(row: SnapshotRow): SourceSnapshot<T> {
  return {
    id: row.id,
    provider: row.provider,
    regulationId: row.regulation_id,
    retrievedAt: row.retrieved_at,
    ...(row.source_version === null ? {} : {sourceVersion: row.source_version}),
    ...(row.url === null ? {} : {url: row.url}),
    contentHash: row.content_hash,
    data: parse<T>(row.payload_json, 'source snapshot'),
    active: row.active === 1,
  };
}

function replayFromRow(row: ReplayRow): ReplayRecord {
  return {
    id: row.id,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    replay: parse<ParsedReplay>(row.replay_json, 'replay'),
  };
}

function analysisFromRow<T>(row: AnalysisRow): AnalysisRecord<T> {
  return {
    id: row.id,
    ...(row.replay_id === null ? {} : {replayId: row.replay_id}),
    ...(row.regulation_id === null ? {} : {regulationId: row.regulation_id}),
    type: row.analysis_type,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    analysis: parse<T>(row.analysis_json, 'analysis'),
  };
}

export class SqliteRepository {
  readonly database: Database.Database;
  private initialized = false;

  constructor(path = join(dataDirectory(), 'vgc-helper.sqlite')) {
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
      this.database = new Database(path);
      this.database.pragma('foreign_keys = ON');
      this.database.pragma('journal_mode = WAL');
    } catch (error) {
      throw new VgcError(
        'STORAGE_ERROR',
        `Unable to open SQLite database: ${errorMessage(error)}`,
        {path},
        {cause: error},
      );
    }
  }

  initialize(): void {
    if (this.initialized) return;
    try {
      this.database.exec(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
      );
      const applied = this.database.prepare(
        'SELECT 1 FROM schema_migrations WHERE version = ?',
      );
      const migrate = this.database.transaction(() => {
        for (const migration of migrations) {
          if (applied.get(migration.version)) continue;
          this.database.exec(migration.sql);
          this.database
            .prepare(
              'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
            )
            .run(migration.version, new Date().toISOString());
        }
      });
      migrate();
      this.initialized = true;
    } catch (error) {
      throw this.storageError('initialize database', error);
    }
  }

  close(): void {
    this.database.close();
    this.initialized = false;
  }

  saveSourceSnapshot<T>(input: SourceSnapshotInput<T>): SourceSnapshot<T> {
    this.ensureInitialized();
    if (!input.provider.trim() || !input.regulationId.trim()) {
      throw new VgcError(
        'INVALID_INPUT',
        'Source snapshot requires provider and regulationId',
      );
    }
    const payload = stringify(input.data);
    const contentHash = input.contentHash ?? sha256(payload);
    const retrievedAt = input.retrievedAt ?? new Date().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO source_snapshots
           (id, provider, regulation_id, retrieved_at, source_version, url,
            content_hash, payload_json, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, regulation_id, content_hash) DO UPDATE SET
            retrieved_at = excluded.retrieved_at,
            source_version = excluded.source_version,
            url = excluded.url,
            payload_json = excluded.payload_json`,
        )
        .run(
          newId('source'),
          input.provider,
          input.regulationId,
          retrievedAt,
          input.sourceVersion ?? null,
          input.url ?? null,
          contentHash,
          payload,
          input.active === true ? 1 : 0,
        );
      if (input.active === true) {
        this.database
          .prepare(
            `UPDATE source_snapshots SET active = 1
             WHERE provider = ? AND regulation_id = ? AND content_hash = ?`,
          )
          .run(input.provider, input.regulationId, contentHash);
      }
      const row = this.database
        .prepare(
          `SELECT * FROM source_snapshots
           WHERE provider = ? AND regulation_id = ? AND content_hash = ?`,
        )
        .get(input.provider, input.regulationId, contentHash) as
        | SnapshotRow
        | undefined;
      if (!row) throw new Error('Snapshot insert did not produce a row');
      return snapshotFromRow<T>(row);
    } catch (error) {
      throw this.storageError('save source snapshot', error);
    }
  }

  getLatestSourceSnapshot<T>(
    provider: string,
    regulationId: string,
    activeOnly = true,
  ): SourceSnapshot<T> | undefined {
    this.ensureInitialized();
    try {
      const row = this.database
        .prepare(
          `SELECT * FROM source_snapshots
           WHERE provider = ? AND regulation_id = ?
             AND (? = 0 OR active = 1)
           ORDER BY retrieved_at DESC, rowid DESC LIMIT 1`,
        )
        .get(provider, regulationId, activeOnly ? 1 : 0) as
        | SnapshotRow
        | undefined;
      return row ? snapshotFromRow<T>(row) : undefined;
    } catch (error) {
      throw this.storageError('load latest source snapshot', error);
    }
  }

  listLatestSourceSnapshots(
    regulationId: string,
    activeOnly = true,
  ): SourceSnapshot[] {
    this.ensureInitialized();
    try {
      const rows = this.database
        .prepare(
          `SELECT s.* FROM source_snapshots s
           WHERE s.regulation_id = ? AND (? = 0 OR s.active = 1)
             AND s.rowid = (
               SELECT s2.rowid FROM source_snapshots s2
               WHERE s2.regulation_id = s.regulation_id
                 AND s2.provider = s.provider
                 AND (? = 0 OR s2.active = 1)
               ORDER BY s2.retrieved_at DESC, s2.rowid DESC LIMIT 1
             )
           ORDER BY s.provider`,
        )
        .all(
          regulationId,
          activeOnly ? 1 : 0,
          activeOnly ? 1 : 0,
        ) as SnapshotRow[];
      return rows.map((row) => snapshotFromRow(row));
    } catch (error) {
      throw this.storageError('list latest source snapshots', error);
    }
  }

  listSourceSnapshots(
    regulationId: string,
    provider?: string,
  ): SourceSnapshot[] {
    this.ensureInitialized();
    try {
      const rows = (provider
        ? this.database
            .prepare(
              `SELECT * FROM source_snapshots
               WHERE regulation_id = ? AND provider = ?
               ORDER BY retrieved_at DESC, rowid DESC`,
            )
            .all(regulationId, provider)
        : this.database
            .prepare(
              `SELECT * FROM source_snapshots
               WHERE regulation_id = ?
               ORDER BY retrieved_at DESC, rowid DESC`,
            )
            .all(regulationId)) as SnapshotRow[];
      return rows.map((row) => snapshotFromRow(row));
    } catch (error) {
      throw this.storageError('list source snapshots', error);
    }
  }

  replaceMetaTeams(
    regulationId: string,
    teams: readonly MetaTeam[],
    sourceSnapshotIds: readonly string[] = [],
  ): void {
    this.activateMetaSnapshot({regulationId, teams, sourceSnapshotIds});
  }

  activateMetaSnapshot(input: ActivateMetaInput): void {
    this.ensureInitialized();
    if (new Set(input.teams.map((team) => team.id)).size !== input.teams.length) {
      throw new VgcError('INVALID_INPUT', 'Meta team IDs must be unique');
    }
    if (input.teams.some((team) => team.regulationId !== input.regulationId)) {
      throw new VgcError(
        'INVALID_INPUT',
        'Every meta team must match the activated regulation',
      );
    }
    const generationId = newId('meta');
    const now = new Date().toISOString();
    try {
      const activate = this.database.transaction(() => {
        if (input.sourceSnapshotIds?.length) {
          const placeholders = input.sourceSnapshotIds.map(() => '?').join(',');
          const rows = this.database
            .prepare(
              `SELECT id, regulation_id FROM source_snapshots
               WHERE id IN (${placeholders})`,
            )
            .all(...input.sourceSnapshotIds) as Array<{
            id: string;
            regulation_id: string;
          }>;
          if (
            rows.length !== new Set(input.sourceSnapshotIds).size ||
            rows.some((row) => row.regulation_id !== input.regulationId)
          ) {
            throw new VgcError(
              'STORAGE_ERROR',
              'Cannot activate missing or mismatched source snapshots',
            );
          }
        }
        this.database
          .prepare(
            'INSERT INTO meta_generations(id, regulation_id, created_at, active) VALUES (?, ?, ?, 0)',
          )
          .run(generationId, input.regulationId, now);
        const insert = this.database.prepare(
          `INSERT INTO meta_teams
           (generation_id, regulation_id, team_id, content_hash, team_json)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const team of input.teams) {
          const json = stringify(team);
          insert.run(
            generationId,
            input.regulationId,
            team.id,
            sha256(json),
            json,
          );
        }
        this.database
          .prepare(
            'UPDATE meta_generations SET active = 0 WHERE regulation_id = ? AND active = 1',
          )
          .run(input.regulationId);
        this.database
          .prepare('UPDATE meta_generations SET active = 1 WHERE id = ?')
          .run(generationId);
        if (input.sourceSnapshotIds?.length) {
          this.database
            .prepare(
              'UPDATE source_snapshots SET active = 0 WHERE regulation_id = ?',
            )
            .run(input.regulationId);
          const mark = this.database.prepare(
            'UPDATE source_snapshots SET active = 1 WHERE id = ?',
          );
          for (const id of input.sourceSnapshotIds) mark.run(id);
        }
        this.database
          .prepare(
            'DELETE FROM meta_generations WHERE regulation_id = ? AND active = 0',
          )
          .run(input.regulationId);
      });
      activate();
    } catch (error) {
      if (error instanceof VgcError) throw error;
      throw this.storageError('activate meta snapshot', error);
    }
  }

  listMetaTeams(regulationId: string): MetaTeam[] {
    this.ensureInitialized();
    try {
      const rows = this.database
        .prepare(
          `SELECT t.team_json FROM meta_teams t
           JOIN meta_generations g ON g.id = t.generation_id
           WHERE t.regulation_id = ? AND g.active = 1
           ORDER BY t.team_id`,
        )
        .all(regulationId) as Array<{team_json: string}>;
      return rows.map((row) => parse<MetaTeam>(row.team_json, 'meta team'));
    } catch (error) {
      throw this.storageError('list meta teams', error);
    }
  }

  saveReplay(replay: ParsedReplay, id?: string): ReplayRecord {
    this.ensureInitialized();
    const json = stringify(replay);
    const contentHash = replay.document.contentHash || sha256(json);
    const replayId = id ?? replay.document.metadata.id ?? newId('replay');
    const createdAt = replay.document.metadata.uploadedAt ?? new Date().toISOString();
    try {
      const save = this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO replays(id, content_hash, created_at, replay_json)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(content_hash) DO NOTHING`,
          )
          .run(replayId, contentHash, createdAt, json);
        const row = this.database
          .prepare('SELECT * FROM replays WHERE content_hash = ?')
          .get(contentHash) as ReplayRow | undefined;
        if (!row) throw new Error('Replay insert did not produce a row');
        const insertEvent = this.database.prepare(
          `INSERT OR IGNORE INTO replay_events(replay_id, event_index, event_json)
           VALUES (?, ?, ?)`,
        );
        for (const event of replay.events) {
          insertEvent.run(row.id, event.index, stringify(event));
        }
        const insertTurn = this.database.prepare(
          `INSERT OR IGNORE INTO turn_states(replay_id, turn, state_json)
           VALUES (?, ?, ?)`,
        );
        for (const turn of replay.turns) {
          insertTurn.run(row.id, turn.turn, stringify(turn));
        }
        return replayFromRow(row);
      });
      return save();
    } catch (error) {
      throw this.storageError('save replay', error);
    }
  }

  getReplay(id: string): ReplayRecord | undefined {
    this.ensureInitialized();
    try {
      const row = this.database
        .prepare('SELECT * FROM replays WHERE id = ?')
        .get(id) as ReplayRow | undefined;
      return row ? replayFromRow(row) : undefined;
    } catch (error) {
      throw this.storageError('load replay', error);
    }
  }

  listReplays(limit = 100): ReplayRecord[] {
    this.ensureInitialized();
    if (!Number.isInteger(limit) || limit < 1) {
      throw new VgcError('INVALID_INPUT', 'Replay limit must be positive');
    }
    try {
      const rows = this.database
        .prepare('SELECT * FROM replays ORDER BY created_at DESC LIMIT ?')
        .all(limit) as ReplayRow[];
      return rows.map(replayFromRow);
    } catch (error) {
      throw this.storageError('list replays', error);
    }
  }

  saveAnalysis<T>(input: AnalysisInput<T>): AnalysisRecord<T> {
    this.ensureInitialized();
    if (!input.type.trim()) {
      throw new VgcError('INVALID_INPUT', 'Analysis type is required');
    }
    const json = stringify(input.analysis);
    const contentHash = sha256(json);
    const createdAt = input.createdAt ?? new Date().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO analyses
           (id, replay_id, regulation_id, analysis_type, content_hash,
            created_at, analysis_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(analysis_type, content_hash) DO NOTHING`,
        )
        .run(
          input.id ?? newId('analysis'),
          input.replayId ?? null,
          input.regulationId ?? null,
          input.type,
          contentHash,
          createdAt,
          json,
        );
      const row = this.database
        .prepare(
          'SELECT * FROM analyses WHERE analysis_type = ? AND content_hash = ?',
        )
        .get(input.type, contentHash) as AnalysisRow | undefined;
      if (!row) throw new Error('Analysis insert did not produce a row');
      return analysisFromRow<T>(row);
    } catch (error) {
      throw this.storageError('save analysis', error);
    }
  }

  getAnalysis<T>(id: string): AnalysisRecord<T> | undefined {
    this.ensureInitialized();
    try {
      const row = this.database
        .prepare('SELECT * FROM analyses WHERE id = ?')
        .get(id) as AnalysisRow | undefined;
      return row ? analysisFromRow<T>(row) : undefined;
    } catch (error) {
      throw this.storageError('load analysis', error);
    }
  }

  listAnalyses<T>(
    type: string,
    options: {replayId?: string; regulationId?: string; limit?: number} = {},
  ): AnalysisRecord<T>[] {
    this.ensureInitialized();
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new VgcError('INVALID_INPUT', 'Analysis limit must be positive');
    }
    try {
      const rows = this.database
        .prepare(
          `SELECT * FROM analyses
           WHERE analysis_type = ?
             AND (? IS NULL OR replay_id = ?)
             AND (? IS NULL OR regulation_id = ?)
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(
          type,
          options.replayId ?? null,
          options.replayId ?? null,
          options.regulationId ?? null,
          options.regulationId ?? null,
          limit,
        ) as AnalysisRow[];
      return rows.map((row) => analysisFromRow<T>(row));
    } catch (error) {
      throw this.storageError('list analyses', error);
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) this.initialize();
  }

  private storageError(operation: string, error: unknown): VgcError {
    return new VgcError(
      'STORAGE_ERROR',
      `Unable to ${operation}: ${errorMessage(error)}`,
      undefined,
      {cause: error},
    );
  }
}

export {SqliteRepository as StorageRepository};
export {SqliteRepository as SQLiteStorage};
