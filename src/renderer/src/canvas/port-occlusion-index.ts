import { atom, type Atom, type Editor, type TLShapeId } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { NODE_PORT_OUTSET } from './edge-geometry'
import { getNodePorts, getNodeType } from '../nodes/registry'
import { createNodePortLayout } from './node-port-layout'
import { dynamicPortIdsForShape } from './graph'
import { nodePageIndex } from './node-page-index'
import { readIterationSnapshot } from './iteration-lanes'

const CELL_SIZE = 512
const COVER_PAD = 12
const PORT_MARGIN = NODE_PORT_OUTSET + COVER_PAD

interface CardBox {
  shape: NodeCardShape
  x: number
  y: number
  maxX: number
  maxY: number
  height: number
}

function cellKey(cx: number, cy: number): number {
  return ((cx + 32768) << 16) ^ (cy + 32768)
}

/**
 * 编辑器级共享端口遮挡索引（空间网格哈希，平均 O(N)）。
 *
 * 替代此前每张 NodeCardView 独立在 useValue 中全页扫描 O(N²) 并返回新 Set
 * 引发的「拖动 1 个节点导致全画布 N 张卡同时重渲染」问题。
 *
 * 返回 Map<TLShapeId, string>：
 * - 无任何被遮挡端口的节点不入表（查询返回 ''）；
 * - 有被遮挡端口的节点存稳定排序签名串（如 'in:in-text|out:out-image'）；
 * - 卡片端通过 useValue 订阅单节点基本类型 string，未重叠节点 0 次重渲染。
 */
function computePortOcclusionMap(editor: Editor): Map<TLShapeId, string> {
  const cards: CardBox[] = []
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'node-card') continue
    if (shape.opacity === 0) continue
    const bounds = editor.getShapePageBounds(shape.id)
    if (!bounds) continue
    cards.push({
      shape: shape as NodeCardShape,
      x: bounds.x,
      y: bounds.y,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
      height: bounds.height
    })
  }
  if (cards.length < 2) return new Map()

  cards.sort((a, b) => String(a.shape.index ?? '').localeCompare(String(b.shape.index ?? '')))

  // 注册每张卡的覆盖包围盒到空间哈希网格
  const grid = new Map<number, number[]>()
  for (let i = 0; i < cards.length; i += 1) {
    const c = cards[i]
    const minCx = Math.floor((c.x - COVER_PAD) / CELL_SIZE)
    const maxCx = Math.floor((c.maxX + COVER_PAD) / CELL_SIZE)
    const minCy = Math.floor((c.y - COVER_PAD) / CELL_SIZE)
    const maxCy = Math.floor((c.maxY + COVER_PAD) / CELL_SIZE)
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const key = cellKey(cx, cy)
        const bucket = grid.get(key)
        if (bucket) bucket.push(i)
        else grid.set(key, [i])
      }
    }
  }

  const result = new Map<TLShapeId, string>()
  const pageIndex = nodePageIndex(editor)

  for (let i = 0; i < cards.length - 1; i += 1) {
    const card = cards[i]
    const minCx = Math.floor((card.x - PORT_MARGIN) / CELL_SIZE)
    const maxCx = Math.floor((card.maxX + PORT_MARGIN) / CELL_SIZE)
    const minCy = Math.floor((card.y - COVER_PAD) / CELL_SIZE)
    const maxCy = Math.floor((card.maxY + COVER_PAD) / CELL_SIZE)

    const candidates = new Set<number>()
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const bucket = grid.get(cellKey(cx, cy))
        if (!bucket) continue
        for (const j of bucket) {
          if (j > i) candidates.add(j)
        }
      }
    }
    if (candidates.size === 0) continue

    const covers: CardBox[] = []
    for (const j of candidates) {
      const cover = cards[j]
      if (
        cover.x - COVER_PAD <= card.maxX + NODE_PORT_OUTSET &&
        cover.maxX + COVER_PAD >= card.x - NODE_PORT_OUTSET &&
        cover.y - COVER_PAD <= card.maxY &&
        cover.maxY + COVER_PAD >= card.y
      ) {
        covers.push(cover)
      }
    }
    if (covers.length === 0) continue

    const shape = card.shape
    const stackMember = (shape.meta as Record<string, unknown> | undefined)?.stackRole === 'member'
    const isSnapshot = Boolean(readIterationSnapshot(shape))
    const spec = getNodeType(shape.props.nodeType)
    const ports = spec ? getNodePorts(spec, shape) : { in: [], out: [] }
    const conn = pageIndex.portConnections.get(shape.id)
    const dynamic = dynamicPortIdsForShape(shape)

    const visibleIn =
      stackMember || isSnapshot
        ? { ports: [], offsets: new Map<string, number>() }
        : createNodePortLayout(ports.in, conn?.in ?? new Set(), shape.props.h, undefined, dynamic.in)
    const visibleOut =
      stackMember || isSnapshot
        ? { ports: [], offsets: new Map<string, number>() }
        : createNodePortLayout(ports.out, conn?.out ?? new Set(), shape.props.h, undefined, dynamic.out)

    const isCovered = (x: number, y: number): boolean =>
      covers.some(
        (c) =>
          x >= c.x - COVER_PAD &&
          x <= c.maxX + COVER_PAD &&
          y >= c.y - COVER_PAD &&
          y <= c.maxY + COVER_PAD
      )

    const pageY = (offset: number): number =>
      shape.props.h > 0 ? card.y + (card.height * offset) / shape.props.h : card.y

    const occluded: string[] = []
    for (const port of visibleIn.ports) {
      if (isCovered(card.x - NODE_PORT_OUTSET, pageY(visibleIn.offsets.get(port.id) ?? 0))) {
        occluded.push(`in:${port.id}`)
      }
    }
    for (const port of visibleOut.ports) {
      if (isCovered(card.maxX + NODE_PORT_OUTSET, pageY(visibleOut.offsets.get(port.id) ?? 0))) {
        occluded.push(`out:${port.id}`)
      }
    }
    if (
      ports.in.length === 0 &&
      isCovered(card.x - NODE_PORT_OUTSET, card.y + card.height / 2)
    ) {
      occluded.push('in:artifact')
    }
    if (occluded.length > 0) {
      occluded.sort()
      result.set(shape.id, occluded.join('|'))
    }
  }

  return result
}

