/**
 * SQLite schema migration is deliberately kept independent from Electron.
 * Tests can drive this small adapter with a fake database, while production
 * passes the better-sqlite3 instance from db.ts.
 */
export interface MigrationDatabase {
  exec(sql: string): void
  pragma(statement: string, options?: { simple?: boolean }): unknown
}

export const DB_SCHEMA_VERSION = 29

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
  },
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
      CREATE TABLE IF NOT EXISTS library_imports (
        package_sha256 TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, resource_count INTEGER NOT NULL
      );
    `)
  },
  // M8: versioned user-defined categories; resource revisions pin a complete blueprint.
  // IF NOT EXISTS 仅是双保险：重放保护由事务化的 user_version 保证。
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS library_category_versions (
        category_id TEXT NOT NULL, version INTEGER NOT NULL, body_json TEXT NOT NULL,
        PRIMARY KEY(category_id, version)
      );
      CREATE TABLE IF NOT EXISTS library_revision_blueprints (
        revision_id TEXT PRIMARY KEY, category_id TEXT NOT NULL, category_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_library_revision_category ON library_revision_blueprints(category_id);
    `)
  },
  // M9: hierarchical folders replace the library's implicit collection taxonomy.
  // Existing collections and memberships are copied so migration never loses user organization.
  // IF NOT EXISTS 仅是双保险：重放保护由事务化的 user_version 保证。
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS library_folders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_library_folders_parent ON library_folders(parent_id, name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS library_resource_folders (
        folder_id TEXT NOT NULL, resource_id TEXT NOT NULL, added_at INTEGER NOT NULL,
        PRIMARY KEY(folder_id, resource_id)
      );
      CREATE INDEX IF NOT EXISTS idx_library_resource_folders_resource ON library_resource_folders(resource_id);
      INSERT INTO library_folders (id, name, parent_id, created_at, updated_at)
        SELECT id, name, NULL, created_at, updated_at FROM library_collections;
      INSERT OR IGNORE INTO library_resource_folders (folder_id, resource_id, added_at)
        SELECT collection_id, resource_id, added_at FROM library_collection_items;
    `)
  },
  (database) => {
    database.exec(`CREATE TABLE IF NOT EXISTS artifact_recipes (
      media_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, recipe_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_artifact_recipes_project ON artifact_recipes(project_id);`)
  },
  (database) => {
    database.exec(`
      CREATE TABLE flow_asset_versions (
        version_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL, port_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        graph_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
        digest TEXT NOT NULL, value_json TEXT NOT NULL,
        UNIQUE(project_id, node_id, port_id, ordinal)
      );
      CREATE INDEX idx_flow_assets_source ON flow_asset_versions(project_id, node_id, port_id);
      CREATE TABLE flow_asset_submissions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        submission_id TEXT NOT NULL, signature TEXT NOT NULL,
        version_id TEXT NOT NULL REFERENCES flow_asset_versions(version_id),
        PRIMARY KEY(project_id, submission_id)
      );
    `)
  },
  (database) => {
    database.exec(`
      CREATE TABLE flow_command_tasks (
        task_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_node_id TEXT NOT NULL, max_steps INTEGER NOT NULL,
        PRIMARY KEY(project_id, task_id)
      );
      CREATE TABLE flow_commands (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        command_id TEXT NOT NULL, signature TEXT NOT NULL, command_json TEXT NOT NULL,
        target_node_id TEXT NOT NULL, task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL, owner_session TEXT NOT NULL, run_id TEXT NOT NULL,
        state TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        admitted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id, command_id),
        FOREIGN KEY(project_id, task_id) REFERENCES flow_command_tasks(project_id, task_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_flow_command_occupancy ON flow_commands(project_id, target_node_id)
        WHERE state IN ('pending', 'unknown');
    `)
  },
  (database) => {
    database.exec(`
      CREATE TABLE flow_skill_versions (
        skill_id TEXT NOT NULL, version TEXT NOT NULL, content_hash TEXT NOT NULL,
        body_json TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(skill_id, version)
      );
      CREATE TABLE flow_agent_tasks (
        thread TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, agent_node_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        skills_json TEXT NOT NULL, state TEXT NOT NULL, decisions INTEGER NOT NULL DEFAULT 0,
        tools INTEGER NOT NULL DEFAULT 0, active_ms INTEGER NOT NULL DEFAULT 0,
        wait_revision INTEGER NOT NULL DEFAULT 0, wait_kind TEXT, code TEXT,
        output_refs_json TEXT NOT NULL DEFAULT '[]', UNIQUE(project_id, task_id)
      );
      CREATE UNIQUE INDEX idx_flow_agent_active ON flow_agent_tasks(project_id, agent_node_id)
        WHERE state IN ('ready', 'running', 'waiting', 'blocked');
      CREATE TABLE flow_agent_responses (
        thread TEXT NOT NULL REFERENCES flow_agent_tasks(thread) ON DELETE CASCADE,
        event_id TEXT NOT NULL, signature TEXT NOT NULL, wait_revision INTEGER NOT NULL,
        PRIMARY KEY(thread, event_id), UNIQUE(thread, wait_revision)
      );
      CREATE TABLE flow_agent_tool_calls (
        thread TEXT NOT NULL REFERENCES flow_agent_tasks(thread) ON DELETE CASCADE,
        command_id TEXT NOT NULL, PRIMARY KEY(thread, command_id)
      );
      CREATE TABLE flow_agent_checkpoints (
        thread TEXT NOT NULL REFERENCES flow_agent_tasks(thread) ON DELETE CASCADE,
        namespace TEXT NOT NULL, id TEXT NOT NULL, parent TEXT, type TEXT NOT NULL,
        data BLOB NOT NULL, metadata_type TEXT NOT NULL, metadata BLOB NOT NULL,
        PRIMARY KEY(thread, namespace, id)
      );
      CREATE TABLE flow_agent_checkpoint_writes (
        thread TEXT NOT NULL, namespace TEXT NOT NULL, checkpoint TEXT NOT NULL,
        task TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT NOT NULL,
        data BLOB NOT NULL, PRIMARY KEY(thread, namespace, checkpoint, task, idx),
        FOREIGN KEY(thread, namespace, checkpoint)
          REFERENCES flow_agent_checkpoints(thread, namespace, id) ON DELETE CASCADE
      );
    `)
  },
  (database) => {
    database.exec(`
      CREATE TABLE flow_agent_collaboration (
        thread TEXT NOT NULL REFERENCES flow_agent_tasks(thread) ON DELETE CASCADE,
        event_id TEXT NOT NULL, revision INTEGER NOT NULL,
        signature TEXT NOT NULL, body_json TEXT NOT NULL,
        PRIMARY KEY(thread,event_id), UNIQUE(thread,revision)
      );
    `)
  },
  (database) => {
    database.exec(`
      CREATE TABLE flow_coordination_runs (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL, task_id TEXT NOT NULL, body_json TEXT NOT NULL,
        PRIMARY KEY(project_id,task_id)
      );
      CREATE TABLE flow_coordination_events (
        project_id TEXT NOT NULL, task_id TEXT NOT NULL, event_id TEXT NOT NULL,
        revision INTEGER NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL,
        PRIMARY KEY(project_id,task_id,event_id), UNIQUE(project_id,task_id,revision),
        FOREIGN KEY(project_id,task_id) REFERENCES flow_coordination_runs(project_id,task_id) ON DELETE CASCADE
      );
      CREATE TABLE flow_coordination_scope (
        project_id TEXT NOT NULL, node_id TEXT NOT NULL, task_id TEXT NOT NULL,
        PRIMARY KEY(project_id,node_id),
        FOREIGN KEY(project_id,task_id) REFERENCES flow_coordination_runs(project_id,task_id) ON DELETE CASCADE
      );
    `)
  },
  (database) => {
    database.exec(`CREATE TABLE flow_builds (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL, build_id TEXT NOT NULL, body_json TEXT NOT NULL,
      PRIMARY KEY(project_id,build_id)
    );
    CREATE TABLE flow_reviews (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL, request_id TEXT NOT NULL, body_json TEXT NOT NULL,
      PRIMARY KEY(project_id,request_id)
    );`)
  },
  (database) => {
    database.exec(`CREATE TABLE process_locks (
      resource TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL
    );`)
  },
  // M18: persist Agent tool-call proof against capability-relevant model/connection revisions.
  (database) => {
    database.exec(`
      ALTER TABLE model_connections ADD COLUMN agent_tool_calling_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE model_definitions ADD COLUMN agent_tool_calling_revision INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE agent_tool_calling_validations (
        connection_id TEXT NOT NULL,
        model_definition_id TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        checked_at TEXT NOT NULL,
        verified_at TEXT,
        connection_revision INTEGER NOT NULL,
        model_revision INTEGER NOT NULL,
        PRIMARY KEY(connection_id, model_definition_id)
      );
    `)
  },
  // M19: durable local-access receipts; no prompts, credentials or raw requests.
  (database) => {
    database.exec(`CREATE TABLE local_agent_operations (
      idempotency_key TEXT PRIMARY KEY, intent_hmac TEXT NOT NULL,
      status TEXT NOT NULL, receipt_json TEXT, created_at INTEGER NOT NULL
    );`)
  },
  // M20: P2 设备绑定密钥库——密文与封装的内容密钥绑定 kind/id/origin/source/scope；
  // key_imports 记录已导入的 .cskeys 包（重复导入识别）。不含任何明文材料。
  (database) => {
    database.exec(`CREATE TABLE secret_vault (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      origin TEXT NOT NULL,
      credential_source TEXT NOT NULL,
      scope TEXT NOT NULL,
      content_cipher TEXT NOT NULL,
      content_nonce TEXT NOT NULL,
      wrapped_ck TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(kind, id)
    );
    CREATE TABLE key_imports (
      package_id TEXT PRIMARY KEY,
      imported_at INTEGER NOT NULL,
      connection_ids TEXT NOT NULL
    );`)
  },
  // M21: 外部节点执行任务账本（F3）。只存状态、范围与安全摘要；不存提示词/正文。
  (database) => {
    database.exec(`CREATE TABLE external_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      node_ids TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_external_runs_project ON external_runs(project_id, status);`)
  },
  // M22: 导演台外部发布授权账本（F6 收尾）。manual-publish 不能由外部伪造：
  // 只存"待人工授权/已授权/已拒绝/执行中/终态"与正式产物引用，不存工程正文。
  (database) => {
    database.exec(`CREATE TABLE director_publish_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      shot_id TEXT NOT NULL,
      expected_graph_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      media_id TEXT,
      media_path TEXT,
      media_mime TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_director_publish_project ON director_publish_requests(project_id, status);`)
  },
  // M23: 历史快照携带"已持久化图数据"（F7 历史恢复）。外部恢复只读这一列，
  // 不往 tldraw 快照 JSON 里塞附加键——两种格式互不污染；NULL 表示该快照
  // 没有可外部恢复的图（未保存编辑下拍的快照或历史旧行），GUI 恢复不受影响。
  (database) => {
    database.exec('ALTER TABLE history_snapshots ADD COLUMN graph_json TEXT;')
  },
  // M24: 命令账本的调用主体标记（F8 收官）。外部入口只能操作自己创建的命令：
  // 既有行默认 internal；只有 principal=external 且从未准入的命令才允许外部放弃。
  (database) => {
    database.exec(
      `ALTER TABLE flow_commands ADD COLUMN principal TEXT NOT NULL DEFAULT 'internal'
        CHECK (principal IN ('internal','external'));`
    )
  },
  // M25: 组合能力（P1）。定义/草稿/不可变发布版本分开存放；发布版本只增不改。
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS composite_capabilities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        latest_version TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS composite_versions (
        capability_id TEXT NOT NULL,
        version TEXT NOT NULL,
        manifest TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        published_by TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (capability_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_composite_versions_capability
        ON composite_versions(capability_id, published_at DESC);
      CREATE TABLE IF NOT EXISTS composite_drafts (
        capability_id TEXT PRIMARY KEY,
        manifest TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `)
  },
  // M26: 组合运行账本（P3 基础）。一次调用一行；步骤按固定内部 ID 记录，供重启核对。
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS composite_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        capability_version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        instance_node_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_composite_runs_project_status
        ON composite_runs(project_id, status);
      CREATE TABLE IF NOT EXISTS composite_run_steps (
        run_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        node_type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        reason TEXT,
        PRIMARY KEY (run_id, step_key)
      );
      CREATE INDEX IF NOT EXISTS idx_composite_run_steps_run
        ON composite_run_steps(run_id);
    `)
  },
  // M27: 组合运行等待输入（P3）。一个运行同一 revision 只允许一个等待；补交值单独列存放。
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS composite_run_waits (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_key TEXT,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        fields_json TEXT NOT NULL,
        value_json TEXT,
        submitted_by TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        satisfied_at INTEGER,
        UNIQUE (run_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_composite_run_waits_open
        ON composite_run_waits(run_id, state);
    `)
  },
  // M28: 节点流 W1 运行关联（父子调用、失败阶段、公开输出摘要）。
  // 只存 ID/阶段/端口种类，不存正文、提示词或媒体路径。
  (database) => {
    database.exec(`
      ALTER TABLE composite_runs ADD COLUMN parent_run_id TEXT;
      ALTER TABLE composite_runs ADD COLUMN failure_phase TEXT;
      ALTER TABLE composite_runs ADD COLUMN output_summary TEXT;
    `)
  },
  // M29: 媒体路径索引。listMedia/cloneProject 按项目前缀查媒体，
  // 原 substr() 条件无法走索引，媒体行随所有项目累积后每次打开画布都全表扫描。
  (database) => {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_media_path ON media(path);
    `)
  }
]

/**
 * Applies each missing version exactly once and never downgrades a newer database.
 *
 * 每个迁移与其 user_version 推进同处一个事务（SQLite 的 user_version 写入是事务性的）：
 * 中途失败整体回滚，绝不留下「建表成功但版本号未推进」的半迁移状态导致下次启动重跑崩库。
 * BEGIN IMMEDIATE 后重读版本，避免两个启动进程同时执行同一迁移。
 */
export function migrateDatabase(database: MigrationDatabase): number {
  const currentVersion = Number(database.pragma('user_version', { simple: true }) ?? 0)
  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new Error(`SQLite user_version 无效：${String(currentVersion)}`)
  }
  if (currentVersion > DB_SCHEMA_VERSION) {
    throw new Error(`数据库版本 v${currentVersion} 高于当前应用支持的 v${DB_SCHEMA_VERSION}`)
  }
  for (let version = currentVersion + 1; version <= DB_SCHEMA_VERSION; version += 1) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const installed = Number(database.pragma('user_version', { simple: true }) ?? 0)
      if (!Number.isInteger(installed) || installed < 0 || installed > DB_SCHEMA_VERSION)
        throw new Error('SQLite migration version changed unexpectedly')
      if (installed >= version) {
        database.exec('COMMIT')
        continue
      }
      migrations[version - 1]?.(database)
      database.pragma(`user_version = ${version}`)
      database.exec('COMMIT')
    } catch (error) {
      // 磁盘 IO 类故障可能已令 SQLite 自动回滚，此时再 ROLLBACK 会报错并掩盖原始异常。
      try {
        database.exec('ROLLBACK')
      } catch {
        // 事务已不存在：忽略，让原始错误向外抛出。
      }
      throw error
    }
  }
  return currentVersion
}
