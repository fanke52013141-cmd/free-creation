import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasNode, ProjectFile } from '../src/shared/types'
import { migrateDatabase } from '../src/main/store/db-migrations'

const fixture = vi.hoisted(() => ({ db: null as unknown as Database.Database, file: null as unknown as ProjectFile }))
vi.mock('../src/main/store/db', () => ({
  getDb: () => fixture.db,
  getSetting: () => null,
  setSetting: () => undefined,
  closeDb: () => undefined
}))
vi.mock('../src/main/store/projects.repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/store/projects.repo')>()),
  openProject: () => fixture.file
}))

import { FlowAgentDesktopHost } from '../src/main/agent-flow/desktop-host'
import { FlowCommandLedger } from '../src/main/agent-flow/command-ledger'
import { PROCESSOR_PORTS } from '../src/shared/agent-flow/processor-contract'
import { computeInputFingerprint } from '../src/shared/engine/input-fingerprint'
import { LocalAccessService } from '../src/main/agent-access/service'
import { publishFlowAgentAccessPort, resetFlowAgentAccessPortForTest } from '../src/main/agent-access/flow-bridge'
import { setGatewayEventSink } from '../src/main/diagnostics/gateway-events'

let directory = ''
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-real-cooperate-host-'))
  fixture.db = new Database(':memory:')
  migrateDatabase(fixture.db)
  setGatewayEventSink({ emit: () => undefined })
})
afterEach(() => {
  resetFlowAgentAccessPortForTest()
  setGatewayEventSink(null)
  if (fixture.db?.open) fixture.db.close()
  rmSync(directory, { recursive: true, force: true })
})

function realHostFixture() {
  const shape = (id: string, type: string, text = '', config: object = {}) => ({
    id,
    type: 'node-card',
    props: { nodeType: type, title: id, config: JSON.stringify(config), text },
    meta: {} as Record<string, unknown>
  })
  const config = {
    schemaVersion: 1,
    role: 'specialist',
    interactionMode: 'collaborative',
    modelDefinitionId: 'fixture',
    skills: [],
    tools: [{ id: 'node.execute', version: '1' }],
    allowedNodeIds: ['proc'],
    maxSteps: 12,
    relations: []
  }
  const shapes = [
    shape('src', 'text', '原始素材'),
    shape('shape:agent', 'agent', '整理并交付', config),
    shape('proc', 'processor', '', { operation: 'template', template: '稿件：{{value}}' })
  ]
  const byId = Object.fromEntries(shapes.map((item) => [item.id, item]))
  const node = (item: (typeof shapes)[number]): CanvasNode => ({
    id: item.id,
    type: item.props.nodeType as CanvasNode['type'],
    contractVersion: item.props.nodeType === 'text' ? 3 : 1,
    title: item.props.title,
    x: 0, y: 0, w: 340, h: 260,
    ports: item.props.nodeType === 'processor'
      ? [...PROCESSOR_PORTS.in, ...PROCESSOR_PORTS.out]
      : [{ id: item.props.nodeType === 'agent' ? 'in-text' : 'out-text', name: 'text', dir: item.props.nodeType === 'agent' ? 'in' : 'out', type: 'text', cardinality: 'one', required: false }],
    params: { config: item.props.config },
    content: item.props.text ? { kind: 'text', text: item.props.text } : { kind: 'empty' },
    exec: { status: 'idle' },
    meta: {}
  })
  const file = {
    version: 1,
    meta: { id: 'p', name: 'real-host', createdAt: 0, updatedAt: 0, graphVersion: 1 },
    nodes: shapes.map(node),
    edges: [
      { id: 'source-agent', from: { nodeId: 'src', portId: 'out-text' }, to: { nodeId: 'shape:agent', portId: 'in-text' } },
      { id: 'source-proc', from: { nodeId: 'src', portId: 'out-text' }, to: { nodeId: 'proc', portId: 'in-value' } }
    ],
    groups: [],
    tldrawSnapshot: { store: byId }
  } as unknown as ProjectFile
  fixture.file = file
  fixture.db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run('p', 'real-host')
  const open = () => file
  const ledger = new FlowCommandLedger(fixture.db, open)
  const host = new FlowAgentDesktopHost(
    fixture.db,
    open,
    {
      ledger,
      isActive: () => true,
      deliver: async (grant) => {
        const command = grant.command
        const target = byId[command.targetNodeId]
        ledger.check({ projectId: command.projectId, commandId: command.commandId, leaseId: grant.leaseId })
        target.meta.nodeRun = {
          runId: grant.runId,
          status: 'success',
          startedAt: 0,
          finishedAt: 1,
          commandId: command.commandId,
          commandLeaseId: grant.leaseId,
          nodeExecutionId: 'real-execution',
          fixedInputs: command.inputs,
          inputs: Object.fromEntries(grant.inputs.map((input) => [input.targetPortId, input.versions.map((version, index) => ({
            nodeId: input.sources![index].nodeId,
            portId: input.sources![index].portId,
            assetId: version.ref.assetId,
            versionId: version.ref.versionId
          }))])),
          inputFingerprint: computeInputFingerprint({
            contractVersion: 1,
            config: target.props.config,
            text: target.props.text,
            sources: grant.inputs.flatMap((input) => input.versions.map((version, index) => ({
              portId: input.targetPortId,
              nodeId: input.sources![index].nodeId,
              sourcePortId: input.sources![index].portId,
              value: version.value
            })))
          }),
          outputPorts: ['out-value']
        }
        const source = grant.inputs[0]!.versions[0]!.value
        target.meta.nodeResult = JSON.stringify({ kind: 'text', text: `稿件：${source.kind === 'text' ? source.text : ''}` })
        file.meta.graphVersion++
        ledger.commit({ projectId: command.projectId, commandId: command.commandId })
      }
    },
    async () => ({
      decide: async (context) => context.receipts.length ? { kind: 'wait' } : { kind: 'execute', targetNodeId: 'proc' },
      discuss: async () => '真实讨论回复'
    })
  )
  return { host, file, byId }
}

