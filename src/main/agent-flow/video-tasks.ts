import type Database from 'better-sqlite3'
import { cancelVideoTask } from '../gateway/video'
/** Stop intent is persisted synchronously before supplier fact inspection awaits. */
export function stopAgentVideos(
  db: Database.Database,
  projectId: string,
  agentTaskId: string
): void {
  const tasks = db
    .prepare(
      `SELECT tasks.id FROM tasks JOIN flow_commands c
    ON c.project_id=tasks.project_id AND c.target_node_id=tasks.node_id AND c.command_id=json_extract(CASE WHEN json_valid(tasks.input) THEN tasks.input ELSE '{}' END,'$.flowCommandId')
    WHERE c.project_id=? AND c.task_id=? AND c.state IN ('pending','unknown')
    AND tasks.kind='video' AND tasks.status NOT IN ('success','failed','cancelled')`
    )
    .all(projectId, agentTaskId) as Array<{ id: string }>
  for (const task of tasks)
    void cancelVideoTask(task.id).catch(() => {
      // The public control operation owns diagnostics; persisted stop is authoritative.
    })
}
