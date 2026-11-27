import {
  AgentNodeConfigSchema,
  HumanTaskNodeConfigSchema,
  ReviewNodeConfigSchema,
  StateMachineNodeConfigSchema
} from './node-contracts'
import {
  validateFlowGraph,
  validateFlowGraphRuntime,
  deriveFlowAgentAllowedNodeIds,
  deriveFlowReviewBindings,
  flowNodeCapabilityRef,
  canvasNodeId,
  type FlowGraph,
  type FlowNode,
  type FlowGraphError
} from './flow-graph'
import {
  buildCapabilityCatalog,
  findCapability,
  type CapabilityDescriptor
} from './capability-catalog'
import { layoutGraph } from '../flow-layout'
import { resolveNodeParams } from './node-params'

// 保留现有编译器导出路径；实现与 validate 共用，避免碰撞判定漂移。
export { canvasNodeId }

/**
 * O4-P2 FlowGraph 纯编译器：把已校验的 FlowGraph IR 编译为画布语义图（节点配置 + 边 +
 * 派生状态机），与 builder-host 的 BuildPreview.nodes/edges 同构。编译目标=画布图
 * （D1：画布是唯一可编辑定义），交现有协调器执行；本文件不接执行、不写画布、无副作用。
 *
 * 复用既有节点契约 schema 保证编译产物配置合法。条件/循环的完整状态机推导与图路由执行
 * 属 P3+；本阶段派生一个结构合法的基础状态机（顺序语义），并保留循环节点声明。
 */
export interface CompiledNode {
  id: string
  type: string
  title: string
  text: string
  config: string
  contractVersion: number
  x: number
  y: number
}
export interface CompiledEdge {
  from: { nodeId: string; portId: string }
  to: { nodeId: string; portId: string }
}
export interface CompiledGraph {
  nodes: CompiledNode[]
  edges: CompiledEdge[]
  coordinatorNodeId: string
  stateNodeId: string
  runnable: boolean
  runtimeErrors: FlowGraphError[]
}

/**
 * P5：外部 FlowGraph 建图预览（持久化到 flow_builds，source='graph'）。与 BuildPreview
 * 同构（buildId/projectId/nodeId/semanticRevision/state/nodes/edges），但以 graph 取代
 * builder 的 plan，节点含 human-task 等编译产物类型。nodeId 锚点=编译 coordinator id。
 * 落画布复用渲染器权威 commitFlowBuild（只消费 nodes/edges/buildId/semanticRevision）。
 */
export interface FlowGraphPreview {
  source: 'graph'
  buildId: string
  projectId: string
  nodeId: string
  semanticRevision: string
  state: 'preview' | 'committed' | 'discarded'
  sourceGraph?: import('./flow-definition').FlowGraphSource
  committedScopeHash?: string
  graph: FlowGraph
  nodes: CompiledNode[]
  edges: CompiledEdge[]
  coordinatorNodeId: string
  stateNodeId: string
}

export class FlowGraphCompileError extends Error {
  constructor(readonly errors: FlowGraphError[]) {
    super(`FLOW_GRAPH_INVALID: ${errors.map((e) => e.code).join(', ')}`)
    this.name = 'FlowGraphCompileError'
  }
}

