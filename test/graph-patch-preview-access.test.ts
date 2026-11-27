import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeDb, getDb } from '../src/main/store/db'
import * as projects from '../src/main/store/projects.repo'
import {
  buildGraphPatchPreview,
  getGraphPatchPreview,
  listGraphPatchPreviews,
  saveGraphPatchPreview,
  updateGraphPatchPreviewState
} from '../src/main/agent-access/graph-patch-preview'
import { LocalAccessService } from '../src/main/agent-access/service'
import type { AccessDesktop } from '../src/main/agent-access/desktop'
import * as licenseGate from '../src/main/security/license/gate'

describe('graph.patch.propose / confirm / discard (方案 A 全节点幽灵预览与人工确认)', () => {
  let dataDir: string
  const originalDataDir = process.env.CANVAS_DATA_DIR

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'canvas-patch-preview-'))
    process.env.CANVAS_DATA_DIR = dataDir
    getDb()
    vi.spyOn(licenseGate, 'assertLicenseActive').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    closeDb()
    if (originalDataDir === undefined) delete process.env.CANVAS_DATA_DIR
    else process.env.CANVAS_DATA_DIR = originalDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('builds and persists ghost preview across all node types including ai-process/video/silence-trim', () => {
    const meta = projects.createProject('方案A预览测试')
    const file = projects.openProject(meta.id)!
    const preview = buildGraphPatchPreview({
      projectId: meta.id,
      name: '短片生产链',
      expectedGraphVersion: file.meta.graphVersion,
      autoLayout: true,
      ops: [
        { action: 'node.create', ref: 'script', nodeType: 'ai-process', title: '写脚本', x: 0, y: 0 },
        { action: 'node.create', ref: 'vid', nodeType: 'video', title: '生视频', x: 100, y: 0 },
        { action: 'node.create', ref: 'trim', nodeType: 'silence-trim', title: '去气口', x: 200, y: 0 },
        {
          action: 'edge.create',
          from: { nodeId: 'script', portId: 'out-text' },
          to: { nodeId: 'vid', portId: 'in-text' }
        }
      ],
      currentFile: file
    })

    expect(preview.nodes).toHaveLength(3)
    expect(preview.edges).toHaveLength(1)
    expect(preview.edges[0].from.nodeId).toBe('preview:script')
    expect(preview.edges[0].to.nodeId).toBe('preview:vid')
    expect(preview.summary).toEqual({
      nodeCreated: 3,
      nodeUpdated: 0,
      nodeDeleted: 0,
      edgeCreated: 1,
      edgeDeleted: 0
    })
    expect(preview.updatedNodeIds).toEqual([])
    expect(preview.deletedNodeIds).toEqual([])

    const diffPreview = buildGraphPatchPreview({
      projectId: meta.id,
      expectedGraphVersion: file.meta.graphVersion,
      autoLayout: false,
      ops: [
        { action: 'node.update', nodeId: 'shape:existing-a', title: '改标题' },
        { action: 'node.update', nodeId: 'shape:existing-b', text: '准备删掉前先改' },
        { action: 'node.delete', nodeId: 'shape:existing-b' }
      ],
      currentFile: file
    })
    expect(diffPreview.updatedNodeIds).toEqual(['shape:existing-a'])
    expect(diffPreview.deletedNodeIds).toEqual(['shape:existing-b'])

    const db = getDb()
    saveGraphPatchPreview(db, preview)
    expect(getGraphPatchPreview(db, meta.id, preview.buildId)?.name).toBe('短片生产链')
    expect(listGraphPatchPreviews(db, meta.id)).toHaveLength(1)

    const committed = updateGraphPatchPreviewState(db, meta.id, preview.buildId, 'committed')
    expect(committed?.state).toBe('committed')
    // 已提交的预览不可被回退为 discarded
    const afterDiscard = updateGraphPatchPreviewState(db, meta.id, preview.buildId, 'discarded')
    expect(afterDiscard?.state).toBe('committed')
  })

  it('enforces zero mutation on propose, BL-01 human gate on confirm, and idempotent discard', async () => {
    const meta = projects.createProject('外部人工门禁测试')
    const runSpy = vi.fn()
    const askSpy = vi.fn()
    const desktop: AccessDesktop = {
      ask: askSpy,
      run: runSpy
    } as unknown as AccessDesktop

    const service = new LocalAccessService({
      dataDirectory: dataDir,
      appVersion: '1.0.0',
      instanceId: 'test-instance',
      exportDirectory: join(dataDir, 'exports'),
      activeProjectId: () => meta.id,
      desktop
    })

    // 1. propose: zero mutation to canvas, returns previewId
    const proposed = await service.dispatch({
      apiVersion: 1,
      operationVersion: 1,
      expectedDataStoreId: service.dataStoreId,
      requestId: randomUUID(),
      idempotencyKey: `${Date.now()}:${randomUUID()}`,
      operationId: 'graph.patch.propose',
      input: {
        projectId: meta.id,
        expectedGraphVersion: meta.graphVersion,
        name: '文案转图',
        autoLayout: true,
        ops: [
          { action: 'node.create', ref: 't1', nodeType: 'text', title: '输入文案', x: 0, y: 0, text: 'hello' },
          { action: 'node.create', ref: 'img1', nodeType: 'image-gen', title: '生图', x: 400, y: 0 },
          {
            action: 'edge.create',
            from: { nodeId: 't1', portId: 'out-text' },
            to: { nodeId: 'img1', portId: 'in-text' }
          }
        ]
      }
    })
    expect(proposed.status, JSON.stringify(proposed)).toBe('completed')
    expect(runSpy).not.toHaveBeenCalled()
    const previewId = (proposed.data as { previewId: string }).previewId
    expect(previewId).toMatch(/^patch:/)

    // 2. confirm denied by human -> HUMAN_DENIED & zero desktop.run side effects
    askSpy.mockResolvedValueOnce({ authorized: false, code: 'HUMAN_DENIED' })
    const denied = await service.dispatch({
      apiVersion: 1,
      operationVersion: 1,
      expectedDataStoreId: service.dataStoreId,
      requestId: randomUUID(),
      idempotencyKey: `${Date.now()}:${randomUUID()}`,
      operationId: 'graph.patch.confirm',
      input: { projectId: meta.id, previewId }
    })
    expect(denied.status).toBe('failed')
    expect(denied.error?.code).toBe('HUMAN_DENIED')
    expect(runSpy).not.toHaveBeenCalled()
    expect(getGraphPatchPreview(getDb(), meta.id, previewId)?.state).toBe('preview')

    // 3. discard -> transitions to discarded; subsequent confirm rejected
    const discarded = await service.dispatch({
      apiVersion: 1,
      operationVersion: 1,
      expectedDataStoreId: service.dataStoreId,
      requestId: randomUUID(),
      idempotencyKey: `${Date.now()}:${randomUUID()}`,
      operationId: 'graph.patch.discard',
      input: { projectId: meta.id, previewId }
    })
    expect(discarded.status).toBe('completed')
    expect((discarded.data as { state: string }).state).toBe('discarded')

    const confirmDiscarded = await service.dispatch({
      apiVersion: 1,
      operationVersion: 1,
      expectedDataStoreId: service.dataStoreId,
      requestId: randomUUID(),
      idempotencyKey: `${Date.now()}:${randomUUID()}`,
      operationId: 'graph.patch.confirm',
      input: { projectId: meta.id, previewId }
    })
    expect(confirmDiscarded.status).toBe('failed')
    expect(confirmDiscarded.error?.code).toBe('INVALID_INPUT')
  })
})
