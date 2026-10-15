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
  candidates: Map<string, AgentTaskSnapshot>
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
  return assignments
}

/** Preserve model order for overlapping write scopes while keeping independent work concurrent. */
export function assignmentWaves(
  assignments: Omit<Extract<CoordinationDecision, { kind: 'dispatch' }>, 'kind'>[],
  candidates: Map<string, AgentTaskSnapshot>,
  file: ProjectFile
): typeof assignments[] {
  const downstream = new Map<string, string[]>()
  for (const edge of file.edges) {
    const next = downstream.get(edge.from.nodeId) ?? []
    next.push(edge.to.nodeId)
    downstream.set(edge.from.nodeId, next)
  }
  const scopes = assignments.map(
    (item) => new Set([item.nodeId, ...candidates.get(item.nodeId)!.config.allowedNodeIds])
  )
  const conflicts = (left: number, right: number): boolean => {
    const a = scopes[left],
      b = scopes[right]
    if ([...a].some((id) => b.has(id))) return true
    for (const scope of [a, b]) {
      // A saved upstream result does not remove the dependency on its next write.
      const visited = new Set(scope),
        queue = [...scope]
      for (let offset = 0; offset < queue.length; offset++) {
        for (const target of downstream.get(queue[offset]) ?? []) {
          if (b.has(target) && scope === a) return true
          if (a.has(target) && scope === b) return true
          if (!visited.has(target)) {
            visited.add(target)
            queue.push(target)
          }
        }
      }
    }
    return false
  }
  const waveIndices: number[][] = []
  const assignedWave: number[] = []
  for (let index = 0; index < assignments.length; index++) {
    let wave = 0
    for (let prior = 0; prior < index; prior++)
      if (conflicts(prior, index)) wave = Math.max(wave, assignedWave[prior] + 1)
    while (waveIndices[wave]?.some((prior) => conflicts(prior, index))) wave++
    ;(waveIndices[wave] ??= []).push(index)
    assignedWave[index] = wave
  }
  return waveIndices.map((indices) => indices.map((index) => assignments[index]!))
}
