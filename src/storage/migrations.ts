export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_snapshots (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        regulation_id TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        source_version TEXT,
        url TEXT,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
        UNIQUE(provider, regulation_id, content_hash)
      );
      CREATE INDEX IF NOT EXISTS source_snapshots_latest
        ON source_snapshots(regulation_id, provider, active, retrieved_at DESC);

      CREATE TABLE IF NOT EXISTS meta_generations (
        id TEXT PRIMARY KEY,
        regulation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_meta_generation
        ON meta_generations(regulation_id) WHERE active = 1;

      CREATE TABLE IF NOT EXISTS meta_teams (
        generation_id TEXT NOT NULL REFERENCES meta_generations(id) ON DELETE CASCADE,
        regulation_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        team_json TEXT NOT NULL,
        PRIMARY KEY(generation_id, team_id)
      );
      CREATE INDEX IF NOT EXISTS meta_teams_regulation
        ON meta_teams(regulation_id, generation_id);

      CREATE TABLE IF NOT EXISTS replays (
        id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        replay_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS replays_created ON replays(created_at DESC);

      CREATE TABLE IF NOT EXISTS replay_events (
        replay_id TEXT NOT NULL REFERENCES replays(id) ON DELETE CASCADE,
        event_index INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY(replay_id, event_index)
      );
      CREATE TABLE IF NOT EXISTS turn_states (
        replay_id TEXT NOT NULL REFERENCES replays(id) ON DELETE CASCADE,
        turn INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        PRIMARY KEY(replay_id, turn)
      );

      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        replay_id TEXT,
        regulation_id TEXT,
        analysis_type TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        UNIQUE(analysis_type, content_hash)
      );
      CREATE INDEX IF NOT EXISTS analyses_type_created
        ON analyses(analysis_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS analyses_replay
        ON analyses(replay_id, analysis_type, created_at DESC);
    `,
  },
] as const;
