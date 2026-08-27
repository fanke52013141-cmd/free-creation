// @vitest-environment jsdom
// T9 · 示例项目 bundle 结构校验（R0/WP4）
//
// 解析 resources/demo/canvas-studio-demo.canvasbundle，断言：
// - 包结构完整（project.json + bundle.json），ProjectFile 版本兼容
// - 覆盖必需节点类型，五条链路（含批处理链）按声明的端口连通
// - 边的端口在当前注册表中真实存在（用 FakeEditor + deriveGraph 复检无 unknown-port 标记）
// - tldrawSnapshot 结构可迁移（migrateSnapshot 不抛错）、arrow 均有起止绑定、与图数据一致
// - 不含媒体文件与媒体引用（跨机导入 mediaId 重映射缺口，见生成脚本头注释）
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { createTLSchema, createTLStore } from 'tldraw'
import { readZipEntries, type ZipEntry } from './helpers/zip'
import { registerAllNodeTypes } from './helpers/registerNodes'
import { FakeEditor } from './helpers/fakeEditor'
import { deriveGraph } from '@renderer/canvas/graph'
import type { ProjectFile } from '@shared/types'

const BUNDLE = resolve(__dirname, '../resources/demo/canvas-studio-demo.canvasbundle')

interface SnapshotShape {
  id: string
  typeName: 'shape'
  type: string
  x: number
  y: number
  props: Record<string, unknown>
  meta?: Record<string, unknown>
}
interface SnapshotBinding {
  id: string
  typeName: 'binding'
  type: string
  fromId: string
  toId: string
  props: { terminal: 'start' | 'end' }
}

let entries: ZipEntry[]
let file: ProjectFile

beforeAll(() => {
  registerAllNodeTypes()
  entries = readZipEntries(readFileSync(BUNDLE))
  const byName = new Map(entries.map((e) => [e.name, e]))
  file = JSON.parse(byName.get('project.json')!.data.toString('utf-8')) as ProjectFile
})

describe('demo bundle · 包结构', () => {
  it('bundle 文件存在且为有效 zip（project.json + bundle.json）', () => {
    expect(existsSync(BUNDLE)).toBe(true)
    const byName = new Map(entries.map((e) => [e.name, e]))
    expect(byName.has('project.json')).toBe(true)
    const bundleMeta = JSON.parse(byName.get('bundle.json')!.data.toString('utf-8'))
    expect(bundleMeta.projectVersion).toBe(1)
    expect(bundleMeta.projectName).toBe('Canvas Studio 示例项目')
  })

  it('ProjectFile 版本兼容当前导入器（version 1）', () => {
    expect(file.version).toBe(1)
    expect(file.meta.name).toBe('Canvas Studio 示例项目')
  })

  it('不含媒体文件与媒体引用（跨机导入重映射缺口，先避开）', () => {
    const mediaEntries = entries.filter((e) => e.name.startsWith('media/'))
    expect(mediaEntries).toHaveLength(0)
    const shapes = Object.values(
      (file.tldrawSnapshot as { store: Record<string, SnapshotShape> }).store
    ).filter((s) => s.type === 'node-card')
    expect(shapes.every((s) => !s.props.mediaId)).toBe(true)
    expect(file.nodes.every((n) => n.content?.kind !== 'media')).toBe(true)
  })
})

