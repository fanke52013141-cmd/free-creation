// T07（F07）：运行计划纯函数测试。固化 A03/A04 的计划层判据：
// 全图/选区范围正确、生成请求数可预估、循环体不重复计数。
import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '@shared/types'
import { deriveRunPlan, formatRunPlan } from '@renderer/engine/run-plan'

const node = (id: string, type: string, title = type): CanvasNode =>
  ({
    id,
    type,
    contractVersion: 1,
    title,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [],
    params: {},
    content: { kind: 'text', text: '' },
    exec: 'idle',
    meta: {}
  }) as CanvasNode

const graph = [
  node('text', 'text', '想法'),
  node('gen', 'image-gen', '生图'),
  node('edit', 'image-edit', 'P图'),
  node('iterate', 'iterate', '循环'),
  node('loopBody', 'image-gen', '循环体生图')
]

describe('deriveRunPlan', () => {
  it('全图计划包含全部非循环体节点并统计生成请求数', () => {
    const plan = deriveRunPlan(graph)
    expect(plan.willRun.map((e) => e.id)).toEqual([
      'text',
      'gen',
      'edit',
      'iterate',
      'loopBody'
    ])
    expect(plan.willGenerate.map((e) => e.id)).toEqual(['gen', 'edit', 'loopBody'])
  })

  it('targets 限定范围：只包含目标及其闭包（由调用方求好）', () => {
    const plan = deriveRunPlan(graph, new Set(['text', 'gen']))
    expect(plan.willRun.map((e) => e.id)).toEqual(['text', 'gen'])
    expect(plan.willGenerate).toHaveLength(1)
  })

  it('formatRunPlan 文案区分是否涉及生成模型', () => {
    const plan = deriveRunPlan([node('t', 'text')])
    expect(formatRunPlan(plan)).toContain('不涉及需要调用生成模型的节点')
    const gen = deriveRunPlan(graph, new Set(['gen']))
    expect(formatRunPlan(gen)).toContain('1 个节点会调用生成模型')
  })
})

describe('formatRunPlan', () => {
  it('空计划（空画布）不会被确认弹窗调用，但文案仍可读', () => {
    expect(formatRunPlan({ willRun: [], willGenerate: [] })).toContain('0 个节点')
  })
})
