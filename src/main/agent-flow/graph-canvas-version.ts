import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ProjectFile } from '../../shared/types'
import type { FlowGraphPreview } from '../../shared/agent-flow/flow-graph-compiler'
import { canonicalFlowJson, semanticProjectPayload } from '../../shared/agent-flow/semantic-revision'

export function graphCanvasScopeHash(file: ProjectFile, preview: FlowGraphPreview): string {
  const ids = new Set(preview.nodes.map((node) => node.id))
  const payload = semanticProjectPayload(file) as {
    nodes: Array<{ id: string }>
    edges: Array<{ from: { nodeId: string }; to: { nodeId: string } }>
  }
  const scoped = {
    nodes: payload.nodes.filter((node) => ids.has(node.id)),
    edges: payload.edges.filter((edge) => ids.has(edge.to.nodeId))
  }
  return 'sha256:' + createHash('sha256').update(canonicalFlowJson(scoped)).digest('hex')
}

export function graphCanvasVersion(
  db: Database.Database, file: ProjectFile, nodeId: string
): import('../../shared/agent-flow/run-overview').FlowRunOverview['canvasVersion'] {
  const shape = (file.tldrawSnapshot as { store?: Record<string, { meta?: Record<string, unknown> }> })
    ?.store?.[nodeId]
  const buildId = shape?.meta?.flowBuildId
  if (typeof buildId !== 'string') return undefined
  const row = db.prepare(
    "SELECT body_json FROM flow_builds WHERE project_id=? AND node_id=? AND build_id=? AND source='graph'"
  ).get(file.meta.id, nodeId, buildId) as { body_json: string } | undefined
  if (!row) return undefined
  const preview = JSON.parse(row.body_json) as FlowGraphPreview
  if (preview.state !== 'committed' || !preview.committedScopeHash) return undefined
  return {
    ...(preview.sourceGraph ? { sourceGraph: preview.sourceGraph } : {}),
    buildId,
    diverged: graphCanvasScopeHash(file, preview) !== preview.committedScopeHash
  }
}
