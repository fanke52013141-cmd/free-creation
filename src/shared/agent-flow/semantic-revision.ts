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
/**
 * 运行时续跑标记不是业务意图：视频执行会把供应商 taskId 写入 config 以便重进项目后接回。
 * 该写入发生在命令下发之后，若参与修订比较会让同一命令在提交时被误判为"画布已变更"。
 */
function semanticConfig(type: string, config: unknown): unknown {
  if (type !== 'video' || typeof config !== 'string') return config
  try {
    const parsed: unknown = JSON.parse(config || '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return config
    const record = { ...(parsed as Record<string, unknown>) }
    delete record.taskId
    return canonicalFlowJson(record)
  } catch {
    return config
  }
}
/** Main-only fingerprint. It must be recomputed from the saved project before dispatch. */
export function semanticProjectPayload(project: ProjectFile): unknown {
  const snapshot = project.tldrawSnapshot as { store?: Record<string, unknown> } | undefined
  if (!snapshot?.store) throw new Error('FLOW_SNAPSHOT_MISSING')
  if (new Set(project.nodes.map((node) => node.id)).size !== project.nodes.length)
    throw new Error('FLOW_NODE_ID_CONFLICT')
  const wired = new Set(project.edges.flatMap((edge) => [edge.from.nodeId, edge.to.nodeId]))
  const nodes = [...project.nodes]
    // Disconnected fixed-result cards are presentation copies, not executable inputs.
    // Once wired into the graph their exact pinned value and identity become semantic.
    .filter((node) => {
      const shape = snapshot.store![node.id] as
        | {
            id?: string
            type?: string
            props?: Record<string, unknown>
            meta?: Record<string, unknown>
          }
        | undefined
      return !(
        shape?.id === node.id &&
        shape.type === 'node-card' &&
        shape.props?.nodeType === node.type &&
        shape.meta?.pinnedOutput &&
        shape.meta.flowAssetRef &&
        ['text', 'json', 'image', 'video-asset', 'audio'].includes(node.type) &&
        !wired.has(node.id)
      )
    })
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
        // 项目节点的 params 与卡片 props.config 同步保存；视频续跑标记同样不属于意图。
        params:
          node.type === 'video' &&
          node.params &&
          typeof (node.params as { config?: unknown }).config === 'string'
            ? {
                ...node.params,
                config: semanticConfig('video', (node.params as { config: string }).config)
              }
            : node.params,
        content: node.content,
        title: shape.props.title,
        config: semanticConfig(node.type, shape.props.config),
        text: shape.props.text,
        mediaId: shape.props.mediaId,
        mediaPath: shape.props.mediaPath,
        mediaMime: shape.props.mediaMime,
        // Fixed output is an input source. Runtime nodeRun/nodeResult do not revise a command.
        pinnedOutput: shape.meta?.pinnedOutput,
        flowAssetRef: shape.meta?.flowAssetRef
      }
    })
  return {
    schemaVersion: 1,
    projectId: project.meta.id,
    workspaceProfile: project.workspaceProfile,
    nodes,
    // deriveGraph preserves arrow index order; reordering many inputs changes execution.
    edges: project.edges.map(({ from, to }) => ({ from, to }))
  }
}