describe('真实 Host/Store 外部 cooperate 四 action', () => {
  it('note/discuss/submit/revise 均经真实服务与宿主，持久化 external clientId，普通调用仍为 user', async () => {
    const f = realHostFixture()
    const service = new LocalAccessService({
      instanceId: randomUUID(),
      appVersion: 'test',
      exportDirectory: join(directory, 'exports'),
      activeProjectId: () => 'p',
      desktop: {
        async ask() { return { authorized: true } },
        async run() { throw new Error('cooperate 不占桌面写槽') }
      }
    })
    publishFlowAgentAccessPort({
      run: (raw) => f.host.run(raw),
      inspect: (query) => f.host.inspect(query),
      pause: (query) => f.host.pause(query),
      stop: (query) => f.host.stop(query),
      assertAgentScopeToolCalling: async () => undefined,
      cooperate: (raw) => f.host.cooperate(raw),
      collaboration: (query) => f.host.collaboration(query)
    } as never)
    const started = await f.host.run({
      projectId: 'p', nodeId: 'shape:agent', requestId: 'task-1', traceId: 'trace', spanId: 'span', action: 'start'
    })
    expect(started.task.state).toBe('waiting')
    const dispatch = (action: 'note' | 'discuss' | 'submit' | 'revise', revision: number, text: string) =>
      service.dispatch({
        apiVersion: 1,
        operationVersion: 1,
        operationId: 'flowAgent.cooperate',
        requestId: randomUUID(),
        idempotencyKey: `${Date.now()}:${randomUUID()}`,
        clientId: 'mcp-0123456789abcdef',
        expectedDataStoreId: service.dataStoreId,
        input: {
          projectId: 'p', nodeId: 'shape:agent', taskId: started.task.taskId,
          waitRevision: started.task.waitRevision, revision,
          eventId: `external-${action}`, action, text,
          ...(action === 'submit' ? { accepted: true } : {})
        }
      })

    for (const [action, text] of [
      ['note', '外部备注'],
      ['discuss', '外部讨论'],
      ['submit', '外部采用']
    ] as const) {
      const response = await dispatch(action, f.host.collaboration({ projectId: 'p', nodeId: 'shape:agent' })!.revision, text)
      expect(response.error, action).toBeUndefined()
      expect((response.data as any).messages.at(-1).actor).toEqual({
        kind: 'external', clientId: 'mcp-0123456789abcdef'
      })
    }
    const agentShape = f.byId['shape:agent']
    agentShape.props.text = '新的真实目标'
    const agentNode = f.file.nodes.find((node) => node.id === 'shape:agent')!
    agentNode.content = { kind: 'text', text: agentShape.props.text }
    const revised = await dispatch('revise', f.host.collaboration({ projectId: 'p', nodeId: 'shape:agent' })!.revision, agentShape.props.text)
    expect(revised.error).toBeUndefined()
    expect((revised.data as any).task).toMatchObject({ state: 'ready', prepared: true })

    const rows = fixture.db.prepare('SELECT body_json FROM flow_agent_collaboration ORDER BY revision').all() as Array<{ body_json: string }>
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => JSON.parse(row.body_json).actor)).toEqual(Array(4).fill({
      kind: 'external', clientId: 'mcp-0123456789abcdef'
    }))
    expect(rows.map((row) => JSON.parse(row.body_json).action)).toEqual(['note', 'discuss', 'submit', 'revise'])

    const current = f.host.collaboration({ projectId: 'p', nodeId: 'shape:agent' })!
    const gui = await f.host.cooperate({
      projectId: 'p', nodeId: 'shape:agent', taskId: current.task.taskId,
      waitRevision: current.task.waitRevision, revision: current.revision,
      eventId: 'ordinary-user-note', action: 'note', text: '普通用户备注'
    })
    expect(gui.messages.at(-1)?.actor).toEqual({ kind: 'user', roleId: 'owner' })
  })
})
