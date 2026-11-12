import { describe, expect, it } from 'vitest'
import {
  detectAgentFlow,
  layoutGraph,
  type LayoutEdge,
  type LayoutNode
} from '../src/shared/flow-layout'

/** 默认节点尺寸与主画布 NODE_UI 一致（340×300）。 */
function mk(
  id: string,
  type: string,
  title: string,
  x = 0,
  y = 0,
  extra: Partial<Pick<LayoutNode, 'w' | 'h' | 'role' | 'controls'>> = {}
): LayoutNode {
  return { id, type, title, x, y, w: 340, h: 300, ...extra }
}

function rectOverlap(a: LayoutNode & { x: number; y: number }, b: LayoutNode & { x: number; y: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function positioned(nodes: LayoutNode[], result: ReturnType<typeof layoutGraph>) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return result.positions.map((p) => ({ ...byId.get(p.id)!, x: p.x, y: p.y }))
}

function assertNoOverlap(nodes: LayoutNode[], result: ReturnType<typeof layoutGraph>): void {
  const placed = positioned(nodes, result)
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++)
      expect(rectOverlap(placed[i]!, placed[j]!), `${placed[i]!.id} × ${placed[j]!.id}`).toBe(false)
}

/** 验证 flow 夹具：状态机+主控+4 专家+5 processor（素材源→选题→资料→框架→文章）+审核。 */
function verificationFlow(): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const nodes: LayoutNode[] = [
    mk('sm', 'state-machine', '状态机', 900, 800),
    mk('coord', 'agent', '主控', 100, 50, { role: 'coordinator' }),
    mk('s1', 'agent', '选题专家', 700, 300, { role: 'specialist', controls: ['p1'] }),
    mk('s2', 'agent', '资料专家', 200, 600, { role: 'specialist', controls: ['p2'] }),
    mk('s3', 'agent', '框架专家', 500, 100, { role: 'specialist', controls: ['p3'] }),
    mk('s4', 'agent', '写作专家', 300, 400, { role: 'specialist', controls: ['p4'] }),
    mk('p0', 'processor', '素材源', 0, 0),
    mk('p1', 'processor', '选题', 400, 200),
    mk('p2', 'processor', '资料', 800, 400),
    mk('p3', 'processor', '框架', 1200, 600),
    mk('p4', 'processor', '文章', 1600, 800),
    mk('rev', 'ai-review', '审核', 1000, 1000, { controls: ['p4'] })
  ]
  const edges: LayoutEdge[] = [
    { from: 'p0', to: 'p1' },
    { from: 'p1', to: 'p2' },
    { from: 'p2', to: 'p3' },
    { from: 'p3', to: 'p4' }
  ]
  return { nodes, edges }
}

