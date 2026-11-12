import { FLOW_LAYOUT_DEFAULTS, type LayoutNode, type LayoutOptions } from './types'

export interface CoordinateAssignment {
  positions: Array<{ id: string; x: number; y: number }>
  /** 各层左上角 x（验收用） */
  layerX: number[]
  /** 最高列总高（垂直居中基准） */
  maxHeight: number
}

/**
 * 坐标分配（Sugiyama 第三步）：真实节点尺寸。
 * x = 累计列宽（每列取该层最大 w）+ columnGap；
 * y = 层内按真实 h 堆叠 + rowGap，整层垂直居中到最高列的中线。
 * 输出整数坐标，保证确定性断言稳定。
 */
export function assignCoordinates(
  layers: readonly string[][],
  nodes: readonly LayoutNode[],
  origin: { x: number; y: number },
  opts: LayoutOptions = {}
): CoordinateAssignment {
  const columnGap = opts.columnGap ?? FLOW_LAYOUT_DEFAULTS.columnGap
  const rowGap = opts.rowGap ?? FLOW_LAYOUT_DEFAULTS.rowGap
  const byId = new Map(nodes.map((node) => [node.id, node]))

  const colWidths = layers.map((layer) =>
    Math.max(...layer.map((id) => byId.get(id)?.w ?? 0), 0)
  )
  const layerHeights = layers.map((layer) => {
    const heights = layer.map((id) => byId.get(id)?.h ?? 0)
    return heights.reduce((sum, h) => sum + h, 0) + Math.max(0, layer.length - 1) * rowGap
  })
  const maxHeight = Math.max(...layerHeights, 0)

  const layerX: number[] = []
  let cursor = origin.x
  for (const width of colWidths) {
    layerX.push(cursor)
    cursor += width + columnGap
  }

  const positions: Array<{ id: string; x: number; y: number }> = []
  for (const [r, layer] of layers.entries()) {
    let y = origin.y + (maxHeight - (layerHeights[r] ?? 0)) / 2
    for (const id of layer) {
      const node = byId.get(id)
      positions.push({ id, x: Math.round(layerX[r] ?? origin.x), y: Math.round(y) })
      y += (node?.h ?? 0) + rowGap
    }
  }
  return { positions, layerX, maxHeight }
}