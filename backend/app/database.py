from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    @contextmanager
    def _connection(self):
        """Commit successful units of work and always release the SQLite file handle."""
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self._connection() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS canvas_snapshots (
                    project_id TEXT PRIMARY KEY,
                    snapshot_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    content_type TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    profile_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress INTEGER NOT NULL DEFAULT 0,
                    request_json TEXT NOT NULL,
                    result_json TEXT NOT NULL DEFAULT '[]',
                    upstream_task_id TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
            """)

    def put_snapshot(self, project_id: str, shapes: list[Any]) -> None:
        payload = json.dumps(shapes, ensure_ascii=False, separators=(",", ":"))
        with self._connection() as connection:
            connection.execute("""INSERT INTO canvas_snapshots(project_id, snapshot_json, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at""", (project_id, payload, utc_now()))

    def get_snapshot(self, project_id: str) -> list[Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT snapshot_json FROM canvas_snapshots WHERE project_id=?", (project_id,)).fetchone()
        return json.loads(row["snapshot_json"]) if row else None

    def create_task(self, task_id: str, kind: str, profile_id: str, request: dict[str, Any]) -> None:
        stamp = utc_now()
        with self._connection() as connection:
            connection.execute("INSERT INTO tasks(id, kind, profile_id, status, progress, request_json, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)", (task_id, kind, profile_id, json.dumps(request), stamp, stamp))

    def create_asset(self, asset_id: str, project_id: str, filename: str, content_type: str, relative_path: str) -> None:
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO assets(id, project_id, filename, content_type, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (asset_id, project_id, filename, content_type, relative_path, utc_now()),
            )

    def update_task(self, task_id: str, *, status: str | None = None, progress: int | None = None, result_urls: list[str] | None = None, upstream_task_id: str | None = None, error: str | None = None) -> None:
        assignments: list[str] = ["updated_at=?"]
        values: list[Any] = [utc_now()]
        for field, value in (("status", status), ("progress", progress), ("result_json", json.dumps(result_urls) if result_urls is not None else None), ("upstream_task_id", upstream_task_id), ("error", error)):
            if value is not None:
                assignments.append(f"{field}=?")
                values.append(value)
        values.append(task_id)
        with self._connection() as connection:
            connection.execute(f"UPDATE tasks SET {', '.join(assignments)} WHERE id=?", values)

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            return None
        value = dict(row)
        value["request"] = json.loads(value.pop("request_json"))
        value["result_urls"] = json.loads(value.pop("result_json"))
        return value

    def recover_tasks(self) -> list[str]:
        """Return unfinished tasks after making interrupted running tasks queueable again."""
        with self._connection() as connection:
            connection.execute("UPDATE tasks SET status='pending', progress=0, updated_at=? WHERE status IN ('queued', 'running')", (utc_now(),))
            rows = connection.execute("SELECT id FROM tasks WHERE status='pending' ORDER BY created_at").fetchall()
        return [row["id"] for row in rows]