describe('flow-layout 确定性', () => {
  it('同输入两次输出逐字节相等', () => {
    const { nodes, edges } = verificationFlow()
    const a = layoutGraph(nodes, edges, 'lanes')
    const b = layoutGraph(nodes, edges, 'lanes')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('节点/边输入顺序打乱不影响 flow 与 lanes 结果', () => {
    const { nodes, edges } = verificationFlow()
    for (const mode of ['flow', 'lanes'] as const) {
      const base = layoutGraph(nodes, edges, mode)
      const shuffled = layoutGraph([...nodes].reverse(), [...edges].reverse(), mode)
      const toMap = (r: typeof base) => Object.fromEntries(r.positions.map((p) => [p.id, p]))
      expect(toMap(shuffled)).toEqual(toMap(base))
    }
  })

  it('坐标为整数', () => {
    const { nodes, edges } = verificationFlow()
    for (const mode of ['flow', 'lanes', 'grid'] as const) {
      for (const p of layoutGraph(nodes, edges, mode).positions) {
        expect(Number.isInteger(p.x)).toBe(true)
        expect(Number.isInteger(p.y)).toBe(true)
      }
    }
  })
})

describe('flow 分层布局', () => {
  it('链式 A→B→C：rank 0/1/2，x 严格递增，零重叠', () => {
    const nodes = [mk('a', 'text', 'A', 50, 50), mk('b', 'text', 'B', 0, 0), mk('c', 'text', 'C', 900, 900)]
    const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]
    const result = layoutGraph(nodes, edges, 'flow')
    expect(result.mode).toBe('flow')
    expect(result.ranks).toEqual({ a: 0, b: 1, c: 2 })
    const byId = Object.fromEntries(result.positions.map((p) => [p.id, p]))
    expect(byId.a.x).toBeLessThan(byId.b.x)
    expect(byId.b.x).toBeLessThan(byId.c.x)
    assertNoOverlap(nodes, result)
  })

  it('菱形 A→(B,C)→D：B/C 同列，全部边前向，零重叠', () => {
    const nodes = [mk('a', 'text', 'A'), mk('b', 'text', 'B'), mk('c', 'text', 'C'), mk('d', 'text', 'D')]
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' }
    ]
    const result = layoutGraph(nodes, edges, 'flow')
    expect(result.ranks.b).toBe(result.ranks.c)
    for (const edge of edges) expect(result.ranks[edge.from]).toBeLessThan(result.ranks[edge.to])
    assertNoOverlap(nodes, result)
  })

  it('混合高度 300/360/420/600 与宽节点 880 无重叠', () => {
    const nodes = [
      mk('a', 'text', 'A', 0, 0, { h: 300 }),
      mk('b', 'image-gen', 'B', 0, 0, { h: 420 }),
      mk('c', 'video', 'C', 0, 0, { h: 600 }),
      mk('d', 'timeline', 'D', 0, 0, { w: 880, h: 291 }),
      mk('e', 'text', 'E', 0, 0, { h: 360 })
    ]
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'e' },
      { from: 'd', to: 'e' }
    ]
    assertNoOverlap(nodes, layoutGraph(nodes, edges, 'flow'))
  })

  it('默认 origin 保持输入包围盒左上角', () => {
    const nodes = [mk('a', 'text', 'A', 123, 456), mk('b', 'text', 'B', 999, 999)]
    const result = layoutGraph(nodes, [{ from: 'a', to: 'b' }], 'flow')
    expect(Math.min(...result.positions.map((p) => p.x))).toBe(123)
    expect(Math.min(...result.positions.map((p) => p.y))).toBe(456)
  })

  it('显式 origin 生效', () => {
    const nodes = [mk('a', 'text', 'A'), mk('b', 'text', 'B')]
    const result = layoutGraph(nodes, [{ from: 'a', to: 'b' }], 'flow', { origin: { x: -500, y: 200 } })
    expect(Math.min(...result.positions.map((p) => p.x))).toBe(-500)
    expect(Math.min(...result.positions.map((p) => p.y))).toBe(200)
  })
})

describe('环 / 孤立 / 空图 / 单节点', () => {
  it('A→B→A 不崩溃且环内同层', () => {
    const nodes = [mk('a', 'text', 'A'), mk('b', 'text', 'B')]
    const result = layoutGraph(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], 'flow')
    expect(result.ranks.a).toBe(result.ranks.b)
    assertNoOverlap(nodes, result)
  })

  it('自环不崩溃', () => {
    const nodes = [mk('a', 'text', 'A'), mk('b', 'text', 'B')]
    const result = layoutGraph(nodes, [{ from: 'a', to: 'a' }, { from: 'a', to: 'b' }], 'flow')
    expect(result.positions).toHaveLength(2)
  })

  it('孤立节点排最右列', () => {
    const nodes = [mk('a', 'text', 'A'), mk('b', 'text', 'B'), mk('lonely', 'text', '孤立')]
    const result = layoutGraph(nodes, [{ from: 'a', to: 'b' }], 'flow')
    const byId = Object.fromEntries(result.positions.map((p) => [p.id, p]))
    expect(byId.lonely.x).toBeGreaterThan(byId.b.x)
  })

  it('空图返回空结果', () => {
    const result = layoutGraph([], [], 'auto')
    expect(result.positions).toEqual([])
  })

  it('单节点保持原位', () => {
    const result = layoutGraph([mk('a', 'text', 'A', 77, 88)], [], 'auto')
    expect(result.positions).toEqual([{ id: 'a', x: 77, y: 88 }])
  })

  it('未知端点的边被忽略不崩溃', () => {
    const nodes = [mk('a', 'text', 'A'), mk('b', 'text', 'B')]
    const result = layoutGraph(nodes, [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'b' }], 'flow')
    expect(result.ranks.b).toBe(1)
  })
})

