import type { ProjectFile } from '../../shared/types'
import type { CoordinationDecision } from '../../shared/agent-flow/coordination'
import type { AgentTaskSnapshot } from '../../shared/agent-flow/runtime-contracts'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import type { CoordinationRun } from './coordination-store'

/** Admit the entire batch before saving intents or starting any specialist. */
export function admitAssignments(
  run: CoordinationRun,
  decision: Extract<CoordinationDecision, { kind: 'dispatch' | 'dispatch-many' }>,
  candidates: Map<string, AgentTaskSnapshot>,
  file: ProjectFile
): Omit<Extract<CoordinationDecision, { kind: 'dispatch' }>, 'kind'>[] {
  const assignments = decision.kind === 'dispatch' ? [decision] : decision.assignments
  if (
    assignments.length > (run.config.maxParallelTasks ?? 1) ||
    new Set(assignments.map((item) => item.nodeId)).size !== assignments.length
  )
    throw new AgentRuntimeError('FLOW_PARALLEL_REJECTED', 'handoff')
  if (run.decisions + (run.controlSteps ?? 0) + assignments.length - 1 > run.config.maxSteps)
    throw new AgentRuntimeError('AGENT_BUDGET_EXHAUSTED', 'coordination')
  for (const item of assignments) {
    const candidate = candidates.get(item.nodeId)
    if (
      !candidate ||
      item.inputs.some(
        (ref) =>
          !candidate.directInputs.some(
            (allowed) => canonicalFlowJson(ref) === canonicalFlowJson(allowed)
          )
      ) ||
      new Set(item.inputs.map(canonicalFlowJson)).size !== item.inputs.length
    )
      throw new AgentRuntimeError('FLOW_HANDOFF_INPUT_REJECTED', 'handoff')
  }
  if (assignments.length > 1) {
    const downstream = new Map<string, string[]>()
    for (const edge of file.edges) {
      const next = downstream.get(edge.from.nodeId) ?? []
      next.push(edge.to.nodeId)
      downstream.set(edge.from.nodeId, next)
    }
    const scopes = assignments.map(
      (item) => new Set([item.nodeId, ...candidates.get(item.nodeId)!.config.allowedNodeIds])
    )
    for (const [index, scope] of scopes.entries()) {
      // A saved upstream result does not remove the dependency on its next write.
      const visited = new Set(scope),
        queue = [...scope]
      for (let offset = 0; offset < queue.length; offset++) {
        for (const target of downstream.get(queue[offset]) ?? []) {
          if (scopes.some((other, otherIndex) => otherIndex !== index && other.has(target)))
            throw new AgentRuntimeError('FLOW_PARALLEL_DEPENDENCY', 'handoff')
          if (!visited.has(target)) {
            visited.add(target)
            queue.push(target)
          }
        }
      }
    }
  }
  return assignments
}
