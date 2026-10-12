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
