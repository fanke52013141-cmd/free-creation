import {
  atom,
  computed,
  type Atom,
  type Computed,
  type Editor,
  type TLShape,
  type TLShapeId
} from 'tldraw'

export interface IndexedArrowEdge {
  arrow: TLShape
  arrowId: TLShapeId
  startId: TLShapeId | null
  endId: TLShapeId | null
  fromPort: string | null
  toPort: string | null
  connectOrder: number | null
  iterationProvenance: string | null
}

export interface NodePageCounts {
  nodes: number
  edges: number
  mediaNodes: number
  groups: number
  backdrops: number
  controlFlowNodes: number
}

export interface NodePageIndex {
  version: number
  signature: string
  sequence: Map<string, number>
  /** 兼容既有字段：与某节点相连的全部 arrow shape。 */
  arrows: Map<string, TLShape[]>
  /** 预解析、已按 shape.index 排好序的入边（O(deg_in) 直接消费）。 */
  incomingByNode: Map<string, readonly IndexedArrowEdge[]>
  /** 预解析、已按 connectOrder 优先 + shape.index 排好序的入边（供多图/多视频引用）。 */
  orderedIncomingByNode: Map<string, readonly IndexedArrowEdge[]>
  /** 预解析出边。 */
  outgoingByNode: Map<string, readonly IndexedArrowEdge[]>
  /** 每节点已连接的 in/out 端口集合（直接替代 collectNodePortConnections 全页扫描）。 */
  portConnections: Map<string, { in: Set<string>; out: Set<string> }>
  artifacts: Map<string, TLShape[]>
  /** 画布规模统计（供性能档位状态机与覆盖层快速短路，O(1) 读取）。 */
  counts: NodePageCounts
}

const MEDIA_NODE_TYPES = new Set([
  'image',
  'image-gen',
  'image-edit',
  'image-crop',
  'image-split',
  'video',
  'video-asset',
  'video-frame',
  'video-clip',
  'video-depth',
  'video-clay'
])

const CONTROL_FLOW_NODE_TYPES = new Set(['agent', 'state-machine', 'ai-review'])

function compareIndex(a: TLShape, b: TLShape): number {
  return String(a.index ?? '').localeCompare(String(b.index ?? ''))
}

function compareConnectOrder(a: IndexedArrowEdge, b: IndexedArrowEdge): number {
  if (a.connectOrder !== null && b.connectOrder !== null) return a.connectOrder - b.connectOrder
  if (a.connectOrder !== null) return -1
  if (b.connectOrder !== null) return 1
  return compareIndex(a.arrow, b.arrow)
}