interface GeomChangeRecord {
  typeName?: string
  type?: string
  x?: number
  y?: number
  index?: string
  opacity?: number
  parentId?: string
  props?: { w?: number; h?: number; nodeType?: string }
}

function changesAffectGeometry(changes: {
  added: Record<string, unknown>
  updated: Record<string, [unknown, unknown]>
  removed: Record<string, unknown>
}): boolean {
  for (const key in changes.added) {
    const rec = changes.added[key] as GeomChangeRecord | undefined
    if (rec?.typeName === 'shape' && (rec.type === 'node-card' || rec.type === 'group')) return true
  }
  for (const key in changes.removed) {
    const rec = changes.removed[key] as GeomChangeRecord | undefined
    if (rec?.typeName === 'shape' && (rec.type === 'node-card' || rec.type === 'group')) return true
  }
  for (const key in changes.updated) {
    const [before, after] = changes.updated[key] as [GeomChangeRecord, GeomChangeRecord]
    if (after?.typeName !== 'shape') continue
    if (after.type === 'group') {
      if (before?.x !== after.x || before?.y !== after.y) return true
    } else if (after.type === 'node-card') {
      if (
        before?.x !== after.x ||
        before?.y !== after.y ||
        before?.props?.w !== after.props?.w ||
        before?.props?.h !== after.props?.h ||
        before?.index !== after.index ||
        before?.opacity !== after.opacity ||
        before?.parentId !== after.parentId ||
        before?.props?.nodeType !== after.props?.nodeType
      ) {
        return true
      }
    }
  }
  return false
}

function mapsEqual(a: Map<TLShapeId, string>, b: Map<TLShapeId, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false
  }
  return true
}

interface OcclusionEntry {
  state: Atom<Map<TLShapeId, string>>
  dispose: () => void
}

const occlusionIndexes = new WeakMap<Editor, OcclusionEntry>()

export function nodePortOcclusionSignature(editor: Editor, shapeId: TLShapeId): string {
  if (typeof editor.store?.listen !== 'function') return ''
  let entry = occlusionIndexes.get(editor)
  if (!entry) {
    const state = atom<Map<TLShapeId, string>>(
      'node port occlusion map',
      computePortOcclusionMap(editor)
    )
    let frame = 0
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const next = computePortOcclusionMap(editor)
        if (!mapsEqual(state.__unsafe__getWithoutCapture(), next)) {
          state.set(next)
        }
      })
    }
    const offDoc = editor.store.listen(
      (change) => {
        if (changesAffectGeometry(change.changes)) schedule()
      },
      { scope: 'document' }
    )
    entry = {
      state,
      dispose: () => {
        offDoc()
        if (frame) cancelAnimationFrame(frame)
      }
    }
    occlusionIndexes.set(editor, entry)
  }
  return entry.state.get().get(shapeId) ?? ''
}

export function disposePortOcclusionIndex(editor: Editor): void {
  const entry = occlusionIndexes.get(editor)
  if (!entry) return
  entry.dispose()
  occlusionIndexes.delete(editor)
}
