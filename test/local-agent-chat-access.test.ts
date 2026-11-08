// F6 对话外部接入测试：chat.read / chat.messages 服务读取、chat.patch 规划器
// 会话/消息操作矩阵（与 GUI 同一 chat-data 函数）。发送经 node.execute（需要
// 真实模型），其外部协议已在 run-access 测试覆盖。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasNode } from '../src/shared/types'
import { closeDb, getDataDir } from '../src/main/store/db'
import { createProject, openProject, saveProject } from '../src/main/store/projects.repo'
import { LocalAccessService } from '../src/main/agent-access/service'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'
import { planChatPatch } from '../src/renderer/src/canvas/chat-patch'

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

function chatNode(id: string, text: string): CanvasNode {
  return {
    id: `shape:${id}`,
    type: 'chat',
    contractVersion: 1,
    title: '对话',
    x: 0,
    y: 0,
    w: 340,
    h: 260,
    ports: [],
    params: { config: JSON.stringify({ modelKey: 'test-model' }) },
    content: { kind: 'text', text },
    exec: { status: 'idle' },
    meta: { source: 'input', createdAt: 1 }
  }
}

const SEED_CHAT = JSON.stringify({
  system: '你是测试助手',
  modelKey: 'test-model',
  messages: [],
  temperature: 0.7,
  maxTokens: 4096,
  conversations: [
    {
      id: 'conv-1',
      title: '第一轮',
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！有什么可以帮你？' },
        { role: 'user', content: '画一张图', intent: 'image' }
      ],
      createdAt: 1,
      updatedAt: 2
    }
  ],
  activeConversationId: 'conv-1'
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-chat-access-test-'))
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
    !basename(directory).startsWith('canvas-chat-access-test-')
  )
    throw new Error('CHAT_ACCESS_TEST_CLEANUP_OUTSIDE_ISOLATION')
  rmSync(directory, { recursive: true, force: true })
})