function compileNode(
  node: FlowNode,
  graph: FlowGraph,
  catalog: readonly CapabilityDescriptor[]
): CompiledNode {
  const base = { id: node.nodeId, title: node.title, text: node.goal, x: 0, y: 0 }
  if (node.kind === 'agent') {
    const config = AgentNodeConfigSchema.parse({
      schemaVersion: 1,
      role: 'specialist',
      humanRole: node.participation === 'collaborative' ? node.humanRole ?? 'owner' : undefined,
      interactionMode: node.participation === 'collaborative' ? 'collaborative' : 'autonomous',
      skills: [],
      tools: node.tools ?? [{ id: 'node.execute', version: '1' }],
      allowedNodeIds: deriveFlowAgentAllowedNodeIds(graph, node.nodeId),
      modelDefinitionId: node.modelDefinitionId,
      maxSteps: graph.budgets.maxSteps,
      relations: []
    })
    return { ...base, type: 'agent', config: JSON.stringify(config), contractVersion: 1 }
  }
  if (node.kind === 'human-task') {
    const config = HumanTaskNodeConfigSchema.parse({
      schemaVersion: 1,
      outputType: node.humanOutputType ?? 'text',
      humanRole: node.humanRole ?? 'owner',
      instructions: node.goal
    })
    return { ...base, type: 'human-task', config: JSON.stringify(config), contractVersion: 1 }
  }
  if (node.kind === 'review') {
    const binding = deriveFlowReviewBindings(graph, node)
    const config = ReviewNodeConfigSchema.parse({
      schemaVersion: 1,
      rulesVersion: 'flow-interpreter-v1',
      reviewMode: 'text-json',
      modelDefinitionId: node.modelDefinitionId,
      rejectPolicy: node.review!.rejectPolicy,
      maxReworks: node.review!.maxReworks,
      responsibleNodeId: binding.responsibleNodeId,
      subjectSources: binding.subjectSources,
      gatedNodeIds: binding.gatedNodeIds,
      relations: []
    })
    return { ...base, type: 'ai-review', text: node.review!.criteria, config: JSON.stringify(config), contractVersion: 1 }
  }
  if (node.kind === 'capability') {
    // BL-10：能力载体来自目录（节点注册表 + 已发布节点流），编译器不认识任何能力 ID。
    const descriptor = findCapability(catalog, flowNodeCapabilityRef(node))
    if (!descriptor?.carrier)
      throw new FlowGraphCompileError([
        {
          code: 'CAPABILITY_UNKNOWN',
          nodeId: node.nodeId,
          message: `Capability ${flowNodeCapabilityRef(node)?.id ?? '(missing)'} has no compile carrier`
        }
      ])
    // Builder 的目标配置与公开 params 都先转换成执行器真实字段，再合并进固定配置。
    const goalConfig = descriptor.builder?.configFromStep
      ? JSON.parse(
          descriptor.builder.configFromStep({
            instruction: node.goal,
            template: node.goal
          })
        ) as Record<string, unknown>
      : {}
    const resolved = node.params
      ? resolveNodeParams(descriptor.carrier.type, node.params, descriptor.carrier.config)
      : undefined
    if (resolved && !resolved.ok)
      throw new FlowGraphCompileError([
        {
          code: resolved.code,
          nodeId: node.nodeId,
          message: `Capability ${descriptor.capabilityRef.id}@${descriptor.capabilityRef.version} params rejected: ${resolved.message}`
        }
      ])
    const carrierConfig = JSON.stringify({
      ...(JSON.parse(descriptor.carrier.config) as Record<string, unknown>),
      ...goalConfig,
      ...(resolved?.ok ? resolved.params : {})
    })
    return {
      ...base,
      type: descriptor.carrier.type,
      config: carrierConfig,
      contractVersion: descriptor.carrier.contractVersion
    }
  }
  // state-machine 节点：由编译器的派生状态机统一承载，单节点声明此处给出基础配置。
  const config = StateMachineNodeConfigSchema.parse({
    schemaVersion: 1,
    initialState: 'idle',
    states: ['idle', 'completed'],
    transitions: [{ from: 'idle', event: 'flow.completed', to: 'completed' }],
    relations: []
  })
  return { ...base, type: 'state-machine', config: JSON.stringify(config), contractVersion: 1 }
}

/** 节点、分支和轮次留在子任务账本里，流程状态只描述整体阶段。 */
export function deriveFlowPhaseStateMachine(): {
  states: string[]
  transitions: Array<{ from: string; event: string; to: string }>
} {
  const active = ['running', 'waiting-human', 'reviewing', 'paused']
  return {
    states: ['idle', ...active, 'completed', 'failed', 'stopped'],
    transitions: [
      { from: 'idle', event: 'flow.started', to: 'running' },
      ...active.flatMap((from) => [
        { from, event: 'agent.dispatched', to: from },
        { from, event: 'agent.completed', to: from },
        { from, event: 'rework.created', to: from },
        { from, event: 'review.started', to: 'reviewing' },
        { from, event: 'review.passed', to: 'running' },
        { from, event: 'review.rejected', to: 'running' },
        { from, event: 'human.wait', to: 'waiting-human' },
        { from, event: 'flow.paused', to: 'paused' },
        { from, event: 'flow.completed', to: 'completed' },
        { from, event: 'flow.failed', to: 'failed' },
        { from, event: 'flow.stopped', to: 'stopped' },
        { from, event: 'flow.rework', to: 'waiting-human' }
      ]),
      { from: 'waiting-human', event: 'human.continue', to: 'running' },
      { from: 'paused', event: 'human.continue', to: 'running' },
      { from: 'completed', event: 'flow.rework', to: 'waiting-human' },
      { from: 'failed', event: 'flow.rework', to: 'waiting-human' }
    ]
  }
}

