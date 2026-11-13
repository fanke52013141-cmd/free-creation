import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowAssetStore } from '../src/main/agent-flow/asset-store'
import { createSearchPort } from '../src/main/agent-flow/search-tool'
import { AgentDecisionSchema } from '../src/shared/agent-flow/runtime-contracts'
import type { ProjectFile } from '../src/shared/types'

// 搜索客户端 mock：端口结算单测不发起真实网络。
const searchDoubaoMock = vi.hoisted(() => vi.fn())
vi.mock('../src/main/gateway/doubao-search', () => ({
  searchDoubao: searchDoubaoMock
}))

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  vi.clearAllMocks()
})

function fixture(): { db: Database.Database; store: FlowAssetStore; file: ProjectFile } {
  const db = new Database(':memory:')
  databases.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, 0, 0)').run(
    'project-a',
    'fixture'
  )
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'project-a', name: 'fixture', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: [],
    edges: [],
    groups: [],
    tldrawSnapshot: { store: {} }
  }
  const store = new FlowAssetStore(db, (id) =>
    id === file.meta.id && db.prepare('SELECT id FROM projects WHERE id = ?').get(id) ? file : null
  )
  return { db, store, file }
}

const signal = { aborted: false } as AbortSignal

describe('C2 搜索资产来源（submitSearchResult）', () => {
  it('主进程生成 JSON 值写入固定资产，可被 resolveInputs 按引用读取', () => {
    const { store } = fixture()
    const version = store.submitSearchResult({
      projectId: 'project-a',
      agentNodeId: 'shape:agent',
      submissionId: 'search:cmd-1',
      data: { query: 'q', items: [{ title: 't', url: 'https://e.com', summary: 's' }] }
    })
    expect(version.ref.sourceNodeId).toBe('shape:agent')
    expect(version.ref.sourcePortId).toBe('out-json')
    expect(version.value).toMatchObject({ kind: 'json' })
    const resolved = store.resolveInputs('project-a', [version.ref])
    expect(resolved).toHaveLength(1)
    expect(resolved[0].value).toMatchObject({ kind: 'json' })
  })

  it('幂等：相同 submissionId 返回同一版本，不重复写', () => {
    const { store } = fixture()
    const a = store.submitSearchResult({
      projectId: 'project-a',
      agentNodeId: 'shape:agent',
      submissionId: 'search:cmd-2',
      data: { query: 'q', items: [] }
    })
    const b = store.submitSearchResult({
      projectId: 'project-a',
      agentNodeId: 'shape:agent',
      submissionId: 'search:cmd-2',
      data: { query: 'q', items: [] }
    })
    expect(b.ref.versionId).toBe(a.ref.versionId)
  })

  it('不同 submissionId 产生递增 ordinal 的新版本', () => {
    const { store } = fixture()
    const a = store.submitSearchResult({
      projectId: 'project-a',
      agentNodeId: 'shape:agent',
      submissionId: 'search:cmd-3',
      data: { items: [] }
    })
    const b = store.submitSearchResult({
      projectId: 'project-a',
      agentNodeId: 'shape:agent',
      submissionId: 'search:cmd-4',
      data: { items: [] }
    })
    expect(b.ordinal).toBe(a.ordinal + 1)
    expect(b.ref.assetId).toBe(a.ref.assetId)
  })
})

describe('C2 搜索端口结算（createSearchPort）', () => {
  it('搜索成功结算为 committed 回执，outputRefs 指向固定候选资产', async () => {
    const { store } = fixture()
    searchDoubaoMock.mockResolvedValue({
      items: [{ title: 't', url: 'https://e.com', summary: 's', siteName: '', publishTime: '', authInfoLevel: 0 }],
      resultCount: 1
    })
    const port = createSearchPort(store, async () => 'secret-key', 'doubao-search')
    const receipt = await port(
      { projectId: 'project-a', taskId: 'task-1', agentNodeId: 'shape:agent', commandId: 'cmd-1', query: 'q' },
      signal
    )
    expect(receipt.state).toBe('committed')
    expect(receipt.commandId).toBe('cmd-1')
    expect(receipt.targetNodeId).toBe('shape:agent')
    expect(receipt.outputRefs).toHaveLength(1)
    expect(receipt.outputRefs[0].sourcePortId).toBe('out-json')
    // 密钥经 resolveKey 传入搜索客户端，不进入回执/资产引用。
    expect(searchDoubaoMock).toHaveBeenCalledWith('secret-key', expect.objectContaining({ query: 'q' }))
    const resolved = store.resolveInputs('project-a', receipt.outputRefs)
    expect(resolved[0].value).toMatchObject({ kind: 'json' })
  })

  it('缺密钥前置拒绝，不调用搜索客户端', async () => {
    const { store } = fixture()
    const port = createSearchPort(store, async () => '', 'doubao-search')
    await expect(
      port({ projectId: 'project-a', taskId: 't', agentNodeId: 'shape:agent', commandId: 'c', query: 'q' }, signal)
    ).rejects.toMatchObject({ code: 'WEB_SEARCH_NO_KEY' })
    expect(searchDoubaoMock).not.toHaveBeenCalled()
  })

  it('已取消信号前置拒绝', async () => {
    const { store } = fixture()
    const port = createSearchPort(store, async () => 'k', 'doubao-search')
    await expect(
      port({ projectId: 'project-a', taskId: 't', agentNodeId: 'shape:agent', commandId: 'c', query: 'q' }, { aborted: true } as AbortSignal)
    ).rejects.toMatchObject({ code: 'FLOW_CANCELLED' })
  })

  it('搜索失败归一稳定码，不结算资产', async () => {
    const { store } = fixture()
    const { GatewayError } = await import('../src/main/gateway/factory')
    searchDoubaoMock.mockRejectedValue(new GatewayError('WEB_SEARCH_QUOTA_EXHAUSTED', 'quota'))
    const port = createSearchPort(store, async () => 'k', 'doubao-search')
    await expect(
      port({ projectId: 'project-a', taskId: 't', agentNodeId: 'shape:agent', commandId: 'c', query: 'q' }, signal)
    ).rejects.toMatchObject({ code: 'WEB_SEARCH_QUOTA_EXHAUSTED' })
  })
})

describe('C2 搜索决策契约', () => {
  it('解析 search 决策（query 必填、count 可选有界）', () => {
    const decision = AgentDecisionSchema.parse({ kind: 'search', query: '最新政策', count: 5 })
    expect(decision).toMatchObject({ kind: 'search', query: '最新政策', count: 5 })
  })

  it('空查询 / 超长查询 / 超界 count 拒绝', () => {
    expect(() => AgentDecisionSchema.parse({ kind: 'search', query: '' })).toThrow()
    expect(() => AgentDecisionSchema.parse({ kind: 'search', query: 'x'.repeat(101) })).toThrow()
    expect(() => AgentDecisionSchema.parse({ kind: 'search', query: 'q', count: 99 })).toThrow()
  })
})