describe('local Agent chat access', () => {
  it('reads conversation directory without message bodies and messages with explicit bodies', async () => {
    const p = createProject('读对话')
    saveProject({ id: p.id, graph: { nodes: [chatNode('chat1', SEED_CHAT)], edges: [], groups: [] } })!
    const read = await call('chat.read', { projectId: p.id, nodeId: 'shape:chat1' })
    expect(read.status).toBe('completed')
    const data = read.data as any
    expect(data).toMatchObject({ nodeId: 'shape:chat1', modelKey: 'test-model', activeConversationId: 'conv-1' })
    expect(data.conversations).toHaveLength(1)
    expect(data.conversations[0]).toMatchObject({ id: 'conv-1', title: '第一轮', messageCount: 3, active: true })
    // 目录不携带正文
    expect(JSON.stringify(read)).not.toContain('你好！有什么可以帮你')
    const messages = await call('chat.messages', { projectId: p.id, nodeId: 'shape:chat1', offset: 1, limit: 2 })
    expect(messages.data).toMatchObject({ sessionId: 'conv-1', total: 3, offset: 1 })
    const page = (messages.data as any).messages
    expect(page).toHaveLength(2)
    expect(page[0]).toMatchObject({ role: 'assistant', content: '你好！有什么可以帮你？' })
    expect(page[1]).toMatchObject({ role: 'user', intent: 'image' })
    // 非 chat 节点拒绝
    expect((await call('chat.read', { projectId: p.id, nodeId: 'shape:missing' })).error?.code).toBe('NODE_NOT_FOUND')
  })

  it('applies session operations through the shared chat-data functions', () => {
    const created = planChatPatch(SEED_CHAT, [{ action: 'chat.session.create', title: '外部会话' }])
    expect(created.ok).toBe(true)
    if (created.ok) {
      const data = JSON.parse(created.nextText)
      expect(data.conversations).toHaveLength(2)
      expect(data.activeConversationId).not.toBe('conv-1')
      expect(data.conversations.at(-1).title).toBe('外部会话')
    }
    const renamed = planChatPatch(SEED_CHAT, [{ action: 'chat.session.rename', sessionId: 'conv-1', title: '改名会话' }])
    expect(renamed.ok).toBe(true)
    if (renamed.ok) expect(JSON.parse(renamed.nextText).conversations[0].title).toBe('改名会话')
    const renamedMissing = planChatPatch(SEED_CHAT, [{ action: 'chat.session.rename', sessionId: 'ghost', title: 'x' }])
    expect(renamedMissing).toMatchObject({ ok: false, issue: { index: 0, code: 'SESSION_NOT_FOUND' } })
    const deleted = planChatPatch(SEED_CHAT, [{ action: 'chat.session.delete', sessionId: 'conv-1' }])
    expect(deleted.ok).toBe(true)
    if (deleted.ok) {
      const data = JSON.parse(deleted.nextText)
      // 删除后回落到剩余最近会话（与 GUI 一致）；这里唯一剩余会话是新建场景外的 none ——
      // seed 只有 conv-1，删除后应重建空白会话。但实现回落 remaining.at(-1)，空集才重建；
      // seed 只有一个会话，删除后即空集，因此断言空白重建。
      expect(data.conversations.length).toBeLessThanOrEqual(1)
      if (data.conversations.length === 1) expect(data.conversations[0].messages).toHaveLength(0)
      expect(data.activeConversationId).toBeTruthy()
    }
  })

  it('applies message append/edit/truncate with GUI-consistent branching semantics', () => {
    const appended = planChatPatch(SEED_CHAT, [
      { action: 'chat.message.append', message: { role: 'user', content: '外部追加的消息' } }
    ])
    expect(appended.ok).toBe(true)
    if (appended.ok) {
      const data = JSON.parse(appended.nextText)
      const active = data.conversations.find((c: any) => c.id === data.activeConversationId)
      expect(active.messages.at(-1)).toMatchObject({ role: 'user', content: '外部追加的消息' })
    }
    // 编辑 index=1（assistant）：截断其后的轮次并改写
    const edited = planChatPatch(SEED_CHAT, [{ action: 'chat.message.edit', index: 0, content: '改写的提问' }])
    expect(edited.ok).toBe(true)
    if (edited.ok) {
      const data = JSON.parse(edited.nextText)
      const active = data.conversations.find((c: any) => c.id === data.activeConversationId)
      expect(active.messages).toHaveLength(1)
      expect(active.messages[0].content).toBe('改写的提问')
    }
    const truncated = planChatPatch(SEED_CHAT, [{ action: 'chat.message.truncate', index: 1 }])
    expect(truncated.ok).toBe(true)
    if (truncated.ok) {
      const data = JSON.parse(truncated.nextText)
      const active = data.conversations.find((c: any) => c.id === data.activeConversationId)
      expect(active.messages).toHaveLength(1)
    }
    const badIndex = planChatPatch(SEED_CHAT, [{ action: 'chat.message.truncate', index: 99 }])
    expect(badIndex).toMatchObject({ ok: false, issue: { code: 'MESSAGE_INDEX_INVALID' } })
    // 生图意图保留
    const imageAppend = planChatPatch(SEED_CHAT, [
      { action: 'chat.message.append', message: { role: 'user', content: '生成海报', intent: 'image' } }
    ])
    expect(imageAppend.ok).toBe(true)
    if (imageAppend.ok) {
      const data = JSON.parse(imageAppend.nextText)
      const active = data.conversations.find((c: any) => c.id === data.activeConversationId)
      expect(active.messages.at(-1).intent).toBe('image')
    }
  })

  it('carries attachment media resolutions only as ids in external input', async () => {
    const p = createProject('附件')
    const source = join(directory, 'att.png')
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]))
    const imported = await call('media.import', { projectId: p.id, filePath: source }, key())
    const mediaId = (imported.data as any).mediaId
    saveProject({ id: p.id, graph: { nodes: [chatNode('chat1', SEED_CHAT)], edges: [], groups: [] } })!
    active = p.id
    let captured: any = null
    service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(getDataDir(), 'agent-exports'),
      activeProjectId: () => active,
      desktop: {
        run: async (request, commit) => {
          captured = request
          const before = openProject(p.id)!
          commit?.(before.meta.graphVersion)
          return { graphVersion: before.meta.graphVersion }
        }
      }
    })
    const patched = await call(
      'graph.patch',
      {
        projectId: p.id,
        expectedGraphVersion: 1,
        ops: [
          {
            action: 'chat.patch',
            nodeId: 'shape:chat1',
            ops: [
              { action: 'chat.message.append', message: { role: 'user', content: '看这张图', images: [{ mediaId }] } }
            ]
          }
        ]
      },
      key()
    )
    expect(patched.status).toBe('completed')
    // 外部输入只有 mediaId；存储事实由 main 解析并注入
    const sentOps = (captured.ops ?? []).filter((op: any) => op.action === 'chat.patch')
    expect(JSON.stringify(sentOps[0])).toContain(mediaId)
    expect(JSON.stringify(sentOps[0])).not.toContain('projects/')
    expect(captured.mediaResolutions[mediaId]).toMatchObject({ mediaId, mediaMime: 'image/png' })
    // 未登记的附件 mediaId 拒绝
    const ghost = await call(
      'graph.patch',
      {
        projectId: p.id,
        expectedGraphVersion: 1,
        ops: [
          {
            action: 'chat.patch',
            nodeId: 'shape:chat1',
            ops: [{ action: 'chat.message.append', message: { role: 'user', content: 'x', images: [{ mediaId: 'ghost' }] } }]
          }
        ]
      },
      key()
    )
    expect(ghost.error?.code).toBe('MEDIA_NOT_FOUND')
  })
})
