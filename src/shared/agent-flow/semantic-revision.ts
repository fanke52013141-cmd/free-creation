import type { ProjectFile } from '../types'

/** JSON normalization retains array order: many-input ordering is part of business intent. */
export function canonicalFlowJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFlowJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalFlowJson(object[key])}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('FLOW_INTENT_INVALID')
  return encoded
}
/** Main-only fingerprint. It must be recomputed from the saved project before dispatch. */
export function semanticProjectPayload(project: ProjectFile): unknown {
  const snapshot = project.tldrawSnapshot as { store?: Record<string, unknown> } | undefined
  if (!snapshot?.store) throw new Error('FLOW_SNAPSHOT_MISSING')
  const nodes = [...project.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => {
      const shape = snapshot.store![node.id] as
        | {
            id?: string
            type?: string
            props?: Record<string, unknown>
            meta?: Record<string, unknown>
          }
        | undefined
      if (
        shape?.id !== node.id ||
        shape.type !== 'node-card' ||
        shape.props?.nodeType !== node.type
      ) {
        throw new Error('FLOW_SNAPSHOT_MISMATCH')
      }
      return {
        id: node.id,
        type: node.type,
        contractVersion: node.contractVersion,
        // Ports come from the saved formal graph; dispatch still needs trusted registry validation.
        ports: node.ports.map(
          ({ id, dir, type, required, cardinality, schema, exclusiveGroup }) => ({
            id,
            dir,
            type,
            required,
            cardinality,
            schema,
            exclusiveGroup
          })
        ),
        params: node.params,
        content: node.content,
        title: shape.props.title,
        config: shape.props.config,
        text: shape.props.text,
        mediaId: shape.props.mediaId,
        mediaPath: shape.props.mediaPath,
        mediaMime: shape.props.mediaMime,
        // Fixed output is an input source. Runtime nodeRun/nodeResult do not revise a command.
        pinnedOutput: shape.meta?.pinnedOutput,
        flowAssetRef: shape.meta?.flowAssetRef
      }
    })
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
    throw new Error('FLOW_NODE_ID_CONFLICT')
  }
  return {
    schemaVersion: 1,
    projectId: project.meta.id,
    workspaceProfile: project.workspaceProfile,
    nodes,
    // deriveGraph preserves arrow index order; reordering many inputs changes execution.
    edges: project.edges.map(({ from, to }) => ({ from, to }))
  }
}
