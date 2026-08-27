// @vitest-environment jsdom
// T4 · inspectProjectFile 预检测试（R0/WP2）
//
// 五类输入：未知 nodeType / 未知 portId / 高 contractVersion / 非 v1 文件 / 正常文件。
// 断言警告内容与分级，且纯函数不修改原数据。
import { describe, it, expect, beforeAll } from 'vitest'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { inspectProjectFile } from '@renderer/nodes/migrations/legacy'
import type { CanvasEdge, CanvasNode, ProjectFile } from '@shared/types'

beforeAll(() => {
  registerAllNodeTypes()
})

function node(over: Partial<CanvasNode>): CanvasNode {
  return {
    id: over.id ?? 'shape:1',
    type: over.type ?? 'text',
    contractVersion: over.contractVersion ?? 1,
    title: over.title ?? '节点',
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: over.ports ?? [],
    params: {},
    content: { kind: 'text', text: '' },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 0 },
    ...over
  }
}

function edge(
  id: string,
  from: { nodeId: string; portId: string },
  to: { nodeId: string; portId: string }
): CanvasEdge {
  return { id, from, to }
}

function file(
  over: Partial<ProjectFile> & { nodes?: CanvasNode[]; edges?: CanvasEdge[] }
): ProjectFile {
  return {
    version: over.version ?? 1,
    meta: over.meta ?? {
      id: 'p1',
      name: '测试项目',
      createdAt: 0,
      updatedAt: 0,
      graphVersion: 1
    },
    nodes: over.nodes ?? [],
    edges: over.edges ?? [],
    groups: [],
    tldrawSnapshot: undefined
  }
}

describe('inspectProjectFile · 未知 nodeType', () => {
  it('未注册类型产出警告（冻结占位建议）', () => {
    const warnings = inspectProjectFile(
      file({ nodes: [node({ id: 'shape:x', type: 'future-node' as never, title: '神秘节点' })] })
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0].level).toBe('warn')
    expect(warnings[0].nodeType).toBe('future-node')
    expect(warnings[0].message).toContain('future-node')
    expect(warnings[0].suggestion).toContain('冻结')
  })

  it('已退役旧类型（compose/group）不误报：由迁移逻辑处理', () => {
    const warnings = inspectProjectFile(
      file({
        nodes: [
          node({ id: 'shape:c', type: 'compose' as never }),
          node({ id: 'shape:g', type: 'group' as never })
        ]
      })
    )
    expect(warnings).toHaveLength(0)
  })
})

describe('inspectProjectFile · 未知 portId', () => {
  it('边引用当前版本不存在的输入/输出端口产出端口级警告', () => {
    const warnings = inspectProjectFile(
      file({
        nodes: [node({ id: 'shape:a', type: 'text' }), node({ id: 'shape:b', type: 'image-gen' })],
        edges: [
          edge(
            'shape:e1',
            { nodeId: 'shape:a', portId: 'out-gone' },
            { nodeId: 'shape:b', portId: 'in-text' }
          ),
          edge(
            'shape:e2',
            { nodeId: 'shape:a', portId: 'out-text' },
            { nodeId: 'shape:b', portId: 'in-nowhere' }
          )
        ]
      })
    )
    expect(warnings).toHaveLength(2)
    const fromWarn = warnings.find((w) => w.edgeId === 'shape:e1')
    expect(fromWarn?.portId).toBe('out-gone')
    expect(fromWarn?.message).toContain('out-gone')
    const toWarn = warnings.find((w) => w.edgeId === 'shape:e2')
    expect(toWarn?.portId).toBe('in-nowhere')
  })

  it('边引用不存在的节点产出严重警告', () => {
    const warnings = inspectProjectFile(
      file({
        nodes: [node({ id: 'shape:a', type: 'text' })],
        edges: [
          edge(
            'shape:e',
            { nodeId: 'shape:ghost', portId: 'out-text' },
            { nodeId: 'shape:a', portId: 'in-text' }
          )
        ]
      })
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0].level).toBe('error')
    expect(warnings[0].nodeId).toBe('shape:ghost')
  })

  it('合法端口引用不产出警告', () => {
    const warnings = inspectProjectFile(
      file({
        nodes: [node({ id: 'shape:a', type: 'text' }), node({ id: 'shape:b', type: 'image-gen' })],
        edges: [
          edge(
            'shape:e',
            { nodeId: 'shape:a', portId: 'out-text' },
            { nodeId: 'shape:b', portId: 'in-text' }
          )
        ]
      })
    )
    expect(warnings).toHaveLength(0)
  })
})

describe('inspectProjectFile · 高版本 contractVersion', () => {
  it('节点契约版本高于注册表产出警告', () => {
    const warnings = inspectProjectFile(
      file({
        nodes: [node({ id: 'shape:v', type: 'text', contractVersion: 99, title: '新版本节点' })]
      })
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('99')
    expect(warnings[0].suggestion).toContain('检查连线')
  })

  it('契约版本等于注册表不警告', () => {
    expect(
      inspectProjectFile(file({ nodes: [node({ type: 'text', contractVersion: 1 })] }))
    ).toHaveLength(0)
  })
})

describe('inspectProjectFile · 非 v1 文件', () => {
  it('版本号非 1 产出严重警告', () => {
    const warnings = inspectProjectFile(file({ version: 2 as never }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0].level).toBe('error')
    expect(warnings[0].message).toContain('v2')
  })
})

describe('inspectProjectFile · 纯函数约束', () => {
  it('不修改原数据', () => {
    const src = file({
      version: 2 as never,
      nodes: [node({ id: 'shape:x', type: 'future-node' as never })]
    })
    const snapshot = JSON.stringify(src)
    inspectProjectFile(src)
    expect(JSON.stringify(src)).toBe(snapshot)
  })
})
