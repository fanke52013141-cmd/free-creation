import type { CompositeManifest } from '../../shared/composite/manifest'
import type Database from 'better-sqlite3'
import type { PortDecl } from '../../shared/types'
import { readCompositeInstanceRef } from '../../shared/composite/outputs'
import { getCompositeVersion } from '../store/composite.repo'

export function resolveCompositeTarget(
  db: Database.Database,
  config: string | undefined
): { manifest: CompositeManifest; inputs: PortDecl[]; outputs: PortDecl[] } | null {
  const ref = readCompositeInstanceRef(config)
  if (!ref?.contentHash) return null
  const version = getCompositeVersion(ref.capabilityId, ref.version, db)
  if (!version || version.contentHash !== ref.contentHash) return null

  const { manifest } = version
  const port = (
    entry: (typeof manifest.inputs)[number] | (typeof manifest.outputs)[number],
    dir: 'in' | 'out'
  ): PortDecl => ({
    id: `${dir}-${entry.id}`,
    dir,
    name: entry.label,
    description: entry.description || entry.label,
    type: entry.type,
    required: entry.required,
    cardinality: entry.cardinality,
    ...(entry.type === 'json' ? { schema: entry.schemaRef ?? { id: 'json.any', version: 1 } } : {})
  })
  const inputs = manifest.inputs.map((entry) => port(entry, 'in'))
  const outputs = manifest.outputs.map((entry) => port(entry, 'out'))
  return { manifest, inputs, outputs }
}

export function findCompositeCommandWait(
  db: Database.Database,
  projectId: string,
  taskId: string,
  nodeId: string
): { runId: string; requestId: string; stepKey: string; state: string } | undefined {
  return db.prepare(`
    SELECT r.id AS runId, w.id AS requestId, w.step_key AS stepKey, w.state
    FROM composite_runs r
    JOIN flow_commands c ON c.run_id = r.parent_run_id AND c.project_id = r.project_id
    JOIN composite_run_waits w ON w.run_id = r.id
    WHERE c.project_id = ? AND c.task_id = ? AND c.target_node_id = ?
      AND r.instance_node_id = c.target_node_id AND c.state = 'skipped'
      AND r.status = 'waiting-input' AND w.kind = 'human'
    ORDER BY r.created_at DESC, w.revision DESC LIMIT 1
  `).get(projectId, taskId, nodeId) as
    { runId: string; requestId: string; stepKey: string; state: string } | undefined
}
