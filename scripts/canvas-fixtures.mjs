/* eslint-disable @typescript-eslint/explicit-function-return-type -- 构建脚本为无 TS 编译步骤的 ESM。 */
// 可重复的画布夹具：供演示包和性能基准脚本共用。
// 这里仅生成本地项目 JSON / tldraw 快照，不访问模型供应商，也不包含任何密钥。

export const PAGE_ID = 'page:page'
export const NODE_W = 340
export const NODE_H = 260

const EMPTY_MEDIA = { mediaId: '', mediaPath: '', mediaMime: '' }

export function makeNodeCard({
  id,
  nodeType,
  title,
  x,
  y,
  config = '',
  text = '',
  media = EMPTY_MEDIA,
  exec = 'idle',
  meta = {}
}) {
  return {
    id,
    typeName: 'shape',
    type: 'node-card',
    x,
    y,
    rotation: 0,
    index: `a${id.replace(/[^a-z0-9]/gi, '').slice(-8) || '1'}`,
    parentId: PAGE_ID,
    isLocked: false,
    opacity: 1,
    props: {
      w: NODE_W,
      h: NODE_H,
      nodeType,
      title,
      config,
      text,
      ...media,
      exec
    },
    meta
  }
}

export function makeArrow({ id, from, to, fromPort, toPort, color = 'blue' }) {
  const startX = from.x + NODE_W
  const startY = from.y + NODE_H / 2
  const endX = to.x
  const endY = to.y + NODE_H / 2
  const arrow = {
    id,
    typeName: 'shape',
    type: 'arrow',
    x: startX,
    y: startY,
    rotation: 0,
    index: `a${id.replace(/[^a-z0-9]/gi, '').slice(-8) || '1'}`,
    parentId: PAGE_ID,
    isLocked: false,
    opacity: 1,
    props: {
      kind: 'arc',
      color,
      fill: 'none',
      dash: 'solid',
      size: 'l',
      font: 'sans',
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      start: { x: 0, y: 0 },
      end: { x: endX - startX, y: endY - startY },
      bend: 40,
      labelPosition: 0.5,
      scale: 1
    },
    meta: { fromPort, toPort }
  }
  const binding = (suffix, toId, terminal, anchor) => ({
    id: `binding:${id.slice('shape:'.length)}-${suffix}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: id,
    toId,
    props: { terminal, normalizedAnchor: anchor, isExact: false, isPrecise: true, snap: 'none' },
    meta: {}
  })
  return {
    arrow,
    bindings: [
      binding('start', from.id, 'start', { x: 0.98, y: 0.5 }),
      binding('end', to.id, 'end', { x: 0.02, y: 0.5 })
    ]
  }
}

function contentFor(shape) {
  const { nodeType, text, mediaId } = shape.props
  if (mediaId) return { kind: 'media', mediaId }
  if (nodeType === 'json' || nodeType === 'storyboard') {
    try {
      return { kind: 'json', data: JSON.parse(text) }
    } catch {
      return { kind: 'empty' }
    }
  }
  return text ? { kind: 'text', text } : { kind: 'empty' }
}

/** 将真实 tldraw 形状与派生的工作流图一起打包为 ProjectFile 结构。 */
export function makeProject({ id, name, cards, edges = [] }) {
  const store = {
    'document:document': {
      id: 'document:document',
      typeName: 'document',
      name: name || 'Document',
      meta: {}
    },
    [PAGE_ID]: { id: PAGE_ID, typeName: 'page', name: 'Page 1', index: 'a1', meta: {} }
  }
  for (const card of cards) store[card.id] = card
  for (const edge of edges) {
    store[edge.arrow.id] = edge.arrow
    for (const binding of edge.bindings) store[binding.id] = binding
  }
  return {
    version: 1,
    meta: { id, name, createdAt: 0, updatedAt: 0, graphVersion: 0 },
    nodes: cards.map((card) => ({
      id: card.id,
      type: card.props.nodeType,
      contractVersion: 1,
      title: card.props.title,
      x: card.x,
      y: card.y,
      w: card.props.w,
      h: card.props.h,
      ports: [],
      params: {},
      content: contentFor(card),
      exec: { status: card.props.exec },
      meta: { source: 'input', createdAt: 0 }
    })),
    edges: edges.map(({ arrow, bindings }) => ({
      id: arrow.id,
      from: { nodeId: bindings[0].toId, portId: arrow.meta.fromPort },
      to: { nodeId: bindings[1].toId, portId: arrow.meta.toPort }
    })),
    groups: [],
    tldrawSnapshot: { store }
  }
}

/**
 * 生成纯本地基准项目。节点交替为文本/处理，连线均符合当前端口契约；
 * 默认用网格排布，避免长链布局本身放大 tldraw 的视口范围。
 */
export function makeBenchmarkProject(count) {
  const columns = 10
  const cards = Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns)
    const col = index % columns
    const isText = index % 2 === 0
    return makeNodeCard({
      id: `shape:bench-${index + 1}`,
      nodeType: isText ? 'text' : 'processor',
      title: isText ? `文本 ${index + 1}` : `处理 ${index + 1}`,
      x: 80 + col * 420,
      y: 80 + row * 320,
      config: isText ? '' : JSON.stringify({ fixedValue: '', mode: 'passthrough' }),
      text: isText ? `基准节点 ${index + 1}` : ''
    })
  })
  const edges = cards.slice(1).map((to, index) => {
    const from = cards[index]
    const fromText = from.props.nodeType === 'text'
    return makeArrow({
      id: `shape:bench-edge-${index + 1}`,
      from,
      to,
      fromPort: fromText ? 'out-text' : 'out-value',
      toPort: to.props.nodeType === 'text' ? 'in-text' : 'in-value',
      color: fromText ? 'blue' : 'grey'
    })
  })
  return makeProject({ id: `benchmark-${count}`, name: `${count} 节点性能基准`, cards, edges })
}
