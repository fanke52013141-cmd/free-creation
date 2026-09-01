/**
 * SQLite schema migration is deliberately kept independent from Electron.
 * Tests can drive this small adapter with a fake database, while production
 * passes the better-sqlite3 instance from db.ts.
 */
export interface MigrationDatabase {
  exec(sql: string): void
  pragma(statement: string, options?: { simple?: boolean }): unknown
}

export const DB_SCHEMA_VERSION = 4

const migrations: ReadonlyArray<(database: MigrationDatabase) => void> = [
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, cover_media_id TEXT,
        graph_version INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, mime TEXT NOT NULL, path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, width INTEGER, height INTEGER, duration_sec REAL,
        thumb_path TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
        node_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, input TEXT, output TEXT, error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, node_id TEXT NOT NULL,
        project_id TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, spec_id TEXT NOT NULL, base_url TEXT NOT NULL,
        api_key_ref TEXT, models TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `)
  },
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS history_snapshots (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label TEXT NOT NULL,
        snapshot TEXT NOT NULL, node_count INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_snapshots_project_created
        ON history_snapshots(project_id, created_at DESC);
    `)
  },
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_node_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        actor TEXT NOT NULL DEFAULT 'agent',
        started_at INTEGER,
        finished_at INTEGER,
        duration_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_project_status
        ON runs(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_runs_status
        ON runs(status);

      CREATE TABLE IF NOT EXISTS run_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        port_id TEXT,
        media_id TEXT,
        artifact_type TEXT NOT NULL,
        mime_type TEXT,
        label TEXT,
        input_summary TEXT,
        model_key TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_artifacts_run
        ON run_artifacts(run_id);
      CREATE INDEX IF NOT EXISTS idx_run_artifacts_project
        ON run_artifacts(project_id);
    `)
  },
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_idempotency (
        actor TEXT NOT NULL,
        project_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (actor, project_id, operation, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_idempotency_pending
        ON agent_idempotency(status, updated_at);
    `)
  }
]

/** Applies each missing version exactly once and never downgrades a newer database. */
export function migrateDatabase(database: MigrationDatabase): number {
  const currentVersion = Number(database.pragma('user_version', { simple: true }) ?? 0)
  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new Error(`SQLite user_version 无效：${String(currentVersion)}`)
  }
  if (currentVersion > DB_SCHEMA_VERSION) {
    throw new Error(`数据库版本 v${currentVersion} 高于当前应用支持的 v${DB_SCHEMA_VERSION}`)
  }
  for (let version = currentVersion + 1; version <= DB_SCHEMA_VERSION; version += 1) {
    migrations[version - 1]?.(database)
    database.pragma(`user_version = ${version}`)
  }
  return currentVersion
}
