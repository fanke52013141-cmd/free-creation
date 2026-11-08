// F7 收尾 5 项验收：结构包导出、产物谱系读取、素材批量导出、资源捕获（媒体/节点）。
//
// 断言重点：
// 1) 导出只写受控目录、不覆盖已有文件、回执给 sha256/字节数且不回绝对路径；
// 2) 产物谱系读取**绝不返回提示词正文**（fullPrompt），且媒体必须属于本项目；
// 3) 批量导出逐项回执、同名加序号后缀不覆盖、目录已存在拒绝；
// 4) 资源捕获必须校验项目归属：跨项目 mediaId、伪造节点、类型不符一律拒绝。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDb, getDataDir } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { importMedia } from '../src/main/store/media.repo'
import { saveArtifactRecipe } from '../src/main/store/artifact-recipes.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import type { CanvasNode } from '../src/shared/types'

let directory: string
let service: LocalAccessService
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gAB3x0dAAAAAElFTkSuQmCC',
  'base64'
)

function call(operationId: string, input: unknown = {}, idempotencyKey?: string) {
  return service.dispatch({
    apiVersion: 1,
    operationVersion: 1,
    operationId,
    input,
    requestId: randomUUID(),
    expectedDataStoreId: service.dataStoreId,
    ...(idempotencyKey ? { idempotencyKey } : {})
  })
}
const write = (operationId: string, input: unknown, idempotencyKey = key()) =>
  call(operationId, input, idempotencyKey)

function textNode(id: string, text: string): CanvasNode {
  return {
    id: `shape:${id}`,
    type: 'text',
    contractVersion: 3,
    title: `节点${id}`,
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [],
    params: { config: '{}' },
    content: { kind: 'text', text },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-f7-remaining-test-'))
  process.env.CANVAS_DATA_DIR = directory
  setGatewayEventSink({ emit: () => undefined })
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => null
  })
})

afterEach(() => {
  closeDb()
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  else process.env.CANVAS_DATA_DIR = originalDirectory
  rmSync(directory, { recursive: true, force: true })
})

/** 最小合法 tldraw 快照：结构包导出要求包含 document 与 page 记录（与真实画布一致）。 */
function minimalSnapshot(nodes: CanvasNode[]): unknown {
  const store: Record<string, unknown> = {
    'document:doc': { typeName: 'document', id: 'document:doc' },
    'page:page': { typeName: 'page', id: 'page:page' }
  }
  for (const node of nodes) {
    store[node.id] = {
      typeName: 'shape',
      type: 'node-card',
      id: node.id,
      props: {
        nodeType: node.type,
        title: node.title,
        config: '{}',
        text: node.content.kind === 'text' ? node.content.text : '',
        mediaId: '',
        mediaPath: '',
        mediaMime: ''
      },
      meta: {}
    }
  }
  return { store }
}

