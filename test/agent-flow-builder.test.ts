import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../src/main/store/db-migrations'
import { FlowBuilderHost } from '../src/main/agent-flow/builder-host'
import type { ProjectFile } from '../src/shared/types'
import type { AgentModelPort } from '../src/main/agent-flow/runtime'
import { BuildPlanSchema } from '../src/shared/agent-flow/builder'
import {
  AgentNodeConfigSchema,
  ReviewNodeConfigSchema,
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
    x: id === 'builder' ? 0 : -500,
    y: 0,
    props: {
      w: 340,
      h: 260,
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
    duringBuild = () => {},
    buildPlan = BuildPlanSchema.parse({
      title: '整理流程',
      steps: [
        { title: '整理', goal: '加整理标题', mode: 'autonomous', template: '整理：{{value}}' },
        { title: '交付', goal: '人工确认交付', mode: 'collaborative', template: '交付：{{value}}' }
      ]
    })
  const model: AgentModelPort = {
    decide: async () => ({ kind: 'wait' }),
    build: async (context) => {
      calls++
      expect(JSON.stringify(context)).not.toContain('private-builder-material')
      expect(context.capabilityCatalog.map((item) => item.id)).toEqual([
        'text-template@1',
        'image-gen@3',
        'image-edit@2',
        'video@7',
        'speech@4',
        'tts@4'
      ])
      expect(context.topologies).toEqual(['sequential', 'parallel-fork'])
      duringBuild()
      return buildPlan
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
    setPlan: (plan: unknown) => {
      buildPlan = BuildPlanSchema.parse(plan)
    },
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
  it('normalizes persisted previews from the original sequential text builder', async () => {
    const f = fixture(),
      preview = (await f.host.handle(request))!
    const { topology: _topology, ...legacyPlan } = preview.plan
    const legacy = {
      ...preview,
      plan: {
        ...legacyPlan,
        steps: preview.plan.steps.map(({ capability: _capability, ...step }) => step)
      },
      nodes: preview.nodes.map(
        ({ contractVersion: _contractVersion, x: _x, y: _y, ...node }) => node
      )
    }
    f.db
      .prepare('UPDATE flow_builds SET body_json=? WHERE project_id=? AND build_id=?')
      .run(JSON.stringify(legacy), preview.projectId, preview.buildId)
    const reopened = new FlowBuilderHost(
      f.db,
      () => f.file,
      () => true,
      async () => {
        throw new Error('must not call')
      }
    )
    const normalized = (await reopened.handle({ ...request, action: 'inspect' }))!
    expect(normalized.plan).toEqual(preview.plan)
    expect(normalized.nodes.map((node) => node.contractVersion)).toEqual(
      Array(preview.nodes.length).fill(1)
    )
    expect(normalized.nodes.map((node) => [node.x, node.y])).toEqual(
      preview.nodes.map((_, index) => [440 + Math.floor(index / 2) * 440, (index % 2) * 360])
    )
  })
  it('assigns stable collision-free page positions to the proposed canvas graph', async () => {
    const f = fixture()
    const blocker = {
      ...f.store.text,
      id: 'shape:blocker',
      x: 460,
      y: 0,
      props: { ...f.store.text.props, title: 'Existing node' }
    }
    f.store['shape:blocker'] = blocker
    f.file.nodes.push({ ...f.file.nodes[1], id: 'shape:blocker' })
    const preview = (await f.host.handle(request))!
    expect(preview.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(
      true
    )
    expect(preview.nodes[0].x).toBeGreaterThan(460)
    expect(
      preview.nodes.every(
        (node) =>
          node.x + 340 <= blocker.x ||
          node.x >= blocker.x + blocker.props.w ||
          node.y + 260 <= blocker.y ||
          node.y >= blocker.y + blocker.props.h
      )
    ).toBe(true)
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

  it('builds a versioned image generation and edit chain with host-owned ports/config', async () => {
    const f = fixture()
    f.setPlan({
      title: '制作并修整图片',
      topology: 'sequential',
      steps: [
        {
          title: '生成初稿',
          goal: '根据材料生成图片',
          mode: 'autonomous',
          capability: 'image-gen@3',
          instruction: 'Create a clean editorial landscape illustration.'
        },
        {
          title: '局部修整',
          goal: '保留主体并改善背景',
          mode: 'collaborative',
          capability: 'image-edit@2',
          instruction: 'Keep the subject fixed and soften the background.'
        }
      ]
    })
    const preview = (await f.host.handle(request))!
    const generated = preview.nodes.find((node) => node.type === 'image-gen')!
    const edited = preview.nodes.find((node) => node.type === 'image-edit')!
    expect(preview.nodes.map((node) => [node.type, node.contractVersion])).toEqual([
      ['agent', 1],
      ['state-machine', 1],
      ['agent', 1],
      ['image-gen', 3],
      ['agent', 1],
      ['image-edit', 2]
    ])
    expect(JSON.parse(generated.config)).toEqual({ count: 1, retry: { maxRetries: 0 } })
    expect(JSON.parse(edited.config).instruction).toBe(
      'Keep the subject fixed and soften the background.'
    )
    expect(
      preview.edges.some(
        (edge) =>
          edge.from.nodeId === generated.id &&
          edge.from.portId === 'out-image' &&
          edge.to.nodeId === edited.id &&
          edge.to.portId === 'in-image'
      )
    ).toBe(true)
    const specialist = preview.nodes.find(
      (node) => node.type === 'agent' && node.title === '局部修整'
    )!
    expect(AgentNodeConfigSchema.parse(JSON.parse(specialist.config)).allowedNodeIds).toEqual([
      edited.id
    ])
  })

  it('builds a text review node with fixed subject, gate, and rework scope', async () => {
    const f = fixture()
    f.setPlan({
      title: '审核后继续',
      steps: [
        {
          title: '整理',
          goal: '整理材料',
          mode: 'autonomous',
          template: '整理：{{value}}',
          review: {
            criteria: '结果必须保留全部来源事实。',
            rejectPolicy: 'rework',
            maxReworks: 2
          }
        },
        {
          title: '交付',
          goal: '形成最终交付',
          mode: 'collaborative',
          template: '交付：{{value}}'
        }
      ]
    })
    const preview = (await f.host.handle(request))!
    const reviewNode = preview.nodes.find((node) => node.type === 'ai-review')!
    const review = ReviewNodeConfigSchema.parse(JSON.parse(reviewNode.config))
    const main = AgentNodeConfigSchema.parse(
      JSON.parse(
        preview.nodes.find(
          (node) => node.type === 'agent' && JSON.parse(node.config).role === 'coordinator'
        )!.config
      )
    )
    const firstAgent = preview.nodes.find((node) => node.type === 'agent' && node.title === '整理')!
    const secondAgent = preview.nodes.find(
      (node) => node.type === 'agent' && node.title === '交付'
    )!
    expect(reviewNode.contractVersion).toBe(1)
    expect(review.responsibleNodeId).toBe(firstAgent.id)
    expect(review.subjectSources[0].portId).toBe('out-text')
    expect(review.maxReworks).toBe(2)
    expect(review.gatedNodeIds).toEqual([secondAgent.id])
    expect(main.tools.map((tool) => tool.id)).toContain('review.execute')
    expect(main.allowedNodeIds).toContain(reviewNode.id)
    expect(
      preview.edges.some(
        (edge) =>
          edge.from.nodeId === review.subjectSources[0].nodeId &&
          edge.from.portId === 'out-text' &&
          edge.to.nodeId === reviewNode.id &&
          edge.to.portId === 'in-text'
      )
    ).toBe(true)
  })

  it('rejects review and rework totals that exceed the host configured execution budget', async () => {
    const f = fixture()
    f.setPlan({
      title: '超预算流程',
      steps: Array.from({ length: 4 }, (_, index) => ({
        title: `步骤 ${index + 1}`,
        goal: '处理固定输入',
        mode: 'autonomous',
        template: `步骤${index + 1}：{{value}}`,
        review: {
          criteria: '结果符合指定格式。',
          rejectPolicy: 'rework',
          maxReworks: 3
        }
      }))
    })
    await expect(f.host.handle(request)).rejects.toMatchObject({
      code: 'FLOW_BUILD_BUDGET_INVALID'
    })
    expect(f.file.nodes).toHaveLength(2)
  })

  it('builds exactly two independent parallel branches and sets the coordinator budget', async () => {
    const f = fixture()
    f.setPlan({
      title: '并行整理并配图',
      topology: 'parallel-fork',
      steps: [
        {
          title: '整理材料',
          goal: '整理成清晰文字',
          mode: 'autonomous',
          capability: 'text-template@1',
          template: '整理：{{value}}'
        },
        {
          title: '配图',
          goal: '生成独立配图',
          mode: 'autonomous',
          capability: 'image-gen@3',
          instruction: 'Create one image from the source material.'
        }
      ]
    })
    const preview = (await f.host.handle(request))!
    const main = AgentNodeConfigSchema.parse(
      JSON.parse(preview.nodes.find((node) => node.title === '并行整理并配图')!.config)
    )
    const targetIds = preview.nodes
      .filter((node) => node.type === 'processor' || node.type === 'image-gen')
      .map((node) => node.id)
    const branchAgentIds = preview.nodes
      .filter((node) => node.type === 'agent' && node.title !== '并行整理并配图')
      .map((node) => node.id)
    expect(main.maxParallelTasks).toBe(2)
    expect(main.allowedNodeIds).toHaveLength(2)
    expect(main.allowedNodeIds).toEqual(branchAgentIds)
    expect(
      preview.edges.filter(
        (edge) =>
          edge.from.nodeId === 'text' &&
          branchAgentIds.includes(edge.to.nodeId) &&
          edge.to.portId === 'in-text'
      )
    ).toHaveLength(2)
    expect(preview.edges.filter((edge) => edge.to.nodeId === targetIds[1])).toEqual([
      expect.objectContaining({
        from: { nodeId: 'text', portId: 'out-text' },
        to: { nodeId: targetIds[1], portId: 'in-text' }
      })
    ])
    expect(
      BuildPlanSchema.safeParse({
        title: 'bad parallel',
        topology: 'parallel-fork',
        steps: Array(5).fill({
          title: 'branch',
          goal: 'goal',
          mode: 'autonomous',
          template: '{{value}}'
        })
      }).success
    ).toBe(false)
  })

  it('previews and commits three independent branches with a matching concurrency cap', async () => {
    const f = fixture()
    f.setPlan({
      title: '三路并行整理',
      topology: 'parallel-fork',
      steps: [
        { title: '摘要', goal: '生成摘要', mode: 'autonomous', template: '摘要：{{value}}' },
        { title: '要点', goal: '提取要点', mode: 'autonomous', template: '要点：{{value}}' },
        { title: '标签', goal: '形成标签', mode: 'autonomous', template: '标签：{{value}}' }
      ]
    })
    const preview = (await f.host.handle(request))!
    const mainNode = preview.nodes.find((node) => node.title === '三路并行整理')!
    const main = AgentNodeConfigSchema.parse(JSON.parse(mainNode.config))
    const children = preview.nodes.filter(
      (node) => node.type === 'agent' && node.id !== mainNode.id
    )
    expect(preview.plan.steps).toHaveLength(3)
    expect(children).toHaveLength(3)
    expect(main.maxParallelTasks).toBe(3)
    expect(
      preview.edges.filter(
        (edge) => edge.from.nodeId === 'text' && children.some((child) => child.id === edge.to.nodeId)
      )
    ).toHaveLength(3)
    expect(new Set(preview.nodes.map((node) => `${node.x},${node.y}`)).size).toBe(
      preview.nodes.length
    )
  })

  it('proposes a versioned video node without choosing a provider model', async () => {
    const f = fixture()
    f.setPlan({
      title: '视频生成流程',
      steps: [
        {
          title: '生成视频',
          goal: '描述要生成的场景',
          mode: 'autonomous',
          capability: 'video@7',
          instruction: 'A small boat crosses a still lake at dawn.',
          review: {
            criteria: 'The four sampled frames must show the boat in the lake.',
            rejectPolicy: 'rework',
            maxReworks: 1
          }
        }
      ]
    })
    const preview = (await f.host.handle(request))!
    const video = preview.nodes.find((node) => node.type === 'video')!
    expect(video.contractVersion).toBe(7)
    expect(video.text).toBe('A small boat crosses a still lake at dawn.')
    expect(JSON.parse(video.config)).toEqual({
      modelKey: '',
      mode: 'reference',
      params: {},
      taskId: ''
    })
    const reviewNode = preview.nodes.find((node) => node.type === 'ai-review')!
    const review = ReviewNodeConfigSchema.parse(JSON.parse(reviewNode.config))
    expect(review.reviewMode).toBe('sampled-video')
    expect(review.subjectSources).toEqual([{ nodeId: video.id, portId: 'out-video' }])
    expect(review.gatedNodeIds).toEqual([])
    expect(
      preview.edges.some(
        (edge) =>
          edge.from.nodeId === 'text' &&
          edge.from.portId === 'out-text' &&
          edge.to.nodeId === video.id &&
          edge.to.portId === 'in-text'
      )
    ).toBe(true)
  })
})