/**
 * 条件里的节点引用同样重映射（BL-03 修复）：此前只重映射了 loop.exitCondition，
 * 边条件、decisions.when、inputs.selectors 仍引用语义 id，编译产物一进 AgentNodeConfigSchema
 * 的引用校验就失败——带条件分支或最小输入声明的外部图根本无法编译落画布。
 */
function remapCondition<T extends { kind: string }>(condition: T): T {
  if ('stageKey' in condition)
    return { ...condition, stageKey: canvasNodeId((condition as { stageKey: string }).stageKey) }
  if ('reviewNodeId' in condition)
    return {
      ...condition,
      reviewNodeId: canvasNodeId((condition as { reviewNodeId: string }).reviewNodeId)
    }
  return condition
}
function toCanvasGraph(graph: FlowGraph): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      nodeId: canvasNodeId(node.nodeId),
      ...(node.allowedNodeIds ? { allowedNodeIds: node.allowedNodeIds.map(canvasNodeId) } : {}),
      ...(node.responsibleNodeId ? { responsibleNodeId: canvasNodeId(node.responsibleNodeId) } : {}),
      ...(node.subjectSources ? {
        subjectSources: node.subjectSources.map((source) => ({
          ...source,
          nodeId: canvasNodeId(source.nodeId)
        }))
      } : {}),
      ...(node.gatedNodeIds ? { gatedNodeIds: node.gatedNodeIds.map(canvasNodeId) } : {}),
      ...(node.inputs
        ? {
            inputs: {
              ...node.inputs,
              ...(node.inputs.summarySelector ? { summarySelector: {
                ...node.inputs.summarySelector,
                sourceStageKey: canvasNodeId(node.inputs.summarySelector.sourceStageKey)
              } } : {}),
              selectors: node.inputs.selectors.map((selector) => ({
                ...selector,
                sourceStageKey: canvasNodeId(selector.sourceStageKey)
              }))
            }
          }
        : {}),
      ...(node.decisions?.when
        ? { decisions: { ...node.decisions, when: node.decisions.when.map(remapCondition) } }
        : {}),
      ...(node.loop
        ? {
            loop: {
              ...node.loop,
              // BL-11：子图循环体同样重映射为画布 shape id。
              ...(node.loop.body ? { body: node.loop.body.map(canvasNodeId) } : {}),
              exitCondition: node.loop.exitCondition.map((condition) => {
                if ('stageKey' in condition)
                  return { ...condition, stageKey: canvasNodeId(condition.stageKey) }
                if ('reviewNodeId' in condition)
                  return { ...condition, reviewNodeId: canvasNodeId(condition.reviewNodeId) }
                return condition
              })
            }
          }
        : {})
    })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      from: { ...edge.from, nodeId: canvasNodeId(edge.from.nodeId) },
      to: { ...edge.to, nodeId: canvasNodeId(edge.to.nodeId) },
      ...(edge.condition ? { condition: edge.condition.map(remapCondition) } : {})
    })),
    entry: canvasNodeId(graph.entry),
    exits: graph.exits.map(canvasNodeId)
  }
}

/**
 * 编译入口（纯函数）。先静态校验，非法图抛 FlowGraphCompileError（稳定错误码）。
 * 产物：各专业节点 + 一个 coordinator 主控 + 一个派生状态机；数据边 + 控制边。
 * 节点 id 为 tldraw 合法 shape id（'shape:' 前缀），可直接落画布。
 */
