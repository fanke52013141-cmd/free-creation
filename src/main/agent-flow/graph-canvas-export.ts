import type { ProjectFile } from '../../shared/types'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import { AgentNodeConfigSchema, HumanTaskNodeConfigSchema, ReviewNodeConfigSchema } from '../../shared/agent-flow/node-contracts'
import { FlowGraphSchema, type FlowGraph } from '../../shared/agent-flow/flow-graph'
import { canvasNodeId, compileFlowGraph, type FlowGraphPreview, type CompiledGraph } from '../../shared/agent-flow/flow-graph-compiler'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { readCompositeInstanceManifest, readCompositeInstanceRef } from '../../shared/composite/outputs'
import type { CapabilityDescriptor } from '../../shared/agent-flow/capability-catalog'

/** Read a saved canvas back into the declarative graph, refusing changes the graph cannot reproduce. */
export function exportCanvasFlowGraph(
  file: ProjectFile,
  preview: FlowGraphPreview,
  catalog: readonly CapabilityDescriptor[]
): { graph: FlowGraph; compiled: CompiledGraph } {
  const mismatch = (): never => {
    throw new AgentRuntimeError('FLOW_CANVAS_EXPORT_UNSUPPORTED', 'definition')
  }
  const store = (file.tldrawSnapshot as { store?: Record<string, {
    meta?: Record<string, unknown>
    props: { nodeType: string; title: string; text: string; config: string }
  }> } | undefined)?.store
  const read = (id: string): { nodeType: string; title: string; text: string; config: string } => {
    const shape = store?.[id]
    if (!shape || shape.meta?.flowBuildId !== preview.buildId) return mismatch()
    return shape.props
  }
  const coordinator = read(preview.coordinatorNodeId)
  const originalCoordinator = preview.nodes.find((node) => node.id === preview.coordinatorNodeId)
  if (!originalCoordinator) return mismatch()
  const config = AgentNodeConfigSchema.parse(JSON.parse(coordinator.config))
  const originalConfig = AgentNodeConfigSchema.parse(JSON.parse(originalCoordinator.config))
  const { graph: routedGraph, ...runtime } = config
  const { graph: originalRoutedGraph, ...originalRuntime } = originalConfig
  if (canonicalFlowJson(runtime) !== canonicalFlowJson(originalRuntime)) return mismatch()

  const canvasIds = new Map(preview.graph.nodes.map((node) => [canvasNodeId(node.nodeId), node.nodeId]))
  const scoped = new Set(preview.nodes.map((node) => node.id))
  const priorEdges = new Map(preview.graph.edges.map((edge) => [
    canonicalFlowJson({ from: edge.from, to: edge.to }), edge
  ]))
  const edges = file.edges.filter((edge) => scoped.has(edge.to.nodeId)).map((edge) => {
    const fromId = canvasIds.get(edge.from.nodeId)
    const toId = canvasIds.get(edge.to.nodeId)
    if (!fromId || !toId) return mismatch()
    const from = { ...edge.from, nodeId: fromId }
    const to = { ...edge.to, nodeId: toId }
    return { ...priorEdges.get(canonicalFlowJson({ from, to })), from, to, kind: 'data' }
  })
  const graph = FlowGraphSchema.parse({
    ...preview.graph,
    name: coordinator.title,
    goal: coordinator.text,
    edges,
    nodes: preview.graph.nodes.map((node) => {
      const current = read(canvasNodeId(node.nodeId))
      const updated = { ...node, title: current.title }
      if (node.kind === 'review') {
        const review = ReviewNodeConfigSchema.parse(JSON.parse(current.config))
        return {
          ...updated,
          modelDefinitionId: review.modelDefinitionId,
          responsibleNodeId: review.responsibleNodeId
            ? canvasIds.get(review.responsibleNodeId)
            : undefined,
          subjectSources: review.subjectSources
            .map((source) => ({
              ...source,
              nodeId: canvasIds.get(source.nodeId)
            }))
            .filter((source): source is { nodeId: string; portId: string } =>
              typeof source.nodeId === 'string'
            ),
          gatedNodeIds: review.gatedNodeIds
            .map((id) => canvasIds.get(id))
            .filter((id): id is string => typeof id === 'string'),
          review: {
            criteria: current.text,
            rejectPolicy: review.rejectPolicy,
            maxReworks: review.maxReworks
          }
        }
      }
      if (node.kind === 'human-task') {
        const human = HumanTaskNodeConfigSchema.parse(JSON.parse(current.config))
        return {
          ...updated,
          goal: current.text,
          humanOutputType: human.outputType,
          ...(preview.graph.roles ? { humanRole: human.humanRole } : {})
        }
      }
      if (node.kind === 'agent') {
        const agent = AgentNodeConfigSchema.parse(JSON.parse(current.config))
        return {
          ...updated,
          goal: current.text,
          modelDefinitionId: agent.modelDefinitionId,
          tools: agent.tools,
          allowedNodeIds: agent.allowedNodeIds
            .map((id) => canvasIds.get(id))
            .filter((id): id is string => typeof id === 'string')
        }
      }
      if (node.kind === 'capability') {
        const original = preview.nodes.find((item) => item.id === canvasNodeId(node.nodeId))
        if (!original) return mismatch()
        const previous = JSON.parse(original.config) as Record<string, unknown>
        const proposed = JSON.parse(current.config) as Record<string, unknown>
        const identityKeys = new Set(['capabilityId', 'version', 'contentHash', 'ref', 'manifest'])
        const changed = Object.entries(proposed).filter(([key, value]) =>
          !identityKeys.has(key) &&
          canonicalFlowJson(value) !== (Object.hasOwn(previous, key) ? canonicalFlowJson(previous[key]) : undefined)
        )
        const ref = readCompositeInstanceRef(current.config)
        const inline = readCompositeInstanceManifest({ props: { config: current.config } })
        const capabilityId = ref?.capabilityId ?? inline?.capabilityId
        const version = ref?.version ?? inline?.version
        const withoutLegacyCapability = capabilityId && version
          ? Object.fromEntries(Object.entries(updated).filter(([key]) => key !== 'capability'))
          : updated
        return {
          ...withoutLegacyCapability,
          goal: current.text,
          ...(capabilityId && version
            ? { capabilityRef: { kind: 'composite' as const, id: capabilityId, version } }
            : {}),
          ...(changed.length ? { params: { ...node.params, ...Object.fromEntries(changed) } } : {})
        }
      }
      return { ...updated, goal: current.text }
    })
  })
  const compiled = compileFlowGraph(graph, { catalog })
  const compiledRoot = compiled.nodes.find((node) => node.id === compiled.coordinatorNodeId)
  const compiledRoute = compiledRoot && AgentNodeConfigSchema.parse(JSON.parse(compiledRoot.config)).graph
  const matches = (left: unknown, right: unknown): boolean =>
    canonicalFlowJson(left ?? null) === canonicalFlowJson(right ?? null)
  if (!matches(routedGraph, originalRoutedGraph) && !matches(routedGraph, compiledRoute)) return mismatch()
  for (const next of compiled.nodes) {
    const current = read(next.id)
    const projectNode = file.nodes.find((node) => node.id === next.id)
    if (current.nodeType !== next.type || projectNode?.contractVersion !== next.contractVersion)
      return mismatch()
    if (next.id === compiled.coordinatorNodeId || next.id === compiled.stateNodeId) continue
    const observed = JSON.parse(current.config)
    // The human task instruction mirrors the card goal in the serialized graph.
    if (next.type === 'human-task') {
      const original = preview.nodes.find((node) => node.id === next.id)
      const originalInstructions = original && JSON.parse(original.config).instructions
      if (observed.instructions === originalInstructions) observed.instructions = current.text
    }
    if (canonicalFlowJson(observed) !== canonicalFlowJson(JSON.parse(next.config))) return mismatch()
  }
  const state = read(compiled.stateNodeId)
  const originalState = preview.nodes.find((node) => node.id === compiled.stateNodeId)
  const compiledState = compiled.nodes.find((node) => node.id === compiled.stateNodeId)
  if (!originalState || !compiledState || state.title !== originalState.title || state.text !== originalState.text)
    return mismatch()
  const stateConfig = JSON.parse(state.config)
  if (!matches(stateConfig, JSON.parse(originalState.config)) && !matches(stateConfig, JSON.parse(compiledState.config)))
    return mismatch()
  return { graph, compiled }
}
