import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { ProjectFile } from '../../shared/types'
import {
  BuildPlanSchema,
  BuildRequestSchema,
  type BuildPreview,
  type BuildRequest
} from '../../shared/agent-flow/builder'
import { AgentNodeConfigSchema } from '../../shared/agent-flow/node-contracts'
import { AgentRuntimeError } from '../../shared/agent-flow/runtime-contracts'
import { canonicalFlowJson } from '../../shared/agent-flow/semantic-revision'
import { projectSemanticRevision } from './command-intent'
import type { ModelIdentity } from '../../shared/agent-flow/coordination'
import type { AgentModelPort } from './runtime'

type Shape = {
  props: { nodeType: string; config: string; text: string; title: string }
  meta?: Record<string, unknown>
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
    return row ? JSON.parse((row as { body_json: string }).body_json) : null
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
            (node) => node.id === n.id && node.type === n.type && node.contractVersion === 1
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
          { goal: shape.props.text, capability: 'sequential-text-template@1' },
          controller.signal
        )
      )
      if (controller.signal.aborted)
        throw new AgentRuntimeError('AGENT_CANCELLED_OR_TIMED_OUT', 'builder')
      if (projectSemanticRevision(this.saved(input).file) !== semanticRevision)
        throw new AgentRuntimeError('FLOW_REVISION_CONFLICT', 'builder')
      const nodeId = (suffix: string): string => `shape:${buildId}-${suffix}`
      const main = nodeId('main'),
        state = nodeId('state')
      const agentConfig = (
        role: 'coordinator' | 'specialist',
        ids: string[],
        mode: string = 'autonomous',
        relations: object[] = []
      ): string =>
        JSON.stringify({
          schemaVersion: 1,
          role,
          interactionMode: mode,
          modelDefinitionId: config.modelDefinitionId,
          skills: [],
          tools: [{ id: role === 'coordinator' ? 'agent.dispatch' : 'node.execute', version: '1' }],
          allowedNodeIds: ids,
          maxSteps: config.maxSteps,
          relations
        })
      const children = plan.steps.map((_, i) => nodeId(`agent-${i}`))
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
            text: shape.props.text,
            config: agentConfig('coordinator', children, 'autonomous', [
              relation('observes', main, state),
              ...children.map((id) => relation('controls', main, id))
            ])
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
            })
          }
        ]
      }
      plan.steps.forEach((step, i) => {
        const processor = nodeId(`processor-${i}`),
          child = children[i]
        const from =
          i === 0
            ? { nodeId: source.id, portId: 'out-text' }
            : { nodeId: children[i - 1], portId: 'out-text' }
        preview.nodes.push(
          {
            id: child,
            type: 'agent',
            title: step.title,
            text: step.goal,
            config: agentConfig('specialist', [processor], step.mode, [
              relation('controls', child, processor)
            ])
          },
          {
            id: processor,
            type: 'processor',
            title: `${step.title} · 文本模板`,
            text: '',
            config: JSON.stringify({ operation: 'template', field: '', template: step.template })
          }
        )
        preview.edges.push(
          { from, to: { nodeId: child, portId: 'in-text' } },
          { from, to: { nodeId: processor, portId: 'in-value' } }
        )
      })
      this.save(preview)
      return preview
    } finally {
      clearTimeout(timer)
      this.active.delete(key)
    }
  }
}
