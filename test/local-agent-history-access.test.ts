// F7 历史与恢复外部接入测试：history.list / snapshot.create / snapshot.delete /
// restore.precheck / restore / recovery.precheck / recovery.resolve。
//
// 覆盖：快照创建-恢复-删除的数据级断言（恢复后图=快照图，版本推进）、GUI 快照的
// graph 附加规则（持久化一致才可外部恢复）、precheck→令牌→执行三段与令牌失效、
// 打开中的画布拒绝恢复、恢复副本存在时删除/导出/其他写操作仍 RESOURCE_BUSY、
// 恢复副本 use/discard 两条裁决路径与解决后写操作恢复、未知项目/快照明确拒绝。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasEdge, CanvasNode } from '../src/shared/types'
import { closeDb, getDataDir } from '../src/main/store/db'
import {
  createProject,
  hasRecoveryCopy,
  openProject,
  saveProject,
  saveRecoveryCopySync
} from '../src/main/store/projects.repo'
import { saveHistorySnapshot } from '../src/main/store/workspace-state.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory: string
let service: LocalAccessService
let active: string | null
const events: any[] = []
const originalDirectory = process.env.CANVAS_DATA_DIR
const key = () => `${Date.now()}:${randomUUID()}`

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

function textNode(id: string, text: string, x = 0): CanvasNode {
  return {
    id: `shape:${id}`,
    type: 'text',
    contractVersion: 3,
    title: `标题${id}`,
    x,
    y: 0,
    w: 340,
    h: 260,
    ports: [
      {
        id: 'in-text',
        name: '文本',
        dir: 'in',
        type: 'text',
        required: false,
        cardinality: 'one',
        description: '输入文本'
      },
      {
        id: 'out-text',
        name: '文本',
        dir: 'out',
        type: 'text',
        required: true,
        cardinality: 'one',
        description: '输出文本'
      }
    ],
    params: { config: JSON.stringify({ template: text }) },
    content: { kind: 'text', text },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

function textEdge(id: string, from: string, to: string): CanvasEdge {
  return {
    id: `shape:${id}`,
    from: { nodeId: `shape:${from}`, portId: 'out-text' },
    to: { nodeId: `shape:${to}`, portId: 'in-text' }
  }
}

/** 最小 tldraw store 快照（主进程只按 JSON 事实存取，不规范校验画布结构）。 */
function tldrawSnapshot(marker: string): unknown {
  return {
    schema: { schemaVersion: 2, sequences: { 'com.tldraw.store': 5 } },
    store: {
      'document:document': {
        typeName: 'document',
        id: 'document:document',
        gridSize: 10,
        name: '',
        meta: {}
      },
      'page:page': { typeName: 'page', id: 'page:page', name: 'Page 1', index: 'a1', meta: {} },
      [`shape:${marker}`]: {
        typeName: 'shape',
        type: 'node-card',
        id: `shape:${marker}`,
        x: 0,
        y: 0,
        props: {
          nodeType: 'text',
          title: marker,
          w: 340,
          h: 260,
          text: marker,
          config: '',
          mediaId: '',
          mediaPath: '',
          mediaMime: '',
          exec: 'idle'
        }
      }
    }
  }
}

function seed(projectId: string, marker: string, nodes: CanvasNode[], edges: CanvasEdge[]): number {
  return saveProject({
    id: projectId,
    graph: { nodes, edges, groups: [] },
    tldrawSnapshot: tldrawSnapshot(marker)
  })!.graphVersion
}

function graphOf(projectId: string): { nodes: unknown[]; edges: unknown[]; groups: unknown[] } {
  const file = openProject(projectId)!
  return { nodes: file.nodes, edges: file.edges, groups: file.groups }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-history-access-test-'))
  process.env.CANVAS_DATA_DIR = directory
  active = null
  events.length = 0
  setGatewayEventSink({
    emit: (event) => {
      if (event) events.push(event)
    }
  })
  service = new LocalAccessService({
    instanceId: randomUUID(),
    appVersion: 'test',
    exportDirectory: join(getDataDir(), 'agent-exports'),
    activeProjectId: () => active
  })
})

afterEach(() => {
  closeDb()
  setGatewayEventSink(null)
  process.env.CANVAS_DATA_DIR = originalDirectory
  if (originalDirectory === undefined) delete process.env.CANVAS_DATA_DIR
  if (
    resolve(directory, '..') !== resolve(tmpdir()) ||
    !basename(directory).startsWith('canvas-history-access-test-')
  )
    throw new Error('HISTORY_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('local Agent history access', () => {
  it('creates, lists, restores and deletes snapshots with real data-level results', async () => {
    const p = createProject('历史项目')
    const v1Graph = {
      nodes: [textNode('a', '第一版正文'), textNode('b', '下游', 500)],
      edges: [textEdge('e1', 'a', 'b')],
      groups: []
    }
    const v1 = seed(p.id, 'snap-v1', v1Graph.nodes, v1Graph.edges)
    const created = await call(
      'history.snapshot.create',
      { projectId: p.id, expectedGraphVersion: v1, label: '第一版' },
      key()
    )
    expect(created.status).toBe('completed')
    const snapshotId = (created.data as any).snapshotId as string
    expect(created.data).toMatchObject({
      projectId: p.id,
      label: '第一版',
      nodeCount: 2,
      graphVersion: v1,
      restorable: true
    })

    // 之后继续编辑：当前图与快照不同。
    const v2 = saveProject({
      id: p.id,
      expectedGraphVersion: v1,
      graph: { nodes: [textNode('a', '第二版正文')], edges: [], groups: [] },
      tldrawSnapshot: tldrawSnapshot('snap-v2')
    })!.graphVersion
    expect(graphOf(p.id).nodes).toHaveLength(1)

    const list = await call('history.list', { projectId: p.id })
    expect(list.data).toMatchObject({ total: 1 })
    expect((list.data as any).items[0]).toMatchObject({
      snapshotId,
      label: '第一版',
      nodeCount: 2,
      restorable: true
    })
    // 目录不回传快照正文
    expect(JSON.stringify(list)).not.toContain('snap-v1')

    const precheck = await call('history.restore.precheck', { projectId: p.id, snapshotId })
    expect(precheck.status).toBe('completed')
    const pre = precheck.data as any
    expect(pre).toMatchObject({
      projectId: p.id,
      graphVersion: v2,
      snapshotId,
      current: { nodeCount: 1, edgeCount: 0, groupCount: 0 },
      target: { nodeCount: 2, edgeCount: 1, groupCount: 0 },
      blockers: []
    })
    expect(pre.impactToken).toBeTruthy()
    expect(pre.expiresAt).toBeGreaterThan(Date.now())

    const restored = await call(
      'history.restore',
      { projectId: p.id, snapshotId, impactToken: pre.impactToken },
      key()
    )
    expect(restored.status).toBe('completed')
    const after = restored.data as any
    expect(after).toMatchObject({
      projectId: p.id,
      snapshotId,
      restored: true,
      nodeCount: 2,
      edgeCount: 1,
      previousGraphVersion: v2
    })
    expect(after.graphVersion).toBe(v2 + 1)
    // 数据级核对：恢复后的图与快照保存时的图逐字段一致
    expect(graphOf(p.id)).toEqual(v1Graph)
    // 恢复前检查点已保存且可再恢复
    expect(after.checkpointSnapshotId).toBeTruthy()
    const afterList = await call('history.list', { projectId: p.id })
    expect(afterList.data).toMatchObject({ total: 2 })
    const checkpoint = (afterList.data as any).items.find(
      (item: any) => item.snapshotId === after.checkpointSnapshotId
    )
    expect(checkpoint).toMatchObject({ nodeCount: 1, restorable: true })

    // 删除快照：目录不再返回，恢复已删除快照明确 NOT_FOUND
    expect(
      (await call('history.snapshot.delete', { projectId: p.id, snapshotId }, key())).data
    ).toEqual({ projectId: p.id, snapshotId, deleted: true })
    expect((await call('history.list', { projectId: p.id })).data).toMatchObject({ total: 1 })
    expect(
      (await call('history.restore.precheck', { projectId: p.id, snapshotId })).error?.code
    ).toBe('NOT_FOUND')
    expect(
      (await call('history.snapshot.delete', { projectId: p.id, snapshotId }, key())).error?.code
    ).toBe('NOT_FOUND')
  })

  it('restores GUI snapshots only when their persisted graph is consistent', async () => {
    const p = createProject('GUI 快照项目')
    const graph = {
      nodes: [textNode('a', 'GUI 版正文')],
      edges: [],
      groups: []
    }
    const version = seed(p.id, 'gui-v1', graph.nodes, graph.edges)
    const file = openProject(p.id)!
    // GUI 历史坞：captured 内存快照与磁盘一致 → 主进程顺手存持久化图数据。
    const consistent = saveHistorySnapshot({
      projectId: p.id,
      label: 'GUI 一致快照',
      nodeCount: file.nodes.length,
      snapshot: structuredClone(file.tldrawSnapshot)
    })
    // GUI 有未保存编辑时：快照只属于画布，不提供外部恢复图数据。
    const inconsistent = saveHistorySnapshot({
      projectId: p.id,
      label: 'GUI 未保存快照',
      nodeCount: file.nodes.length,
      snapshot: tldrawSnapshot('unsaved')
    })
    const summaries = await call('history.list', { projectId: p.id })
    const items = (summaries.data as any).items as any[]
    expect(items.find((item) => item.snapshotId === consistent.id)!.restorable).toBe(true)
    expect(items.find((item) => item.snapshotId === inconsistent.id)!.restorable).toBe(false)
    // 未保存快照：precheck 如实阻塞并给理由，执行明确拒绝（GUI 仍可在画布内恢复它）。
    const blockedPrecheck = await call('history.restore.precheck', {
      projectId: p.id,
      snapshotId: inconsistent.id
    })
    expect(blockedPrecheck.data).toMatchObject({
      snapshotId: inconsistent.id,
      blockers: ['SNAPSHOT_WITHOUT_GRAPH']
    })
    expect((blockedPrecheck.data as any).impactToken).toBeUndefined()
    expect(
      (
        await call(
          'history.restore',
          { projectId: p.id, snapshotId: inconsistent.id },
          key()
        )
      ).error?.code
    ).toBe('SNAPSHOT_WITHOUT_GRAPH')
    // 一致的快照可外部恢复
    const precheck = await call('history.restore.precheck', {
      projectId: p.id,
      snapshotId: consistent.id
    })
    const restored = await call(
      'history.restore',
      { projectId: p.id, snapshotId: consistent.id, impactToken: (precheck.data as any).impactToken },
      key()
    )
    expect(restored.status).toBe('completed')
    expect(graphOf(p.id)).toEqual(graph)
    expect(openProject(p.id)!.meta.graphVersion).toBe(version + 1)
  })

  it('enforces precheck tokens and rejects drifted or missing confirmations', async () => {
    const p = createProject('令牌项目')
    const graph = { nodes: [textNode('a', '快照正文')], edges: [], groups: [] }
    const v1 = seed(p.id, 'token-v1', graph.nodes, graph.edges)
    const created = await call(
      'history.snapshot.create',
      { projectId: p.id, expectedGraphVersion: v1, label: '令牌快照' },
      key()
    )
    const snapshotId = (created.data as any).snapshotId as string
    // 无令牌
    expect(
      (await call('history.restore', { projectId: p.id, snapshotId }, key())).error?.code
    ).toBe('IMPACT_CONFIRM_REQUIRED')
    // 伪造令牌
    expect(
      (
        await call(
          'history.restore',
          { projectId: p.id, snapshotId, impactToken: `${Date.now() + 60000}.deadbeef` },
          key()
        )
      ).error?.code
    ).toBe('IMPACT_TOKEN_INVALID')
    // 事实漂移：预检后画布又前进一个版本，旧令牌必须失效
    const precheck = await call('history.restore.precheck', { projectId: p.id, snapshotId })
    const token = (precheck.data as any).impactToken as string
    saveProject({
      id: p.id,
      expectedGraphVersion: v1,
      graph: { nodes: [textNode('a', '漂移后正文'), textNode('b', '新增')], edges: [], groups: [] },
      tldrawSnapshot: tldrawSnapshot('token-v2')
    })
    const drifted = await call(
      'history.restore',
      { projectId: p.id, snapshotId, impactToken: token },
      key()
    )
    expect(drifted.status).toBe('failed')
    expect(drifted.error?.code).toBe('IMPACT_TOKEN_INVALID')
    // 旧图未被改动（生效前失败不留半恢复状态）
    expect(openProject(p.id)!.meta.graphVersion).toBe(v1 + 1)
    expect(graphOf(p.id).nodes).toHaveLength(2)
    // 重新预检后可重试成功
    const fresh = await call('history.restore.precheck', { projectId: p.id, snapshotId })
    const retried = await call(
      'history.restore',
      { projectId: p.id, snapshotId, impactToken: (fresh.data as any).impactToken },
      key()
    )
    expect(retried.status).toBe('completed')
    expect(graphOf(p.id).nodes).toHaveLength(1)
  })

  it('refuses to restore the canvas that is open in the desktop', async () => {
    const p = createProject('打开中项目')
    const graph = { nodes: [textNode('a', '快照')], edges: [], groups: [] }
    const v1 = seed(p.id, 'active-v1', graph.nodes, graph.edges)
    const created = await call(
      'history.snapshot.create',
      { projectId: p.id, expectedGraphVersion: v1, label: '打开中快照' },
      key()
    )
    const snapshotId = (created.data as any).snapshotId as string
    active = p.id
    const precheck = await call('history.restore.precheck', { projectId: p.id, snapshotId })
    expect(precheck.data).toMatchObject({ blockers: ['ACTIVE_PROJECT'] })
    expect((precheck.data as any).impactToken).toBeUndefined()
    const refused = await call(
      'history.restore',
      { projectId: p.id, snapshotId, impactToken: (precheck.data as any).impactToken },
      key()
    )
    expect(refused.status).toBe('failed')
    expect(refused.error?.code).toBe('RESOURCE_BUSY')
    expect(openProject(p.id)!.meta.graphVersion).toBe(v1)
  })

  it('keeps delete/export/other writes blocked by a recovery copy and resolves it', async () => {
    const p = createProject('恢复副本项目')
    const diskGraph = { nodes: [textNode('a', '磁盘版本')], edges: [], groups: [] }
    const version = seed(p.id, 'rec-disk', diskGraph.nodes, diskGraph.edges)
    // 先建一个可恢复快照，后面用它证明"恢复副本存在时快照恢复也被如实拒绝"。
    const baseline = await call(
      'history.snapshot.create',
      { projectId: p.id, expectedGraphVersion: version, label: '副本前快照' },
      key()
    )
    expect(baseline.status).toBe('completed')
    const baselineSnapshotId = (baseline.data as any).snapshotId as string
    // 关窗冲突留下的恢复副本（GUI 打开项目时才有裁决入口；外部用同一 repo 服务）
    const copyGraph = { nodes: [textNode('a', '本地最后视图'), textNode('b', '副本新增')], edges: [textEdge('e1', 'a', 'b')], groups: [] }
    expect(
      saveRecoveryCopySync({
        id: p.id,
        graph: { nodes: copyGraph.nodes, edges: copyGraph.edges, groups: [] },
        tldrawSnapshot: tldrawSnapshot('rec-copy')
      })
    ).toBe(true)
    expect(hasRecoveryCopy(p.id)).toBe(true)

    // 删除：预检如实报阻塞，执行在准入阶段就拒绝（RESOURCE_BUSY/recovery-ownership）。
    const deletePrecheck = await call('project.delete.precheck', { projectId: p.id })
    expect((deletePrecheck.data as any).blockers).toContain('RECOVERY_COPY')
    expect(
      (await call('project.delete', { projectId: p.id }, key())).error?.code
    ).toBe('RESOURCE_BUSY')
    // 导出、保存、快照创建、快照恢复同样被如实拒绝（豁免只对一个操作生效）。
    expect(
      (
        await call(
          'project.export',
          { projectId: p.id, expectedGraphVersion: version, fileName: 'rec.canvasbundle' },
          key()
        )
      ).error?.code
    ).toBe('RESOURCE_BUSY')
    expect(
      (await call('project.save', { projectId: p.id, expectedGraphVersion: version }, key())).error
        ?.code
    ).toBe('RESOURCE_BUSY')
    // 快照恢复同样被恢复副本阻断（precheck 如实报阻塞，执行在准入阶段拒绝）。
    const restorePrecheck = await call('history.restore.precheck', {
      projectId: p.id,
      snapshotId: baselineSnapshotId
    })
    expect((restorePrecheck.data as any).blockers).toContain('RECOVERY_COPY')
    expect(
      (
        await call(
          'history.restore',
          { projectId: p.id, snapshotId: baselineSnapshotId },
          key()
        )
      ).error?.code
    ).toBe('RESOURCE_BUSY')
    expect(
      (
        await call(
          'history.snapshot.create',
          { projectId: p.id, expectedGraphVersion: version, label: 'x' },
          key()
        )
      ).error?.code
    ).toBe('RESOURCE_BUSY')
    const snapshot = await call(
      'history.snapshot.create',
      { projectId: p.id, expectedGraphVersion: version, label: '副本期间快照' },
      key()
    )
    // 恢复副本存在时连快照创建都阻断：副本移除后才能建快照（下面验证）。
    expect(snapshot.status).toBe('failed')

    // 恢复副本裁决：precheck 给出事实与令牌
    const recoveryPrecheck = await call('history.recovery.precheck', {
      projectId: p.id,
      decision: 'discard'
    })
    expect(recoveryPrecheck.status).toBe('completed')
    const pre = recoveryPrecheck.data as any
    expect(pre).toMatchObject({
      projectId: p.id,
      exists: true,
      copyGraphVersion: version,
      copyNodeCount: 2,
      blockers: []
    })
    expect(pre.impactToken).toBeTruthy()
    // 无令牌 / 伪造令牌都必须拒绝
    expect(
      (await call('history.recovery.resolve', { projectId: p.id, decision: 'discard' }, key())).error
        ?.code
    ).toBe('IMPACT_CONFIRM_REQUIRED')
    expect(
      (
        await call(
          'history.recovery.resolve',
          { projectId: p.id, decision: 'discard', impactToken: `${Date.now() + 1000}.00` },
          key()
        )
      ).error?.code
    ).toBe('IMPACT_TOKEN_INVALID')
    // discard：保留磁盘版本、移除副本；随后写操作恢复正常
    const discarded = await call(
      'history.recovery.resolve',
      { projectId: p.id, decision: 'discard', impactToken: pre.impactToken },
      key()
    )
    expect(discarded.status).toBe('completed')
    expect(discarded.data).toMatchObject({
      projectId: p.id,
      decision: 'discard',
      resolved: true,
      graphVersion: version,
      recoveryCopyRemoved: true
    })
    expect(hasRecoveryCopy(p.id)).toBe(false)
    expect(graphOf(p.id)).toEqual(diskGraph)
    const savedAfterDiscard = await call(
      'project.save',
      { projectId: p.id, expectedGraphVersion: version },
      key()
    )
    expect(savedAfterDiscard.data).toMatchObject({ saved: true })

    // use：再次制造副本 → 落盘（版本推进、旧版进 .bak），副本移除
    const baseVersion = openProject(p.id)!.meta.graphVersion
    expect(
      saveRecoveryCopySync({
        id: p.id,
        graph: { nodes: copyGraph.nodes, edges: copyGraph.edges, groups: [] },
        tldrawSnapshot: tldrawSnapshot('rec-copy-2')
      })
    ).toBe(true)
    const usePre = (
      await call('history.recovery.precheck', { projectId: p.id, decision: 'use' })
    ).data as any
    const used = await call(
      'history.recovery.resolve',
      { projectId: p.id, decision: 'use', impactToken: usePre.impactToken },
      key()
    )
    expect(used.status).toBe('completed')
    expect(used.data).toMatchObject({
      decision: 'use',
      resolved: true,
      graphVersion: baseVersion + 1,
      recoveryCopyRemoved: true
    })
    expect(graphOf(p.id)).toEqual(copyGraph)
    // 恢复副本解决后快照创建/恢复等写操作恢复正常
    const snapshotAfter = await call(
      'history.snapshot.create',
      { projectId: p.id, expectedGraphVersion: baseVersion + 1, label: '副本后快照' },
      key()
    )
    expect(snapshotAfter.status).toBe('completed')
    // 恢复副本已不存在 → 再裁决明确 NOT_FOUND
    expect(
      (
        await call(
          'history.recovery.resolve',
          { projectId: p.id, decision: 'discard' },
          key()
        )
      ).error?.code
    ).toBe('NOT_FOUND')
  })

  it('rejects unknown projects and cross-project snapshot ids', async () => {
    expect((await call('history.list', { projectId: 'missing-project' })).error?.code).toBe(
      'NOT_FOUND'
    )
    expect(
      (
        await call(
          'history.snapshot.create',
          { projectId: 'missing-project', expectedGraphVersion: 0, label: 'x' },
          key()
        )
      ).error?.code
    ).toBe('NOT_FOUND')
    expect(
      (await call('history.recovery.precheck', { projectId: 'missing-project', decision: 'use' }))
        .error?.code
    ).toBe('NOT_FOUND')
    const a = createProject('项目A')
    const b = createProject('项目B')
    const seeded = seed(a.id, 'cross-a', [textNode('a', 'A 正文')], [])
    const created = await call(
      'history.snapshot.create',
      { projectId: a.id, expectedGraphVersion: seeded, label: 'A 快照' },
      key()
    )
    const snapshotId = (created.data as any).snapshotId as string
    // 项目隔离：B 项目不能读/删/恢复 A 的快照
    expect((await call('history.list', { projectId: b.id })).data).toMatchObject({ total: 0 })
    expect(
      (await call('history.snapshot.delete', { projectId: b.id, snapshotId }, key())).error?.code
    ).toBe('NOT_FOUND')
    expect(
      (await call('history.restore.precheck', { projectId: b.id, snapshotId })).error?.code
    ).toBe('NOT_FOUND')
    // 版本不符的快照创建明确拒绝
    expect(
      (
        await call(
          'history.snapshot.create',
          { projectId: a.id, expectedGraphVersion: seeded + 3, label: 'x' },
          key()
        )
      ).error?.code
    ).toBe('REVISION_CONFLICT')
    // 无恢复副本时的裁决明确 NOT_FOUND
    expect(
      (await call('history.recovery.precheck', { projectId: a.id, decision: 'use' })).data
    ).toMatchObject({ exists: false, copyGraphVersion: null })
    expect(
      (
        await call('history.recovery.resolve', { projectId: a.id, decision: 'use' }, key())
      ).error?.code
    ).toBe('NOT_FOUND')
  })
})