describe('lanes 角色泳道', () => {
  it('detectAgentFlow 识别三类节点', () => {
    expect(detectAgentFlow([mk('a', 'agent', 'A')])).toBe(true)
    expect(detectAgentFlow([mk('a', 'state-machine', 'A')])).toBe(true)
    expect(detectAgentFlow([mk('a', 'ai-review', 'A')])).toBe(true)
    expect(detectAgentFlow([mk('a', 'text', 'A'), mk('b', 'processor', 'B')])).toBe(false)
  })

  it('验证 flow：带序正确、processor 链左→右、专家对齐 target、零重叠', () => {
    const { nodes, edges } = verificationFlow()
    const result = layoutGraph(nodes, edges, 'lanes')
    expect(result.mode).toBe('lanes')
    expect(result.lanes.sm).toBe('control')
    expect(result.lanes.coord).toBe('control')
    expect(result.lanes.s1).toBe('execution')
    expect(result.lanes.p0).toBe('output')
    expect(result.lanes.rev).toBe('review')

    const byId = Object.fromEntries(result.positions.map((p) => [p.id, p]))
    // 带序：control 全在 execution 上方，execution 全在 output 上方，output 全在 review 上方。
    const maxY = (ids: string[]) => Math.max(...ids.map((id) => byId[id].y + 300))
    const minY = (ids: string[]) => Math.min(...ids.map((id) => byId[id].y))
    expect(maxY(['sm', 'coord'])).toBeLessThan(minY(['s1', 's2', 's3', 's4']))
    expect(maxY(['s1', 's2', 's3', 's4'])).toBeLessThan(minY(['p0', 'p1', 'p2', 'p3', 'p4']))
    expect(maxY(['p0', 'p1', 'p2', 'p3', 'p4'])).toBeLessThan(minY(['rev']))
    // 成果链 x 严格递增（看得见的流程）。
    for (const [prev, next] of [['p0', 'p1'], ['p1', 'p2'], ['p2', 'p3'], ['p3', 'p4']] as const)
      expect(byId[prev].x).toBeLessThan(byId[next].x)
    // 专家中心对齐其 target 中心（±40px）。
    for (const [specialist, target] of [['s1', 'p1'], ['s2', 'p2'], ['s3', 'p3'], ['s4', 'p4']] as const)
      expect(Math.abs(byId[specialist].x + 170 - (byId[target].x + 170))).toBeLessThanOrEqual(40)
    // 审核对齐被门禁节点。
    expect(Math.abs(byId.rev.x - byId.p4.x)).toBeLessThanOrEqual(40)
    // 成果带 rank 即数据链层级。
    expect(result.ranks.p0).toBe(0)
    expect(result.ranks.p4).toBe(4)
    assertNoOverlap(nodes, result)
  })

  it('specialist 无 controls：排到成果带右侧且不重叠', () => {
    const { nodes, edges } = verificationFlow()
    const stray = mk('s5', 'agent', '游离专家', 0, 0, { role: 'specialist' })
    const result = layoutGraph([...nodes, stray], edges, 'lanes')
    const byId = Object.fromEntries(result.positions.map((p) => [p.id, p]))
    expect(byId.s5.x).toBeGreaterThan(byId.p4.x)
    assertNoOverlap([...nodes, stray], result)
  })

  it('一个 specialist 控制多个 target：对齐重心', () => {
    const nodes = [
      mk('coord', 'agent', '主控', 0, 0, { role: 'coordinator' }),
      mk('s1', 'agent', '多面手', 0, 0, { role: 'specialist', controls: ['p1', 'p2'] }),
      mk('p1', 'processor', '成果一', 0, 0),
      mk('p2', 'processor', '成果二', 0, 0)
    ]
    const result = layoutGraph(nodes, [{ from: 'p1', to: 'p2' }], 'lanes')
    const byId = Object.fromEntries(result.positions.map((p) => [p.id, p]))
    const targetCenter = (byId.p1.x + byId.p2.x + 340) / 2
    expect(Math.abs(byId.s1.x + 170 - targetCenter)).toBeLessThanOrEqual(40)
    assertNoOverlap(nodes, result)
  })

  it('两个 specialist 同 target：水平错开不重叠', () => {
    const nodes = [
      mk('s1', 'agent', '专家甲', 0, 0, { role: 'specialist', controls: ['p1'] }),
      mk('s2', 'agent', '专家乙', 0, 0, { role: 'specialist', controls: ['p1'] }),
      mk('p1', 'processor', '成果', 0, 0)
    ]
    const result = layoutGraph(nodes, [], 'lanes')
    assertNoOverlap(nodes, result)
  })

  it('无成果节点：执行带自身分层', () => {
    const nodes = [
      mk('sm', 'state-machine', '状态机', 0, 0),
      mk('s1', 'agent', '专家一', 0, 0, { role: 'specialist' }),
      mk('s2', 'agent', '专家二', 0, 0, { role: 'specialist' })
    ]
    const result = layoutGraph(nodes, [{ from: 's1', to: 's2' }], 'lanes')
    const byId = Object.fromEntries(result.positions.map((p) => [p.id, p]))
    expect(byId.s1.x).toBeLessThan(byId.s2.x)
    assertNoOverlap(nodes, result)
  })

  it('builder 并行三分支：8 节点坐标互不相同（带内分层不被带堆叠覆盖）', () => {
    // 复现 agent-flow-builder parallel-fork 场景：主控+状态机+3 专家+3 孤立 target。
    const nodes = [
      mk('main', 'agent', '主控', 0, 0, { role: 'coordinator' }),
      mk('state', 'state-machine', '状态机', 0, 0),
      mk('a1', 'agent', '摘要', 0, 0, { role: 'specialist', controls: ['t1'] }),
      mk('a2', 'agent', '要点', 0, 0, { role: 'specialist', controls: ['t2'] }),
      mk('a3', 'agent', '标签', 0, 0, { role: 'specialist', controls: ['t3'] }),
      mk('t1', 'processor', '摘要成果', 0, 0),
      mk('t2', 'processor', '要点成果', 0, 0),
      mk('t3', 'processor', '标签成果', 0, 0)
    ]
    const result = layoutGraph(nodes, [], 'lanes')
    expect(new Set(result.positions.map((p) => `${p.x},${p.y}`)).size).toBe(nodes.length)
    assertNoOverlap(nodes, result)
  })

  it('无状态机/无审核也能布局', () => {
    const nodes = [
      mk('coord', 'agent', '主控', 0, 0, { role: 'coordinator' }),
      mk('s1', 'agent', '专家', 0, 0, { role: 'specialist', controls: ['p1'] }),
      mk('p1', 'processor', '成果', 0, 0)
    ]
    const result = layoutGraph(nodes, [], 'lanes')
    expect(result.positions).toHaveLength(3)
    assertNoOverlap(nodes, result)
  })

  it('builder 角色归控制带', () => {
    const nodes = [
      mk('b', 'agent', '搭建', 0, 0, { role: 'builder' }),
      mk('s1', 'agent', '专家', 0, 0, { role: 'specialist' }),
      mk('p1', 'processor', '成果', 0, 0)
    ]
    const result = layoutGraph(nodes, [], 'lanes')
    expect(result.lanes.b).toBe('control')
  })
})