function buildNodePageIndex(editor: Editor, version: number, computeSignature: boolean): NodePageIndex {
  const sequence = new Map<string, number>()
  const arrows = new Map<string, TLShape[]>()
  const incomingByNode = new Map<string, IndexedArrowEdge[]>()
  const outgoingByNode = new Map<string, IndexedArrowEdge[]>()
  const portConnections = new Map<string, { in: Set<string>; out: Set<string> }>()
  const artifacts = new Map<string, TLShape[]>()
  const arrowSignatures: Array<[string, string, string]> = []

  const shapes = editor.getCurrentPageShapes()
  const nodeCards: TLShape[] = []
  const nodeCardIds = new Set<string>()
  const arrowShapes: TLShape[] = []

  let mediaNodes = 0
  let groups = 0
  let backdrops = 0
  let controlFlowNodes = 0

  for (const shape of shapes) {
    if (shape.type === 'node-card') {
      nodeCards.push(shape)
      nodeCardIds.add(shape.id)
      const nodeType = String((shape.props as { nodeType?: unknown } | undefined)?.nodeType ?? '')
      if (MEDIA_NODE_TYPES.has(nodeType)) mediaNodes += 1
      if (CONTROL_FLOW_NODE_TYPES.has(nodeType)) controlFlowNodes += 1
    } else if (shape.type === 'arrow') {
      arrowShapes.push(shape)
    } else if (shape.type === 'group') {
      groups += 1
    } else if (shape.type === 'backdrop') {
      backdrops += 1
    }
  }

  nodeCards.sort(compareIndex)
  nodeCards.forEach((shape, idx) => sequence.set(shape.id, idx + 1))

  const forPortConn = (id: string): { in: Set<string>; out: Set<string> } => {
    let entry = portConnections.get(id)
    if (!entry) {
      entry = { in: new Set<string>(), out: new Set<string>() }
      portConnections.set(id, entry)
    }
    return entry
  }

  const appendShape = (map: Map<string, TLShape[]>, id: string, shape: TLShape): void => {
    const list = map.get(id) ?? []
    list.push(shape)
    map.set(id, list)
  }

  const appendEdge = (map: Map<string, IndexedArrowEdge[]>, id: string, edge: IndexedArrowEdge): void => {
    const list = map.get(id) ?? []
    list.push(edge)
    map.set(id, list)
  }

  arrowShapes.sort(compareIndex)
  let edgeCount = 0

  for (const shape of arrowShapes) {
    const bindings = editor.getBindingsFromShape(shape.id, 'arrow')
    const start = bindings.find((b) => b.props?.terminal === 'start')
    const end = bindings.find((b) => b.props?.terminal === 'end')
    const startId = (start?.toId as TLShapeId | undefined) ?? null
    const endId = (end?.toId as TLShapeId | undefined) ?? null
    const fromPort = typeof shape.meta?.fromPort === 'string' ? shape.meta.fromPort : null
    const toPort = typeof shape.meta?.toPort === 'string' ? shape.meta.toPort : null
    const connectOrder = typeof shape.meta?.connectOrder === 'number' ? shape.meta.connectOrder : null
    const iterationProvenance =
      typeof shape.meta?.iterationProvenance === 'string' ? shape.meta.iterationProvenance : null

    const edge: IndexedArrowEdge = {
      arrow: shape,
      arrowId: shape.id,
      startId,
      endId,
      fromPort,
      toPort,
      connectOrder,
      iterationProvenance
    }

    const endpoints = new Set(bindings.map((binding) => binding.toId))
    for (const id of endpoints) appendShape(arrows, id, shape)
    if (startId) appendEdge(outgoingByNode, startId, edge)
    if (endId) appendEdge(incomingByNode, endId, edge)

    if (startId && endId && fromPort && toPort) {
      edgeCount += 1
      if (nodeCardIds.has(startId)) forPortConn(startId).out.add(fromPort)
      if (nodeCardIds.has(endId)) forPortConn(endId).in.add(toPort)
    }

    if (computeSignature) {
      arrowSignatures.push([
        shape.id,
        shape.index,
        bindings
          .map((binding) => `${binding.toId}:${binding.props?.terminal ?? ''}`)
          .sort()
          .join(',')
      ])
    }
  }

  for (const shape of nodeCards) {
    const meta = shape.meta as Record<string, unknown> | undefined
    if (typeof meta?.artifactProducerId === 'string') {
      appendShape(artifacts, meta.artifactProducerId, shape)
      if (
        meta.artifactLinkHidden !== true &&
        typeof meta.artifactProducerPortId === 'string'
      ) {
        forPortConn(meta.artifactProducerId).out.add(meta.artifactProducerPortId)
      }
    }
  }

  const orderedIncomingByNode = new Map<string, readonly IndexedArrowEdge[]>()
  for (const [nodeId, list] of incomingByNode) {
    const hasConnectOrder = list.some((e) => e.connectOrder !== null)
    orderedIncomingByNode.set(
      nodeId,
      hasConnectOrder ? [...list].sort(compareConnectOrder) : list
    )
  }

  const signature = computeSignature
    ? JSON.stringify([
        [...sequence],
        [...arrows].map(([id, items]) => [
          id,
          items.map((item) => [item.id, item.meta?.fromPort, item.meta?.toPort])
        ]),
        arrowSignatures,
        [...artifacts].map(([id, items]) => [
          id,
          items.map((item) => [item.id, item.meta?.artifactProducerPortId])
        ])
      ])
    : `v:${version}`

  return {
    version,
    signature,
    sequence,
    arrows,
    incomingByNode,
    orderedIncomingByNode,
    outgoingByNode,
    portConnections,
    artifacts,
    counts: {
      nodes: nodeCards.length,
      edges: edgeCount,
      mediaNodes,
      groups,
      backdrops,
      controlFlowNodes
    }
  }
}

interface StoreChangeRecord {
  typeName?: string
  type?: string
  index?: string
  parentId?: string
  opacity?: number
  fromId?: string
  toId?: string
  props?: Record<string, unknown>
  meta?: Record<string, unknown>
}

