import { createHash } from 'node:crypto'
import type { ProjectFile } from '../../shared/types'
import {
  canonicalFlowJson,
  semanticProjectPayload
} from '../../shared/agent-flow/semantic-revision'
import { NodeExecuteCommandSchema, type NodeExecuteCommand } from '../../shared/agent-flow/commands'

const fingerprint = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalFlowJson(value)).digest('hex')}`

export const projectSemanticRevision = (project: ProjectFile): string =>
  fingerprint(semanticProjectPayload(project))

/** Goal and authorized material edits require explicit revision; scope/edges stay fixed. */
export function collaborationScopeRevision(project: ProjectFile, agentNodeId: string): string {
  const inputs = project.edges.filter((edge) => edge.to.nodeId === agentNodeId)
  const shape = (project.tldrawSnapshot as { store: Record<string, { props: { config: string } }> })
    .store[agentNodeId]
  const targets: string[] = JSON.parse(shape.props.config).allowedNodeIds
  const sources = new Set(
    [...inputs, ...project.edges.filter((edge) => targets.includes(edge.to.nodeId))].map(
      (edge) => edge.from.nodeId
    )
  )
  const payload = semanticProjectPayload(project) as {
    nodes: Array<Record<string, unknown> & { id: string; type: string }>
  }
  for (const node of payload.nodes) {
    if (
      node.id === agentNodeId ||
      (sources.has(node.id) && ['text', 'json', 'processor'].includes(node.type))
    ) {
      node.text = ''
      node.content = { kind: 'empty' }
      if (sources.has(node.id)) {
        delete node.pinnedOutput
        delete node.flowAssetRef
      }
    }
  }
  return fingerprint(payload)
}

/** Receipt identity is separate from diagnostics; a retry may use a fresh trace/span. */
export function nodeCommandIntentSignature(raw: NodeExecuteCommand): string {
  const command = NodeExecuteCommandSchema.parse(raw)
  return fingerprint({
    schemaVersion: command.schemaVersion,
    kind: command.kind,
    projectId: command.projectId,
    taskId: command.taskId,
    agentNodeId: command.agentNodeId,
    targetNodeId: command.targetNodeId,
    expectedSemanticRevision: command.expectedSemanticRevision,
    contractVersion: command.contractVersion,
    // Port map order is irrelevant; asset order within each port remains significant.
    inputs: [...command.inputs].sort((a, b) => a.targetPortId.localeCompare(b.targetPortId))
  })
}