describe('grid 兜底与 auto 模式', () => {
  it('grid 与旧 organizeCanvas 算法同口径', () => {
    // 旧算法内联复现（CanvasMinimap.organizeCanvas 原样），对比共享实现。
    const nodes = [
      mk('a', 'text', 'A', 100, 100),
      mk('b', 'text', 'B', 500, 120),
      mk('c', 'text', 'C', 100, 500),
      mk('d', 'text', 'D', 500, 520),
      mk('e', 'text', 'E', 300, 900)
    ]
    const sorted = [...nodes].sort((a, b) => {
      const ay = a.y + a.h / 2
      const by = b.y + b.h / 2
      if (Math.abs(ay - by) < 80) return a.x - b.x
      return ay - by
    })
    const GAP_X = 60
    const GAP_Y = 80
    const COLS = Math.max(1, Math.ceil(Math.sqrt(sorted.length)))
    const startX = sorted[0]!.x
    const startY = sorted[0]!.y
    const colWidths = Array.from({ length: COLS }, (_, col) =>
      Math.max(...sorted.filter((_, i) => i % COLS === col).map((s) => s.w))
    )
    const rowCount = Math.ceil(sorted.length / COLS)
    const rowHeights = Array.from({ length: rowCount }, (_, row) =>
      Math.max(...sorted.slice(row * COLS, (row + 1) * COLS).map((s) => s.h))
    )
    const colOffsets = colWidths.map((_, col) =>
      colWidths.slice(0, col).reduce((sum, width) => sum + width + GAP_X, 0)
    )
    const rowOffsets = rowHeights.map((_, row) =>
      rowHeights.slice(0, row).reduce((sum, height) => sum + height + GAP_Y, 0)
    )
    const expected = sorted.map((s, index) => ({
      id: s.id,
      x: startX + colOffsets[index % COLS]!,
      y: startY + rowOffsets[Math.floor(index / COLS)]!
    }))
    expect(layoutGraph(nodes, [], 'grid').positions).toEqual(expected)
  })

  it('auto：agent flow → lanes；纯 DAG → flow；无边 → grid', () => {
    const { nodes, edges } = verificationFlow()
    expect(layoutGraph(nodes, edges, 'auto').mode).toBe('lanes')
    const dag = [mk('a', 'text', 'A'), mk('b', 'text', 'B')]
    expect(layoutGraph(dag, [{ from: 'a', to: 'b' }], 'auto').mode).toBe('flow')
    expect(layoutGraph(dag, [], 'auto').mode).toBe('grid')
  })

  it('grid 零重叠（真实尺寸）', () => {
    const nodes = Array.from({ length: 9 }, (_, i) =>
      mk(`n${i}`, 'text', `N${i}`, i * 37, i * 53, { h: i % 2 === 0 ? 300 : 420 })
    )
    assertNoOverlap(nodes, layoutGraph(nodes, [], 'grid'))
  })
})