export function compileFlowGraph(
  graph: FlowGraph,
  options: { catalog?: readonly CapabilityDescriptor[] } = {}
): CompiledGraph {
  const catalog = options.catalog ?? buildCapabilityCatalog()
  const validation = validateFlowGraph(graph, { catalog, requireRuntime: false })
  if (!validation.ok) throw new FlowGraphCompileError(validation.errors)
  const runtimeErrors = validateFlowGraphRuntime(graph)

  const mapped = toCanvasGraph(graph)
  const graphIdSlug = graph.graphId.replace(/[^a-zA-Z0-9_-]/g, '-')
  const coordinatorNodeId = `shape:coordinator-${graphIdSlug}`
  const stateNodeId = `shape:state-${graphIdSlug}`
  const compiledNodes = mapped.nodes.map((node) => compileNode(node, mapped, catalog))
  const specialistIds = compiledNodes.map((node) => node.id)
  const hasReviewNodes = mapped.nodes.some((node) => node.kind === 'review')

  const coordinatorConfig = AgentNodeConfigSchema.parse({
    schemaVersion: 1,
    role: 'coordinator',
    interactionMode: 'autonomous',
    skills: [],
    tools: [
      { id: 'agent.dispatch', version: '1' },
      // Graph reviews are driven by the coordinator control loop. The runtime
      // admission check requires the same explicit capability on the compiled
      // coordinator, otherwise a valid review graph cannot be started.
      ...(hasReviewNodes ? [{ id: 'review.execute', version: '1' }] : [])
    ],
    allowedNodeIds: specialistIds,
    maxSteps: graph.budgets.maxSteps,
    // P5：落画布后必须走声明式图路由（graphStep，P3/P4），而非退回模型驱动分派。
    // graph 节点承载须与 allowedNodeIds 一一对应（AgentNodeConfigSchema superRefine）。
    executionMode: 'graph',
    graph: mapped,
    relations: [
      { relationId: `${graph.graphId}-observes`, kind: 'observes', sourceNodeId: coordinatorNodeId, targetNodeId: stateNodeId },
      ...specialistIds.map((id) => ({
        relationId: `${graph.graphId}-controls-${id}`,
        kind: 'controls' as const,
        sourceNodeId: coordinatorNodeId,
        targetNodeId: id
      }))
    ]
  })
  const sm = deriveFlowPhaseStateMachine()
  const stateConfig = StateMachineNodeConfigSchema.parse({
    schemaVersion: 1,
    initialState: 'idle',
    states: sm.states,
    transitions: sm.transitions,
    relations: []
  })

  const nodes: CompiledNode[] = [
    {
      id: coordinatorNodeId,
      type: 'agent',
      title: graph.name,
      text: graph.goal,
      config: JSON.stringify(coordinatorConfig),
      contractVersion: 1,
      x: 0,
      y: 0
    },
    ...compiledNodes,
    {
      id: stateNodeId,
      type: 'state-machine',
      title: '流程状态',
      text: '',
      config: JSON.stringify(stateConfig),
      contractVersion: 1,
      x: 0,
      y: 0
    }
  ]

  // BL-11 / G8：编译器不再重映射端口——数据边必须直接使用目标节点的真实端口
  // （validateFlowGraph 已按契约/能力目录校验存在性与类型兼容）。
  const edges: CompiledEdge[] = mapped.edges.map((edge) => ({
    from: { nodeId: edge.from.nodeId, portId: edge.from.portId },
    to: { nodeId: edge.to.nodeId, portId: edge.to.portId }
  }))

  // P5：编译产物直接带布局坐标（与建图预览同构，落画布无需再排版）。复用共享 layoutGraph
  // （lanes）——与 GUI 智能整理/graph.layout/builder 同一算法（三入口 parity）。尺寸与
  // NODE_UI.width/height.default 一致（340×300；main 不跨包 import renderer 令牌）。
  const width = 340,
    height = 300
  const layoutNodes = nodes.map((node) => {
    let role: 'coordinator' | 'specialist' | undefined
    let controls: string[] | undefined
    try {
      const config = JSON.parse(node.config) as { role?: unknown; allowedNodeIds?: unknown; gatedNodeIds?: unknown }
      if (config.role === 'coordinator' || config.role === 'specialist') role = config.role
      const targets = node.type === 'agent' ? config.allowedNodeIds : config.gatedNodeIds
      if (Array.isArray(targets)) controls = targets.filter((id): id is string => typeof id === 'string')
    } catch {
      // 配置损坏按无角色处理，布局不报错。
    }
    return {
      id: node.id,
      type: node.type,
      x: 0,
      y: 0,
      w: width,
      h: height,
      title: node.title,
      ...(role ? { role } : {}),
      ...(controls ? { controls } : {})
    }
  })
  const layoutEdges = edges.map((edge) => ({ from: edge.from.nodeId, to: edge.to.nodeId }))
  const layout = layoutGraph(layoutNodes, layoutEdges, 'lanes', {
    origin: { x: 0, y: 0 },
    columnGap: 100,
    rowGap: 100
  })
  const positionById = new Map(layout.positions.map((pos) => [pos.id, pos]))
  for (const node of nodes) {
    const pos = positionById.get(node.id)
    if (!pos) throw new FlowGraphCompileError([{ code: 'UNREACHABLE_NODE', nodeId: node.id, message: 'layout position missing' }])
    node.x = pos.x
    node.y = pos.y
  }

  return {
    nodes,
    edges,
    coordinatorNodeId,
    stateNodeId,
    runnable: runtimeErrors.length === 0,
    runtimeErrors
  }
}
