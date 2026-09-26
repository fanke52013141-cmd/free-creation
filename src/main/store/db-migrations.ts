/**
 * SQLite schema migration is deliberately kept independent from Electron.
 * Tests can drive this small adapter with a fake database, while production
 * passes the better-sqlite3 instance from db.ts.
 */
export interface MigrationDatabase {
  exec(sql: string): void
  pragma(statement: string, options?: { simple?: boolean }): unknown
}

export const DB_SCHEMA_VERSION = 7

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
  ,
  // M5 模型模块：全新数据域。这里不转换或读取旧 providers 表；旧设置不会被新模块继承。
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS model_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        secret_ref TEXT,
        headers_json TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_definitions (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(connection_id, model_id)
      );
      CREATE TABLE IF NOT EXISTS model_validations (
        connection_id TEXT NOT NULL,
        model_definition_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        action TEXT,
        checked_at TEXT NOT NULL,
        verified_at TEXT,
        PRIMARY KEY(connection_id, model_definition_id, operation)
      );
      CREATE TABLE IF NOT EXISTS model_feature_bindings (
        feature_key TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        model_definition_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        overrides_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_definitions_connection
        ON model_definitions(connection_id);
      CREATE INDEX IF NOT EXISTS idx_model_validations_status
        ON model_validations(status);
    `)
  },
  // M6：媒体名称是资产中心的用户可见信息，不能在重新读取 SQLite 后退化为随机 ID。
  (database) => {
    database.exec(`
      ALTER TABLE media ADD COLUMN name TEXT;
      UPDATE media
      SET name = CASE kind
        WHEN 'image' THEN '图片素材-' || substr(id, 1, 6)
        WHEN 'video' THEN '视频素材-' || substr(id, 1, 6)
        WHEN 'audio' THEN '音频素材-' || substr(id, 1, 6)
        ELSE '文件素材-' || substr(id, 1, 6)
      END
      WHERE name IS NULL OR trim(name) = '';
    `)
  },
  // M7: first-class local resource library with immutable revisions and pinned board items.
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS library_blobs (
        id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
        mime TEXT NOT NULL, file_name TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_resources (
        id TEXT PRIMARY KEY, form_preset TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', latest_revision_id TEXT NOT NULL,
        archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_library_resources_updated
        ON library_resources(archived_at, updated_at DESC);
      CREATE TABLE IF NOT EXISTS library_revisions (
        id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
        base_revision_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        change_note TEXT, created_at INTEGER NOT NULL,
        UNIQUE(resource_id, revision_number)
      );
      CREATE INDEX IF NOT EXISTS idx_library_revisions_resource
        ON library_revisions(resource_id, revision_number DESC);
      CREATE TABLE IF NOT EXISTS library_components (
        id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, role TEXT NOT NULL,
        value_type TEXT NOT NULL, text_content TEXT, blob_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}', sort_index INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_library_components_revision
        ON library_components(revision_id, sort_index);
      CREATE TABLE IF NOT EXISTS library_tags (
        resource_id TEXT NOT NULL, tag TEXT NOT NULL,
        PRIMARY KEY(resource_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_library_tags_tag ON library_tags(tag);
      CREATE TABLE IF NOT EXISTS library_collections (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_collection_items (
        collection_id TEXT NOT NULL, resource_id TEXT NOT NULL, added_at INTEGER NOT NULL,
        PRIMARY KEY(collection_id, resource_id)
      );
      CREATE INDEX IF NOT EXISTS idx_library_collection_items_resource
        ON library_collection_items(resource_id);
      CREATE TABLE IF NOT EXISTS library_usages (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        revision_id TEXT NOT NULL, component_ids_json TEXT NOT NULL,
        project_media_ids_json TEXT NOT NULL DEFAULT '[]',
        materialized_node_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_library_usages_project
        ON library_usages(project_id, last_used_at DESC);
      CREATE TABLE IF NOT EXISTS library_boards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS library_board_items (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        revision_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
        width REAL NOT NULL, height REAL NOT NULL, note TEXT NOT NULL DEFAULT '',
        sort_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_library_board_items_board
        ON library_board_items(board_id, sort_index);
      CREATE TABLE IF NOT EXISTS library_imports (
        package_sha256 TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, resource_count INTEGER NOT NULL
      );
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
