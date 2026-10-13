import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowBuilderHost } from '../src/main/agent-flow/builder-host'
import type { ProjectFile } from '../src/shared/types'
import type { AgentModelPort } from '../src/main/agent-flow/runtime'
import { BuildPlanSchema } from '../src/shared/agent-flow/builder'
import {
  AgentNodeConfigSchema,
  StateMachineNodeConfigSchema
} from '../src/shared/agent-flow/node-contracts'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  migrateDatabase(db)
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,0,0)').run(
    'p',
    'isolated'
  )
  const shape = (id: string, type: string, text = '', config: object = {}) => ({
    id,
    type: 'node-card',
    props: {
      nodeType: type,
      title: id,
      text,
      config: JSON.stringify(config),
      mediaId: '',
      mediaPath: '',
      mediaMime: ''
    },
    meta: {}
  })
  const store: Record<string, ReturnType<typeof shape>> = {
    builder: shape('builder', 'agent', '为材料增加整理与交付标题', {
      schemaVersion: 1,
      role: 'builder',
      interactionMode: 'collaborative',
      modelDefinitionId: 'fixture',
      skills: [],
      tools: [{ id: 'graph.preview', version: '1' }],
      allowedNodeIds: ['text'],
      maxSteps: 12,
      relations: []
    }),
    text: shape('text', 'text', 'private-builder-material')
  }
  const file: ProjectFile = {
    version: 1,
    meta: { id: 'p', name: 'test', createdAt: 0, updatedAt: 0, graphVersion: 0 },
    nodes: ['builder', 'text'].map((id) => ({
      id,
      type: store[id].props.nodeType,
          contractVersion: id === 'text' ? 3 : 1,
      ports:
        id === 'text'
          ? [{ id: 'out-text', dir: 'out', type: 'text', cardinality: 'one', required: true }]
          : [],
      params: { config: store[id].props.config },
      content: { kind: 'text', text: store[id].props.text }
    })) as ProjectFile['nodes'],
    edges: [],
    groups: [],
    tldrawSnapshot: { store }
  }
  let calls = 0,
    duringBuild = () => {}
  const model: AgentModelPort = {
    decide: async () => ({ kind: 'wait' }),
    build: async (context) => {
      calls++
      expect(JSON.stringify(context)).not.toContain('private-builder-material')
      duringBuild()
      return {
        title: '整理流程',
        steps: [
          { title: '整理', goal: '加整理标题', mode: 'autonomous', template: '整理：{{value}}' },
          {
            title: '交付',
            goal: '人工确认交付',
            mode: 'collaborative',
            template: '交付：{{value}}'
          }
        ]
      }
    }
  }
  const host = new FlowBuilderHost(
    db,
    () => file,
    () => true,
    async () => model
  )
  return {
    db,
    host,
    file,
    store,
    calls: () => calls,
    during: (fn: () => void) => {
      duringBuild = fn
    }
  }
}
const request = { projectId: 'p', nodeId: 'builder', action: 'propose' as const, requestId: 'one' }
describe('trusted graph builder', () => {
  it('persists a bounded preview without reading material or changing graph; replays proposals', async () => {
    const f = fixture(),
      before = JSON.stringify(f.file)
    const p = (await f.host.handle(request))!
    expect(JSON.stringify(f.file)).toBe(before)
    expect(p.state).toBe('preview')
    expect(p.nodes).toHaveLength(6)
    expect(p.edges).toHaveLength(4)
    for (const node of p.nodes.filter((n) => n.type === 'agent'))
      AgentNodeConfigSchema.parse(JSON.parse(node.config))
    StateMachineNodeConfigSchema.parse(
      JSON.parse(p.nodes.find((n) => n.type === 'state-machine')!.config)
    )
    expect(await f.host.handle(request)).toEqual(p)
    expect(f.calls()).toBe(1)
    const reopened = new FlowBuilderHost(
      f.db,
      () => f.file,
      () => true,
      async () => {
        throw new Error('must not call')
      }
    )
    expect(await reopened.handle({ ...request, action: 'inspect' })).toEqual(p)
    expect(await reopened.handle({ ...request, action: 'authorize', buildId: p.buildId })).toEqual(
      p
    )
  })
  it('rejects edits during proposal or between preview and commit', async () => {
    const f = fixture(),
      p = (await f.host.handle(request))!
    f.store.text.props.text = 'changed'
    await expect(
      f.host.handle({ ...request, action: 'authorize', buildId: p.buildId })
    ).rejects.toMatchObject({ code: 'FLOW_REVISION_CONFLICT' })
    f.during(() => {
      f.store.text.props.text = 'changed again'
    })
    await expect(f.host.handle({ ...request, requestId: 'two' })).rejects.toMatchObject({
      code: 'FLOW_REVISION_CONFLICT'
    })
  })
  it('confirms only the complete saved graph and reconciles a lost confirmation; cancellation never mutates', async () => {
    const f = fixture(),
      p = (await f.host.handle(request))!
    await expect(
      f.host.handle({ ...request, action: 'confirm', buildId: p.buildId })
    ).rejects.toMatchObject({ code: 'FLOW_BUILD_UNCONFIRMED' })
    for (const n of p.nodes) {
      f.store[n.id] = {
        id: n.id,
        type: 'node-card',
        props: {
          nodeType: n.type,
          title: n.title,
          text: n.text,
          config: n.config,
          mediaId: '',
          mediaPath: '',
          mediaMime: ''
        },
        meta: { flowBuildId: p.buildId }
      }
      f.file.nodes.push({
        id: n.id,
        type: n.type,
        contractVersion: 1
      } as ProjectFile['nodes'][number])
    }
    expect((await f.host.handle({ ...request, action: 'inspect' }))?.state).toBe('preview')
    f.file.edges = p.edges.map((e, i) => ({ id: `edge-${i}`, ...e }))
    expect((await f.host.handle({ ...request, action: 'inspect' }))?.state).toBe('committed')
    expect(
      (await f.host.handle({ ...request, action: 'authorize', buildId: p.buildId }))?.state
    ).toBe('committed')
    const second = fixture(),
      q = (await second.host.handle(request))!
    expect(
      (await second.host.handle({ ...request, action: 'discard', buildId: q.buildId }))?.state
    ).toBe('discarded')
    expect(second.file.nodes).toHaveLength(2)
  })
  it('rejects missing source/tool and unsupported or unbounded plans', async () => {
    const f = fixture()
    f.store.text.props.nodeType = 'image'
    f.file.nodes[1].type = 'image'
    await expect(f.host.handle(request)).rejects.toMatchObject({
      code: 'FLOW_BUILD_SOURCE_INVALID'
    })
    expect(
      BuildPlanSchema.safeParse({
        title: 'bad',
        steps: [{ title: 'bad', goal: 'bad', mode: 'autonomous', template: 'no input' }]
      }).success
    ).toBe(false)
    expect(
      BuildPlanSchema.safeParse({
        title: 'bad',
        steps: Array(5).fill({
          title: 'step',
          goal: 'goal',
          mode: 'autonomous',
          template: '{{value}}'
        })
      }).success
    ).toBe(false)
  })
})