describe('demo bundle · 五条链路', () => {
  const REQUIRED_TYPES = [
    'text',
    'image-gen',
    'chat',
    'json',
    'storyboard',
    'processor',
    'code',
    'iterate',
    'ai-process'
  ]

  it('包含全部必需节点类型', () => {
    const types = new Set(file.nodes.map((n) => n.type))
    for (const t of REQUIRED_TYPES) expect(types.has(t), `缺少节点类型 ${t}`).toBe(true)
    expect(file.nodes).toHaveLength(12)
  })

  /** 断言图中存在 from 节点 portFrom → to 节点 portTo 的边 */
  const chain = (fromTitle: string, portFrom: string, toTitle: string, portTo: string): void => {
    const idByTitle = new Map(file.nodes.map((n) => [n.title, n.id]))
    const fromId = idByTitle.get(fromTitle)!
    const toId = idByTitle.get(toTitle)!
    expect(fromId, `节点不存在：${fromTitle}`).toBeDefined()
    expect(toId, `节点不存在：${toTitle}`).toBeDefined()
    const hit = file.edges.find(
      (e) =>
        e.from.nodeId === fromId &&
        e.from.portId === portFrom &&
        e.to.nodeId === toId &&
        e.to.portId === portTo
    )
    expect(hit, `${fromTitle}(${portFrom}) → ${toTitle}(${portTo}) 未连通`).toBeDefined()
  }

  it('链 1：文本 → 生图', () => chain('① 生图提示词', 'out-text', '① 生图', 'in-text'))
  it('链 2：文本 → 对话 → JSON', () => {
    chain('② 对话提问', 'out-text', '② 对话', 'in-text')
    chain('② 对话', 'out-markdown', '② 结果 JSON', 'in-text')
  })
  it('链 3：JSON → 分镜', () => chain('③ 分镜数据', 'out-json', '③ 分镜板', 'in-json'))
  it('链 4/5：处理 → 代码 → 循环 → AI 处理 → 生图（批处理）', () => {
    chain('④ 主题列表', 'out-value', '④ 规整列表', 'in-json')
    chain('④ 规整列表', 'out-json', '⑤ 批量循环', 'in-list')
    chain('⑤ 批量循环', 'out-items', '⑤ 逐项写提示词', 'in-json')
    chain('⑤ 逐项写提示词', 'out-text', '⑤ 批量生图', 'in-text')
  })
})

describe('demo bundle · 端口契约真实有效', () => {
  it('快照重建图后 deriveGraph 无 unknown-port 标记（边端口都在当前注册表内）', () => {
    const snap = file.tldrawSnapshot as { store: Record<string, SnapshotShape | SnapshotBinding> }
    // binding 记录也有 type:'arrow' 字段，必须按 typeName 区分，不能按 type 过滤
    const shapes = Object.values(snap.store).filter(
      (r): r is SnapshotShape => r.typeName === 'shape'
    )
    const bindings = Object.values(snap.store).filter(
      (r): r is SnapshotBinding => r.typeName === 'binding'
    )

    const ed = new FakeEditor()
    for (const s of shapes) {
      if (s.type === 'node-card') ed.addNode(s.id, s.props, s.x, s.y)
    }
    for (const arrow of shapes.filter((s) => s.type === 'arrow')) {
      const start = bindings.find(
        (b) => b.fromId === arrow.id && b.props.terminal === 'start'
      )?.toId
      const end = bindings.find((b) => b.fromId === arrow.id && b.props.terminal === 'end')?.toId
      expect(start, `箭头 ${arrow.id} 缺少 start 绑定`).toBeDefined()
      expect(end, `箭头 ${arrow.id} 缺少 end 绑定`).toBeDefined()
      ed.addArrow(
        arrow.id,
        arrow.meta!.fromPort as string,
        arrow.meta!.toPort as string,
        start!,
        end!
      )
    }

    const graph = deriveGraph(ed.asEditor())
    expect(graph.nodes).toHaveLength(12)
    expect(graph.edges).toHaveLength(8)
    const flagged = graph.edges.filter((e) => e.meta?.flagged === 'unknown-port')
    expect(flagged, `存在未知端口边：${flagged.map((e) => e.id).join(', ')}`).toHaveLength(0)
  })

  it('快照记录与图数据一致（shape id 与 node id 一一对应）', () => {
    const snap = file.tldrawSnapshot as { store: Record<string, SnapshotShape> }
    const shapeIds = new Set(
      Object.values(snap.store)
        .filter((s) => s.type === 'node-card')
        .map((s) => s.id)
    )
    expect(shapeIds.size).toBe(file.nodes.length)
    for (const n of file.nodes) expect(shapeIds.has(n.id)).toBe(true)
  })

  it('快照可被 tldraw 迁移管线接受（migrateSnapshot 不抛错）', () => {
    const store = createTLStore({ schema: createTLSchema() })
    expect(() => store.migrateSnapshot(file.tldrawSnapshot as never)).not.toThrow()
  })
})
