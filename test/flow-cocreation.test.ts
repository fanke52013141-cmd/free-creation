import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { CanvasNode, ProjectFile } from '../src/shared/types'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowAgentDesktopHost } from '../src/main/agent-flow/desktop-host'
import { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { PROCESSOR_PORTS } from '../src/shared/agent-flow/processor-contract'
import { computeInputFingerprint } from '../src/shared/engine/input-fingerprint'
import type { AgentModelPort } from '../src/main/agent-flow/runtime'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

/**
 * AF-04 连续共创：讨论自动携带当前工作稿（最近已提交候选成果）；
 * 协作视图暴露 workingDraft；多轮讨论看到同一稿件；过期修订拒绝。
 */
const dbs: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  dbs.splice(0).forEach((db) => db.close())
  setGatewayEventSink(null)
})

function fixture() {
  const db = new Database(':memory:')
  dbs.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('p', 'isolated')
  const shape = (id: string, type: string, text = '', config: object = {}) => ({
    id,
    type: 'node-card',
    props: {
      nodeType: type, title: id, config: JSON.stringify(config), text,
      mediaId: '', mediaPath: '', mediaMime: '', w: 340, h: 260, exec: 'idle'
    },
    meta: {} as Record<string, unknown>
  })
  const specialistConfig = {
    schemaVersion: 1, role: 'specialist', interactionMode: 'collaborative',
    modelDefinitionId: 'm', skills: [], tools: [{ id: 'node.execute', version: '1' }],
    allowedNodeIds: ['proc'], maxSteps: 12, relations: []
  }
  const shapes = [
    shape('src', 'text', '原始素材'),
    shape('agent', 'agent', '整理并交付', specialistConfig),
    shape('proc', 'processor', '', { operation: 'template', template: '稿件：{{value}}' })
  ]
  const byId = Object.fromEntries(shapes.map((s) => [s.id, s]))
  const node = (s: (typeof shapes)[number]): CanvasNode => ({
    id: s.id, type: s.props.nodeType as CanvasNode['type'], contractVersion: 1,
    title: s.props.title, x: 0, y: 0, w: 340, h: 260,
    ports: s.props.nodeType === 'processor' ? [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out]
      : s.props.nodeType === 'agent' || s.props.nodeType === 'text'
        ? [{ id: 'out-text', name: 'text', dir: 'out', type: 'text', cardinality: 'one', required: true }]
        : [],
    params: { config: s.props.config },
    content: s.props.text ? { kind: 'text', text: s.props.text } : { kind: 'empty' },
    exec: { status: 'idle' }, meta: { source: 'input', createdAt: 0 }
  })
  const file: ProjectFile = {
    version: 1, meta: { id: 'p', name: 'isolated', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: shapes.map(node),
    edges: [
      { id: 'e1', from: { nodeId: 'src', portId: 'out-text' }, to: { nodeId: 'agent', portId: 'in-text' } },
      { id: 'e2', from: { nodeId: 'src', portId: 'out-text' }, to: { nodeId: 'proc', portId: 'in-value' } }
    ],
    groups: [], tldrawSnapshot: { store: byId }
  }
  const open = (id: string) => (id === 'p' ? file : null)
  const ledger = new FlowCommandLedger(db, open)
  let executions = 0
  const discussCalls: Array<{ message: string; workingDraft?: string }> = []
  const host = new FlowAgentDesktopHost(
    db, open,
    {
      ledger, isActive: () => true,
      deliver: async (grant) => {
        executions++
        const c = grant.command, target = byId[c.targetNodeId], fixed = grant.inputs
        ledger.check({ projectId: c.projectId, commandId: c.commandId, leaseId: grant.leaseId })
        target.meta.nodeRun = {
          runId: grant.runId, status: 'success', startedAt: 0, finishedAt: 1,
          commandId: c.commandId, commandLeaseId: grant.leaseId,
          nodeExecutionId: `execution-${executions}`, fixedInputs: c.inputs,
          inputs: Object.fromEntries(fixed.map((p) => [p.targetPortId, p.versions.map((v, i) => ({
            nodeId: p.sources![i].nodeId, portId: p.sources![i].portId,
            assetId: v.ref.assetId, versionId: v.ref.versionId
          }))])),
          inputFingerprint: computeInputFingerprint({
            contractVersion: 1, config: target.props.config, text: target.props.text,
            sources: fixed.flatMap((p) => p.versions.map((v, i) => ({
              portId: p.targetPortId, nodeId: p.sources![i].nodeId,
              sourcePortId: p.sources![i].portId, value: v.value
            })))
          }),
          outputPorts: ['out-value']
        }
        const source = fixed[0].versions[0].value
        target.meta.nodeResult = JSON.stringify(
          'text' in source ? { kind: 'text', text: `稿件：${source.text}` } : source
        )
        file.meta.graphVersion++
        ledger.commit({ projectId: c.projectId, commandId: c.commandId })
      }
    },
    async (): Promise<AgentModelPort> => ({
      decide: async (ctx) =>
        ctx.receipts.length < 1
          ? { kind: 'execute', targetNodeId: ctx.targets[0].nodeId }
          : ctx.humanAccepted
            ? { kind: 'finish', outputs: ctx.receipts.at(-1)!.outputRefs }
            : { kind: 'wait' },
      discuss: async (_goal, _history, message, _signal, workingDraft) => {
        discussCalls.push({ message, workingDraft })
        return `针对稿件的建议：${message}`
      }
    })
  )
  return { db, file, byId, host, ledger, discussCalls, count: () => executions }
}

const runInput = {
  projectId: 'p', nodeId: 'agent', requestId: 'task-1',
  traceId: 'trace', spanId: 'span', action: 'start' as const
}

describe('AF-04 continuous co-creation', () => {
  it('讨论自动携带当前工作稿；协作视图暴露 workingDraft', async () => {
    const f = fixture()
    const waiting = await f.host.run(runInput)
    expect(waiting.task.state).toBe('waiting')
    // 已提交候选成果 = 工作稿
    const view = f.host.collaboration({ projectId: 'p', nodeId: 'agent' })!
    expect(view.workingDraft).toBe('稿件：原始素材')
    expect(view.candidates.length).toBeGreaterThan(0)
    // 讨论携带工作稿
    await f.host.cooperate({
      projectId: 'p', nodeId: 'agent', taskId: waiting.task.taskId,
      waitRevision: waiting.task.waitRevision, revision: view.revision,
      eventId: 'discuss-1', action: 'discuss', text: '第二段太长'
    })
    expect(f.discussCalls).toHaveLength(1)
    expect(f.discussCalls[0].workingDraft).toBe('稿件：原始素材')
    expect(f.discussCalls[0].message).toBe('第二段太长')
  })

  it('多轮讨论看到同一工作稿', async () => {
    const f = fixture()
    const waiting = await f.host.run(runInput)
    for (let round = 1; round <= 3; round++) {
      const view = f.host.collaboration({ projectId: 'p', nodeId: 'agent' })!
      await f.host.cooperate({
        projectId: 'p', nodeId: 'agent', taskId: waiting.task.taskId,
        waitRevision: waiting.task.waitRevision, revision: view.revision,
        eventId: `discuss-${round}`, action: 'discuss', text: `第${round}轮意见`
      })
    }
    expect(f.discussCalls).toHaveLength(3)
    expect(f.discussCalls.every((call) => call.workingDraft === '稿件：原始素材')).toBe(true)
  })

  it('过期修订讨论被拒绝', async () => {
    const f = fixture()
    const waiting = await f.host.run(runInput)
    const view = f.host.collaboration({ projectId: 'p', nodeId: 'agent' })!
    await expect(
      f.host.cooperate({
        projectId: 'p', nodeId: 'agent', taskId: waiting.task.taskId,
        waitRevision: waiting.task.waitRevision + 99, revision: view.revision,
        eventId: 'stale', action: 'discuss', text: '过期意见'
      })
    ).rejects.toMatchObject({ code: 'RESUME_CONFLICT' })
    expect(f.discussCalls).toHaveLength(0)
  })
})