function recordAffectsTopology(
  before: StoreChangeRecord | undefined,
  after: StoreChangeRecord | undefined
): boolean {
  const rec = after ?? before
  if (!rec) return false
  if (rec.typeName === 'binding') {
    if (!before || !after) return true
    return (
      before.fromId !== after.fromId ||
      before.toId !== after.toId ||
      before.props?.terminal !== after.props?.terminal
    )
  }
  if (rec.typeName !== 'shape') return false
  if (!before || !after) {
    return (
      rec.type === 'node-card' ||
      rec.type === 'arrow' ||
      rec.type === 'group' ||
      rec.type === 'backdrop'
    )
  }
  if (after.type === 'node-card') {
    return (
      before.index !== after.index ||
      before.parentId !== after.parentId ||
      before.props?.nodeType !== after.props?.nodeType ||
      before.meta?.artifactProducerId !== after.meta?.artifactProducerId ||
      before.meta?.artifactLinkHidden !== after.meta?.artifactLinkHidden ||
      before.meta?.artifactProducerPortId !== after.meta?.artifactProducerPortId
    )
  }
  if (after.type === 'arrow') {
    return (
      before.index !== after.index ||
      before.opacity !== after.opacity ||
      before.meta?.fromPort !== after.meta?.fromPort ||
      before.meta?.toPort !== after.meta?.toPort ||
      before.meta?.connectOrder !== after.meta?.connectOrder ||
      before.meta?.iterationProvenance !== after.meta?.iterationProvenance
    )
  }
  return false
}

function changesAffectTopology(changes: {
  added: Record<string, unknown>
  updated: Record<string, [unknown, unknown]>
  removed: Record<string, unknown>
}): boolean {
  for (const key in changes.added) {
    if (recordAffectsTopology(undefined, changes.added[key] as StoreChangeRecord)) return true
  }
  for (const key in changes.removed) {
    if (recordAffectsTopology(changes.removed[key] as StoreChangeRecord, undefined)) return true
  }
  for (const key in changes.updated) {
    const [before, after] = changes.updated[key] as [StoreChangeRecord, StoreChangeRecord]
    if (recordAffectsTopology(before, after)) return true
  }
  return false
}

interface IncrementalEntry {
  state: Atom<NodePageIndex>
  dispose: () => void
}

const incrementalIndexes = new WeakMap<Editor, IncrementalEntry>()
const fallbackIndexes = new WeakMap<Editor, Computed<NodePageIndex>>()

/**
 * 编辑器级共享拓扑与序号索引。
 *
 * - 真实 Editor：监听 `store.listen(..., { scope: 'document' })` 的增量 diff；
 *   纯坐标移动（x/y）、尺寸调整（w/h）、文本编辑、运行状态更新期间 O(1) 跳过，
 *   零全页扫描、零排序、零 JSON.stringify。
 * - 无 `store.listen` 的轻量单测 mock：自动回退 `computed` 路径保持 100% 兼容。
 */
export function nodePageIndex(editor: Editor): NodePageIndex {
  if (typeof editor.store?.listen === 'function') {
    let entry = incrementalIndexes.get(editor)
    if (!entry) {
      let version = 1
      const state = atom<NodePageIndex>(
        'node page relation index',
        buildNodePageIndex(editor, version, false)
      )
      const offDoc = editor.store.listen(
        (change) => {
          if (!changesAffectTopology(change.changes)) return
          version += 1
          state.set(buildNodePageIndex(editor, version, false))
        },
        { scope: 'document' }
      )
      entry = { state, dispose: offDoc }
      incrementalIndexes.set(editor, entry)
    }
    return entry.state.get()
  }

  let index = fallbackIndexes.get(editor)
  if (!index) {
    let version = 0
    index = computed(
      'node page relation index',
      () => {
        version += 1
        return buildNodePageIndex(editor, version, true)
      },
      { isEqual: (a: NodePageIndex, b: NodePageIndex) => a.signature === b.signature }
    )
    fallbackIndexes.set(editor, index)
  }
  return index.get()
}

export function disposeNodePageIndex(editor: Editor): void {
  const entry = incrementalIndexes.get(editor)
  if (!entry) return
  entry.dispose()
  incrementalIndexes.delete(editor)
}
