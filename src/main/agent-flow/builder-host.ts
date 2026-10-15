import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { ProjectFile } from '../../shared/types'
import {
  BuildPlanSchema,
  BuildRequestSchema,
  FLOW_BUILDER_CAPABILITY_CATALOG,
  type BuildPreview,
  type BuildRequest,
  type BuildCapability
} from '../../shared/agent-flow/builder'
import {
  AgentNodeConfigSchema,
  ReviewNodeConfigSchema
} from '../../shared/agent-flow/node-contracts'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { projectSemanticRevision } from './command-intent'
import type { ModelIdentity } from '../../shared/agent-flow/coordination'
import type { AgentModelPort } from './runtime'

type Shape = {
  x?: number
  y?: number
  props: { nodeType: string; config: string; text: string; title: string; w?: number; h?: number }
  meta?: Record<string, unknown>
}

const TARGETS: Record<
  BuildCapability,
  {
    type: 'processor' | 'image-gen' | 'image-edit' | 'video' | 'speech' | 'tts'
    contractVersion: 1 | 2 | 3 | 4 | 7
    inputPort: string
    outputPort: string
    config: (step: BuildPreview['plan']['steps'][number]) => string
    text: (step: BuildPreview['plan']['steps'][number]) => string
  }
> = {
  'text-template@1': {
    type: 'processor',
    contractVersion: 1,
    inputPort: 'in-value',
    outputPort: 'out-value',
    config: (step) =>
      JSON.stringify({ operation: 'template', field: '', template: step.template ?? '{{value}}' }),
    text: () => ''
  },
  'image-gen@3': {
    type: 'image-gen',
    contractVersion: 3,
    inputPort: 'in-text',
    outputPort: 'out-image',
    config: () => JSON.stringify({ count: 1, retry: { maxRetries: 0 } }),
    text: (step) => step.instruction ?? ''
  },
  'image-edit@2': {
    type: 'image-edit',
    contractVersion: 2,
    inputPort: 'in-image',
    outputPort: 'out-image',
    config: (step) =>
      JSON.stringify({
        version: 1,
        modelKey: '',
        size: 'auto',
        aspectRatio: 'auto',
        instruction: step.instruction ?? '',
        annotations: [],
        mask: { enabled: false, strokes: [], brushSize: 0.08, invert: false }
      }),
    text: () => ''
  },
  'video@7': {
    type: 'video',
    contractVersion: 7,
    inputPort: 'in-text',
    outputPort: 'out-video',
    config: () => JSON.stringify({ modelKey: '', mode: 'reference', params: {}, taskId: '' }),
    text: (step) => step.instruction ?? ''
  },
  'speech@4': {
    type: 'speech',
    contractVersion: 4,
    inputPort: 'in-text',
    outputPort: 'out-audio',
    config: () => JSON.stringify({ backend: 'minimax' }),
    text: () => ''
  },
  'tts@4': {
    type: 'tts',
    contractVersion: 4,
    inputPort: 'in-audio',
    outputPort: 'out-json',
    config: () => JSON.stringify({ backend: 'minimax' }),
    text: () => ''
  }
}
/** Proposals persist before any mutation. A saved graph, rather than renderer acknowledgement, proves commit. */
export class FlowBuilderHost {
  private readonly active = new Set<string>()
  constructor(
    private readonly db: Database.Database,
    private readonly open: (id: string) => ProjectFile | null,
    private readonly isActive: (id: string) => boolean,
    private readonly model: (
      identity: ModelIdentity,
      signal: AbortSignal
    ) => Promise<AgentModelPort>
  ) {}
  private saved(input: BuildRequest): { file: ProjectFile; shape: Shape } {
    const file = this.open(input.projectId)
    if (!file || !this.isActive(input.projectId))
      throw new AgentRuntimeError('FLOW_PROJECT_INACTIVE', 'builder')
    const shape = (file.tldrawSnapshot as { store: Record<string, Shape> }).store[input.nodeId]
    if (
      shape?.props.nodeType !== 'agent' ||
      AgentNodeConfigSchema.parse(JSON.parse(shape.props.config)).role !== 'builder'
    )
      throw new AgentRuntimeError('FLOW_BUILD_CONFIG_INVALID', 'builder')
    return { file, shape }
  }
  private read(input: BuildRequest): BuildPreview | null {
    const row = input.buildId
      ? this.db
          .prepare(
            'SELECT body_json FROM flow_builds WHERE project_id=? AND node_id=? AND build_id=?'
          )
          .get(input.projectId, input.nodeId, input.buildId)
      : this.db
          .prepare(
            'SELECT body_json FROM flow_builds WHERE project_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1'
          )
          .get(input.projectId, input.nodeId)
    if (!row) return null
    const raw = JSON.parse((row as { body_json: string }).body_json) as BuildPreview & {
      plan: {
        title: string
        topology?: 'sequential' | 'parallel-fork'
        steps: Array<Record<string, unknown>>
      }
      nodes: Array<
        Omit<BuildPreview['nodes'][number], 'contractVersion' | 'x' | 'y'> & {
          contractVersion?: number
          x?: number
          y?: number
        }
      >
    }
    // Persisted C3.3 previews predate the finite capability catalog and explicit node versions.
    // Their only build type was a sequential processor flow, so normalize them at the storage edge.
    const file = this.open(input.projectId)
    const anchor = (file?.tldrawSnapshot as { store: Record<string, Shape> } | undefined)?.store[
      input.nodeId
    ]
    return {
      ...raw,
      plan: BuildPlanSchema.parse({
        ...raw.plan,
        topology: raw.plan.topology ?? 'sequential',
        steps: raw.plan.steps.map((step) => ({
          ...step,
          capability: step.capability ?? 'text-template@1'
        }))
      }),
      nodes: raw.nodes.map((node, index) => ({
        ...node,
        contractVersion: node.contractVersion ?? 1,
        x:
          node.x ?? (anchor?.x ?? 0) + (anchor?.props.w ?? 340) + 100 + Math.floor(index / 2) * 440,
        y: node.y ?? (anchor?.y ?? 0) + (index % 2) * 360
      }))
    }
  }
  private save(preview: BuildPreview): void {
    this.db
      .prepare(
        'INSERT INTO flow_builds(project_id,node_id,build_id,body_json) VALUES (?,?,?,?) ON CONFLICT(project_id,build_id) DO UPDATE SET body_json=excluded.body_json'
      )
      .run(preview.projectId, preview.nodeId, preview.buildId, JSON.stringify(preview))
  }
  private committed(preview: BuildPreview, file: ProjectFile): boolean {
    const store = (file.tldrawSnapshot as { store: Record<string, Shape> }).store
    return (
      preview.nodes.every((n) => {
        const shape = store[n.id]
        return (
          shape?.meta?.flowBuildId === preview.buildId &&
          shape.props.nodeType === n.type &&
          shape.props.config === n.config &&
          shape.props.text === n.text &&
          shape.props.title === n.title &&
          file.nodes.some(
            (node) =>
              node.id === n.id && node.type === n.type && node.contractVersion === n.contractVersion
          )
        )
      }) &&
      preview.edges.every((e) =>
        file.edges.some(
          (edge) => canonicalFlowJson({ from: edge.from, to: edge.to }) === canonicalFlowJson(e)
        )
      )
    )
  }
  async handle(raw: BuildRequest): Promise<BuildPreview | null> {
    const input = BuildRequestSchema.parse(raw),
      { file, shape } = this.saved(input)
    const old = this.read(input)
    if (input.action === 'inspect') {
      if (old?.state === 'preview' && this.committed(old, file)) {
        old.state = 'committed'
        this.save(old)
      }
      return old
    }
    if (input.action !== 'propose') {
      if (!old) throw new AgentRuntimeError('FLOW_BUILD_MISSING', 'builder')
      if (this.committed(old, file)) {
        old.state = 'committed'
        this.save(old)
      }
      if (input.action === 'confirm') {
        if (old.state !== 'committed')
          throw new AgentRuntimeError('FLOW_BUILD_UNCONFIRMED', 'builder')
        return old
      }
      if (old.state !== 'preview') return old
      if (input.action === 'discard') {
        old.state = 'discarded'
        this.save(old)
        return old
      }
      if (projectSemanticRevision(file) !== old.semanticRevision)
        throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'builder')
      if (
        old.nodes.some(
          (n) => (file.tldrawSnapshot as { store: Record<string, unknown> }).store[n.id]
        )
      )
        throw new AgentRuntimeError('FLOW_BUILD_CONFLICT', 'builder')
      return old
    }
    const buildId = `build-${createHash('sha256')
      .update(JSON.stringify([input.projectId, input.nodeId, input.requestId]))
      .digest('hex')
      .slice(0, 24)}`
    const replay = this.read({ ...input, buildId })
    if (replay) return replay
    const key = JSON.stringify([input.projectId, input.nodeId])
    if (this.active.has(key)) throw new AgentRuntimeError('AGENT_TASK_OCCUPIED', 'builder')
    const config = AgentNodeConfigSchema.parse(JSON.parse(shape.props.config))
    if (
      !config.modelDefinitionId ||
      !shape.props.text.trim() ||
      config.allowedNodeIds.length !== 1 ||
      config.tools.length !== 1 ||
      config.tools[0].id !== 'graph.preview' ||
      config.tools[0].version !== '1' ||
      config.skills.length
    )
      throw new AgentRuntimeError('FLOW_BUILD_CONFIG_INVALID', 'builder')
    const source = file.nodes.find((n) => n.id === config.allowedNodeIds[0])
    if (
      !source ||
      source.type !== 'text' ||
      source.contractVersion !== 3 ||
      !source.ports.some((p) => p.id === 'out-text' && p.type === 'text')
    )
      throw new AgentRuntimeError('FLOW_BUILD_SOURCE_INVALID', 'builder')
    // Do not modify or include an occupied flow in a new build.
    if (
      this.db
        .prepare('SELECT 1 FROM flow_coordination_scope WHERE project_id=? AND node_id IN (?,?)')
        .get(input.projectId, input.nodeId, source.id)
    )
      throw new AgentRuntimeError('FLOW_CONTROL_OCCUPIED', 'builder')
    const semanticRevision = projectSemanticRevision(file)
    this.active.add(key)
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 30000)
    try {
      const model = await this.model(
        {
          projectId: input.projectId,
          agentNodeId: input.nodeId,
          taskId: buildId,
          config,
          traceId: input.traceId ?? buildId,
          spanId: input.spanId ?? `${buildId}-model`
        },
        controller.signal
      )
      if (!model.build) throw new AgentRuntimeError('AGENT_MODEL_TOOL_UNVERIFIED', 'builder')
      const plan = BuildPlanSchema.parse(
        await model.build(
          {
            goal: shape.props.text,
            capabilityCatalog: FLOW_BUILDER_CAPABILITY_CATALOG,
            topologies: ['sequential', 'parallel-fork']
          },
          controller.signal
        )
      )
      const boundedWork =
        plan.steps.length +
        plan.steps.reduce((total, step) => total + (step.review?.maxReworks ?? 0), 0)
      if (boundedWork > config.maxSteps)
        throw new AgentRuntimeError('FLOW_BUILD_BUDGET_INVALID', 'builder')
      if (controller.signal.aborted)
        throw new AgentRuntimeError('AGENT_CANCELLED_OR_TIMED_OUT', 'builder')
      const current = this.saved(input)
      if (projectSemanticRevision(current.file) !== semanticRevision)
        throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'builder')
      const nodeId = (suffix: string): string => `shape:${buildId}-${suffix}`
      const main = nodeId('main'),
        state = nodeId('state')
      const agentConfig = (
        role: 'coordinator' | 'specialist',
        ids: string[],
        mode: string = 'autonomous',
        relations: object[] = [],
        maxParallelTasks?: number,
        reviewEnabled = false
      ): string =>
        JSON.stringify({
          schemaVersion: 1,
          role,
          interactionMode: mode,
          modelDefinitionId: config.modelDefinitionId,
          skills: [],
          tools:
            role === 'coordinator'
              ? [
                  { id: 'agent.dispatch', version: '1' },
                  ...(reviewEnabled ? [{ id: 'review.execute', version: '1' }] : [])
                ]
              : [{ id: 'node.execute', version: '1' }],
          allowedNodeIds: ids,
          maxSteps: config.maxSteps,
          ...(maxParallelTasks ? { maxParallelTasks } : {}),
          relations
        })
      const children = plan.steps.map((_, i) => nodeId(`agent-${i}`))
      const reviews = plan.steps.flatMap((step, i) => (step.review ? [nodeId(`review-${i}`)] : []))
      const relation = (
        kind: string,
        from: string,
        to: string
      ): { relationId: string; kind: string; sourceNodeId: string; targetNodeId: string } => ({
        relationId: `${buildId}-${from.split('-').at(-1)}-${kind}-${to.split('-').at(-1)}`,
        kind,
        sourceNodeId: from,
        targetNodeId: to
      })
      const events = [
        'flow.started',
        'agent.dispatched',
        'agent.completed',
        'review.started',
        'review.passed',
        'review.completed',
        'review.rejected',
        'rework.created',
        'rework.started',
        'rework.completed',
        'human.wait',
        'human.continue',
        'flow.paused',
        'flow.completed'
      ]
      const preview: BuildPreview = {
        buildId,
        projectId: input.projectId,
        nodeId: input.nodeId,
        semanticRevision,
        state: 'preview',
        plan,
        edges: [],
        nodes: [
          {
            id: main,
            type: 'agent',
            title: plan.title,
            text:
              `${shape.props.text}\n` +
              (plan.topology === 'parallel-fork'
                ? '各分支互相独立，必须并行执行；完成后按目标选择成果交付，未选择的成果仍保留在分支节点。'
                : '按已连线的顺序依赖执行；只有真实成果可用于下一步。'),
            config: agentConfig(
              'coordinator',
              [...children, ...reviews],
              'autonomous',
              [
                relation('observes', main, state),
                ...[...children, ...reviews].map((id) => relation('controls', main, id))
              ],
              plan.topology === 'parallel-fork' ? plan.steps.length : 1,
              reviews.length > 0
            ),
            contractVersion: 1,
            x: 0,
            y: 0
          },
          {
            id: state,
            type: 'state-machine',
            title: '流程状态',
            text: '',
            config: JSON.stringify({
              schemaVersion: 1,
              initialState: 'idle',
              states: ['idle', 'active', 'waiting', 'completed'],
              transitions: [
                { from: 'idle', event: 'flow.started', to: 'active' },
                ...['active', 'waiting'].flatMap((from) =>
                  events
                    .filter((event) => event !== 'flow.started')
                    .map((event) => ({
                      from,
                      event,
                      to:
                        event === 'flow.completed'
                          ? 'completed'
                          : ['human.wait', 'flow.paused'].includes(event)
                            ? 'waiting'
                            : 'active'
                    }))
                )
              ],
              relations: []
            }),
            contractVersion: 1,
            x: 0,
            y: 0
          }
        ]
      }
      plan.steps.forEach((step, i) => {
        const target = nodeId(`target-${i}`),
          child = children[i],
          capability = TARGETS[step.capability]
        const inputFrom =
          plan.topology === 'parallel-fork' || i === 0
            ? { nodeId: source.id, portId: 'out-text' }
            : {
                nodeId: nodeId(`target-${i - 1}`),
                portId: TARGETS[plan.steps[i - 1].capability].outputPort
              }
        preview.nodes.push(
          {
            id: child,
            type: 'agent',
            title: step.title,
            text: step.goal,
            config: agentConfig('specialist', [target], step.mode, [
              relation('controls', child, target)
            ]),
            contractVersion: 1,
            x: 0,
            y: 0
          },
          {
            id: target,
            type: capability.type,
            title: `${step.title} · ${capability.type}`,
            text: capability.text(step),
            config: capability.config(step),
            contractVersion: capability.contractVersion,
            x: 0,
            y: 0
          }
        )
        preview.edges.push(
          {
            from: { nodeId: source.id, portId: 'out-text' },
            to: { nodeId: child, portId: 'in-text' }
          },
          { from: inputFrom, to: { nodeId: target, portId: capability.inputPort } }
        )
        if (step.review) {
          const review = nodeId(`review-${i}`),
            videoReview = step.capability === 'video@7',
            gatedNodeIds = plan.topology === 'sequential' ? children.slice(i + 1) : [],
            subject = videoReview
              ? { nodeId: target, portId: 'out-video' }
              : { nodeId: child, portId: 'out-text' },
            reviewInput = videoReview ? 'in-video' : 'in-text',
            reviewRelations = [
              ...gatedNodeIds.map((id) => relation('review-gate', review, id)),
              ...(step.review.rejectPolicy === 'rework' ? [relation('rework', review, child)] : [])
            ]
          const reviewConfig = ReviewNodeConfigSchema.parse({
            schemaVersion: 1,
            rulesVersion: 'builder-review-v1',
            reviewMode: videoReview ? 'sampled-video' : 'text-json',
            modelDefinitionId: config.modelDefinitionId,
            rejectPolicy: step.review.rejectPolicy,
            maxReworks: step.review.maxReworks,
            responsibleNodeId: child,
            subjectSources: [subject],
            gatedNodeIds,
            relations: reviewRelations
          })
          preview.nodes.push({
            id: review,
            type: 'ai-review',
            title: `${step.title} · 审核`,
            text: step.review.criteria,
            config: JSON.stringify(reviewConfig),
            contractVersion: 1,
            x: 0,
            y: 0
          })
          preview.edges.push({
            from: subject,
            to: { nodeId: review, portId: reviewInput }
          })
        }
      })
      this.assignPreviewPositions(preview, current.file, current.shape)
      this.save(preview)
      return preview
    } finally {
      clearTimeout(timer)
      this.active.delete(key)
    }
  }

  private assignPreviewPositions(preview: BuildPreview, file: ProjectFile, builder: Shape): void {
    const width = 340,
      height = 260,
      horizontalGap = 100,
      verticalGap = 100,
      columnGap = width + horizontalGap,
      rowGap = height + verticalGap,
      extentWidth = preview.plan.steps.length * columnGap + width,
      hasReview = preview.plan.steps.some((step) => step.review),
      extentHeight = (hasReview ? 2 : 1) * rowGap + height
    const builderX = builder.x ?? 0,
      builderY = builder.y ?? 0,
      builderWidth = builder.props.w ?? width,
      builderHeight = builder.props.h ?? height
    const relative = preview.nodes.map((node) => {
      const main = node.id.endsWith('-main')
      const state = node.id.endsWith('-state')
      const targetIndex = preview.plan.steps.findIndex((_, index) =>
        node.id.endsWith(`-target-${index}`)
      )
      const agentIndex = preview.plan.steps.findIndex((_, index) =>
        node.id.endsWith(`-agent-${index}`)
      )
      const reviewIndex = preview.plan.steps.findIndex(
        (step, index) => Boolean(step.review) && node.id.endsWith(`-review-${index}`)
      )
      const index = targetIndex >= 0 ? targetIndex : agentIndex >= 0 ? agentIndex : reviewIndex
      if (main) return { node, x: 0, y: 0 }
      if (state) return { node, x: 0, y: rowGap }
      if (index < 0) throw new AgentRuntimeError('FLOW_BUILD_CONFIG_INVALID', 'builder')
      return {
        node,
        x: (index + 1) * columnGap,
        y: targetIndex >= 0 ? rowGap : reviewIndex >= 0 ? 2 * rowGap : 0
      }
    })
    const shapes = (file.tldrawSnapshot as { store: Record<string, Shape & { type?: string }> })
      .store
    const obstacles = Object.values(shapes).flatMap((shape) => {
      if (shape.type !== 'node-card' || !Number.isFinite(shape.x) || !Number.isFinite(shape.y))
        return []
      return [
        {
          x: shape.x!,
          y: shape.y!,
          width: shape.props.w ?? width,
          height: shape.props.h ?? height
        }
      ]
    })
    const candidates = [
      { x: builderX + builderWidth + 120, y: builderY },
      { x: builderX, y: builderY + builderHeight + 120 },
      { x: builderX, y: builderY - extentHeight - 120 }
    ]
    let placement: { x: number; y: number } | undefined
    for (const origin of candidates) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const x = origin.x + attempt * (extentWidth + 120),
          y = origin.y
        const overlaps = relative.some((item) =>
          obstacles.some(
            (obstacle) =>
              x + item.x < obstacle.x + obstacle.width + 32 &&
              x + item.x + width + 32 > obstacle.x &&
              y + item.y < obstacle.y + obstacle.height + 32 &&
              y + item.y + height + 32 > obstacle.y
          )
        )
        if (!overlaps) {
          placement = { x, y }
          break
        }
      }
      if (placement) break
    }
    if (!placement) throw new AgentRuntimeError('FLOW_BUILD_SPACE_UNAVAILABLE', 'builder')
    for (const item of relative) {
      item.node.x = placement.x + item.x
      item.node.y = placement.y + item.y
    }
  }
}