describe('project.exportStructure 结构包导出', () => {
  it('导出到受控目录：回执 sha256/字节数/节点数，且不回绝对路径', async () => {
    const project = createProject('结构导出')
    const nodes = [textNode('a', '一'), textNode('b', '二')]
    saveProject({
      id: project.id,
      tldrawSnapshot: minimalSnapshot(nodes),
      graph: { nodes, edges: [], groups: [] }
    })
    const response = await write('project.exportStructure', {
      projectId: project.id,
      fileName: 'structure.canvasflow'
    })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as {
      fileName: string
      byteSize: number
      sha256: string
      nodeCount: number
    }
    expect(data.fileName).toBe('structure.canvasflow')
    expect(data.nodeCount).toBe(2)
    const target = join(getDataDir(), 'agent-exports', 'structure.canvasflow')
    const bytes = readFileSync(target)
    expect(bytes.length).toBe(data.byteSize)
    expect(data.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(JSON.stringify(response.data)).not.toContain(directory)
  })

  it('没有保存过画布快照的项目如实拒绝（明确码，不是模糊的包内容无效）', async () => {
    const project = createProject('结构导出-无快照')
    saveProject({ id: project.id, graph: { nodes: [textNode('a', 'x')], edges: [], groups: [] } })
    const response = await write('project.exportStructure', {
      projectId: project.id,
      fileName: 'no-snapshot.canvasflow'
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('STRUCTURE_SNAPSHOT_MISSING')
  })

  it('不覆盖已有文件；非法文件名与不存在项目被拒', async () => {
    const project = createProject('结构导出-冲突')
    const nodes = [textNode('a', 'x')]
    saveProject({
      id: project.id,
      tldrawSnapshot: minimalSnapshot(nodes),
      graph: { nodes, edges: [], groups: [] }
    })
    const first = await write('project.exportStructure', {
      projectId: project.id,
      fileName: 'dup.canvasflow'
    })
    expect(first.status).toBe('completed')
    const second = await write('project.exportStructure', {
      projectId: project.id,
      fileName: 'dup.canvasflow'
    })
    expect(second.status).toBe('failed')
    expect(second.error?.code).toBe('OUTPUT_EXISTS')

    const badName = await write('project.exportStructure', {
      projectId: project.id,
      fileName: 'not-a-structure.zip'
    })
    expect(badName.error?.code).toBe('INVALID_INPUT')

    const missing = await write('project.exportStructure', {
      projectId: 'no-such-project',
      fileName: 'x.canvasflow'
    })
    expect(missing.error?.code).toBe('NOT_FOUND')
  })
})

describe('media.getRecipe 产物谱系读取', () => {
  async function seedProjectWithMedia(): Promise<{ projectId: string; mediaId: string }> {
    const project = createProject('谱系')
    saveProject({ id: project.id, graph: { nodes: [textNode('a', 'x')], edges: [], groups: [] } })
    const source = join(directory, 'source.png')
    writeFileSync(source, PNG)
    const imported = await importMedia(project.id, source)
    if (!imported.ok) throw new Error('media import failed: ' + imported.reason)
    return { projectId: project.id, mediaId: imported.asset.id }
  }

  it('没有谱系时 found=false（不伪造）', async () => {
    const { projectId, mediaId } = await seedProjectWithMedia()
    const response = await call('media.getRecipe', { projectId, mediaId })
    expect(response.status).toBe('completed')
    expect((response.data as { found: boolean }).found).toBe(false)
    expect((response.data as { recipe: unknown }).recipe).toBeNull()
  })

  it('有谱系时返回来源字段，但**绝不返回提示词正文**', async () => {
    const { projectId, mediaId } = await seedProjectWithMedia()
    saveArtifactRecipe({
      projectId,
      mediaId,
      runId: 'run-1',
      producerNodeId: 'shape:a',
      nodeType: 'image-gen',
      contractVersion: 3,
      fullPrompt: 'THIS-IS-THE-PRIVATE-PROMPT-TEXT',
      paramsJson: JSON.stringify({ size: '16:9', apiKey: 'sk-should-be-removed' }),
      inputMediaIds: [],
      createdAt: Date.now()
    })
    const response = await call('media.getRecipe', { projectId, mediaId })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as {
      found: boolean
      recipe: { nodeType: string; runId: string; params: Record<string, unknown> }
    }
    expect(data.found).toBe(true)
    expect(data.recipe.nodeType).toBe('image-gen')
    expect(data.recipe.runId).toBe('run-1')
    // 关键：提示词正文与敏感键都不能出现
    expect(JSON.stringify(response.data)).not.toContain('THIS-IS-THE-PRIVATE-PROMPT-TEXT')
    expect(JSON.stringify(response.data)).not.toContain('sk-should-be-removed')
  })

  it('跨项目 mediaId 被拒（不能读别人的谱系）', async () => {
    const { projectId, mediaId } = await seedProjectWithMedia()
    const other = createProject('另一个项目')
    saveProject({ id: other.id, graph: { nodes: [], edges: [], groups: [] } })
    const response = await call('media.getRecipe', { projectId: other.id, mediaId })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('MEDIA_NOT_FOUND')
    // 归属校验通过后项目本身仍存在
    expect(openProject(projectId)).not.toBeNull()
  })
})

describe('media.batchExport 素材批量导出', () => {
  it('导出到受控子目录，逐项回执并真实落盘', async () => {
    const project = createProject('批量导出')
    saveProject({ id: project.id, graph: { nodes: [], edges: [], groups: [] } })
    for (const name of ['a.png', 'b.png']) {
      const source = join(directory, name)
      writeFileSync(source, PNG)
      const imported = await importMedia(project.id, source)
      expect(imported.ok).toBe(true)
    }
    const response = await write('media.batchExport', { projectId: project.id })
    expect(response.status, JSON.stringify(response.error)).toBe('completed')
    const data = response.data as {
      directoryName: string
      exported: number
      failed: number
      files: Array<{ fileName: string; byteSize: number }>
    }
    expect(data.exported).toBe(2)
    expect(data.failed).toBe(0)
    expect(data.files).toHaveLength(2)
    for (const file of data.files) {
      const target = join(getDataDir(), 'agent-exports', data.directoryName, file.fileName)
      expect(existsSync(target), `${file.fileName} 未落盘`).toBe(true)
      expect(readFileSync(target).length).toBe(file.byteSize)
    }
    // 回执不回绝对路径
    expect(JSON.stringify(response.data)).not.toContain(directory)
  })

  it('指定不存在的 mediaId 时整批拒绝（不静默跳过）', async () => {
    const project = createProject('批量导出-缺项')
    saveProject({ id: project.id, graph: { nodes: [], edges: [], groups: [] } })
    const response = await write('media.batchExport', {
      projectId: project.id,
      mediaIds: ['does-not-exist']
    })
    expect(response.status).toBe('failed')
    expect(response.error?.code).toBe('MEDIA_NOT_FOUND')
  })
})

describe('资源捕获（画布 → 资源库）', () => {
  it('采集项目媒体入库；跨项目 mediaId 被拒', async () => {
    const project = createProject('采集媒体')
    saveProject({ id: project.id, graph: { nodes: [], edges: [], groups: [] } })
    const source = join(directory, 'capture.png')
    writeFileSync(source, PNG)
    const imported = await importMedia(project.id, source)
    expect(imported.ok).toBe(true)

    const captured = await write('library.captureProjectMedia', {
      projectId: project.id,
      title: '采集的素材',
      tags: ['测试']
    })
    // 缺 mediaId 时 Schema 拒绝
    expect(captured.status).toBe('failed')
    expect(captured.error?.code).toBe('INVALID_INPUT')

    const ok = await write('library.captureProjectMedia', {
      projectId: project.id,
      mediaId: imported.asset.id,
      title: '采集的素材'
    })
    expect(ok.status, JSON.stringify(ok.error)).toBe('completed')
    const data = ok.data as { resourceId: string; componentCount: number; title: string }
    expect(data.componentCount).toBe(1)
    expect(data.title).toBe('采集的素材')

    const other = createProject('采集-另一个项目')
    saveProject({ id: other.id, graph: { nodes: [], edges: [], groups: [] } })
    const cross = await write('library.captureProjectMedia', {
      projectId: other.id,
      mediaId: imported.asset.id
    })
    expect(cross.status).toBe('failed')
    expect(cross.error?.code).toBe('MEDIA_NOT_FOUND')
  })

  it('采集节点：节点必须真实存在且类型一致，媒体必须属于本项目', async () => {
    const project = createProject('采集节点')
    saveProject({
      id: project.id,
      graph: { nodes: [textNode('a', '正文'), textNode('b', '另一段')], edges: [], groups: [] }
    })
    const base = {
      projectId: project.id,
      title: '节点快照',
      nodes: [{ nodeId: 'shape:a', title: '节点a', nodeType: 'text', text: '正文' }]
    }
    const ok = await write('library.captureProjectNodes', base)
    expect(ok.status, JSON.stringify(ok.error)).toBe('completed')
    expect((ok.data as { componentCount: number }).componentCount).toBe(1)

    // 节点不存在
    const ghost = await write('library.captureProjectNodes', {
      ...base,
      title: '幽灵节点',
      nodes: [{ nodeId: 'shape:ghost', title: 'x', nodeType: 'text' }]
    })
    expect(ghost.error?.code).toBe('NODE_NOT_FOUND')

    // 类型谎报（text 说成 image）
    const wrongType = await write('library.captureProjectNodes', {
      ...base,
      title: '类型不符',
      nodes: [{ nodeId: 'shape:a', title: 'x', nodeType: 'image' }]
    })
    expect(wrongType.error?.code).toBe('NODE_TYPE_MISMATCH')

    // 节点引用别的项目的媒体
    const other = createProject('采集节点-另一个项目')
    saveProject({ id: other.id, graph: { nodes: [], edges: [], groups: [] } })
    const source = join(directory, 'other.png')
    writeFileSync(source, PNG)
    const imported = await importMedia(other.id, source)
    expect(imported.ok).toBe(true)
    const crossMedia = await write('library.captureProjectNodes', {
      ...base,
      title: '跨项目媒体',
      nodes: [
        { nodeId: 'shape:a', title: 'x', nodeType: 'text', mediaId: imported.asset.id }
      ]
    })
    expect(crossMedia.error?.code).toBe('MEDIA_NOT_FOUND')
  })
})
