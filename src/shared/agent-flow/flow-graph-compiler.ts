import {
  AgentNodeConfigSchema,
  HumanTaskNodeConfigSchema,
  ReviewNodeConfigSchema,
  StateMachineNodeConfigSchema
} from './node-contracts'
import { validateFlowGraph, type FlowGraph, type FlowNode, type FlowGraphError } from './flow-graph'
import { layoutGraph } from '../flow-layout'

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

/** 能力节点编译映射（与 builder-host TARGETS 同源口径）。 */
const CAPABILITY_COMPILE: Record<
  string,
  { type: string; contractVersion: number; inputPort: string; outputPort: string; config: string }
> = {
  'text-template@1': {
    type: 'processor',
    contractVersion: 1,
    inputPort: 'in-value',
    outputPort: 'out-value',
    config: JSON.stringify({ operation: 'template', field: '', template: '{{value}}' })
  },
  'text-pass@1': {
    type: 'processor',
    contractVersion: 1,
    inputPort: 'in-value',
    outputPort: 'out-value',
    config: JSON.stringify({ operation: 'pass', field: '' })
  },
  'image-gen@3': {
    type: 'image-gen',
    contractVersion: 3,
    inputPort: 'in-text',
    outputPort: 'out-image',
    config: JSON.stringify({ count: 1, retry: { maxRetries: 0 } })
  },
  'image-edit@2': {
    type: 'image-edit',
    contractVersion: 2,
    inputPort: 'in-image',
    outputPort: 'out-image',
    config: JSON.stringify({
      version: 1,
      modelKey: '',
      size: 'auto',
      aspectRatio: 'auto',
      instruction: '',
      annotations: [],
      mask: { enabled: false, strokes: [], brushSize: 0.08, invert: false }
    })
  },
  'video@7': {
    type: 'video',
    contractVersion: 7,
    inputPort: 'in-text',
    outputPort: 'out-video',
    config: JSON.stringify({ modelKey: '', mode: 'reference', params: {}, taskId: '' })
  },
  'speech@4': {
    type: 'speech',
    contractVersion: 4,
    inputPort: 'in-text',
    outputPort: 'out-audio',
    config: JSON.stringify({ backend: 'minimax' })
  },
  'tts@4': {
    type: 'tts',
    contractVersion: 4,
    inputPort: 'in-audio',
    outputPort: 'out-json',
    config: JSON.stringify({ backend: 'minimax' })
  }
}

function compileNode(node: FlowNode, graph: FlowGraph): CompiledNode {
  const base = { id: node.nodeId, title: node.title, text: node.goal, x: 0, y: 0 }
  if (node.kind === 'agent') {
    const config = AgentNodeConfigSchema.parse({
      schemaVersion: 1,
      role: 'specialist',
      interactionMode: node.participation === 'collaborative' ? 'collaborative' : 'autonomous',
      skills: [],
      tools: [],
      allowedNodeIds: [],
      maxSteps: graph.budgets.maxSteps,
      relations: []
    })
    return { ...base, type: 'agent', config: JSON.stringify(config), contractVersion: 1 }
  }
  if (node.kind === 'human-task') {
    const config = HumanTaskNodeConfigSchema.parse({
      schemaVersion: 1,
      outputType: 'text',
      instructions: node.goal
    })
    return { ...base, type: 'human-task', config: JSON.stringify(config), contractVersion: 1 }
  }
  if (node.kind === 'review') {
    const config = ReviewNodeConfigSchema.parse({
      schemaVersion: 1,
      rulesVersion: 'flow-interpreter-v1',
      reviewMode: 'text-json',
      rejectPolicy: node.review!.rejectPolicy,
      maxReworks: node.review!.maxReworks,
      subjectSources: [],
      gatedNodeIds: [],
      relations: []
    })
    return { ...base, type: 'ai-review', text: node.review!.criteria, config: JSON.stringify(config), contractVersion: 1 }
  }
  if (node.kind === 'capability') {
    const mapping = CAPABILITY_COMPILE[node.capability!]
    if (!mapping) throw new FlowGraphCompileError([{ code: 'UNREACHABLE_NODE', nodeId: node.nodeId, message: `Unknown capability ${node.capability}` }])
    return { ...base, type: mapping.type, config: mapping.config, contractVersion: mapping.contractVersion }
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

/** 派生基础状态机（顺序语义）：idle + 各节点状态 + completed；边→完成事件迁移。
 *  条件/循环的精确状态机推导属 P3+；此处保证结构合法（过 StateMachineNodeConfigSchema）。 */
function deriveStateMachine(graph: FlowGraph): { states: string[]; transitions: Array<{ from: string; event: string; to: string }> } {
  const states = ['idle', ...graph.nodes.map((n) => n.nodeId), 'completed']
  const transitions: Array<{ from: string; event: string; to: string }> = [
    { from: 'idle', event: 'flow.started', to: graph.entry }
  ]
  for (const edge of graph.edges) {
    if (edge.kind !== 'data') continue
    transitions.push({ from: edge.from.nodeId, event: `${edge.to.nodeId}.entered`, to: edge.to.nodeId })
  }
  for (const exit of graph.exits) {
    transitions.push({ from: exit, event: 'flow.completed', to: 'completed' })
  }
  return { states, transitions }
}

/**
 * P5.3：把 FlowGraph 的语义 nodeId 重映射为 tldraw 合法画布 shape id（必须 'shape:' 前缀）。
 * 节点/边/entry/exits/循环 exitCondition.stageKey 全部一致重映射，保证编译产物落画布后
 * 协调器 allowedNodeIds、图路由 graph.nodes 与真实画布节点 id 一一对应。
 */
export function canvasNodeId(id: string): string {
  return `shape:${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}
function toCanvasGraph(graph: FlowGraph): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      nodeId: canvasNodeId(node.nodeId),
      ...(node.loop
        ? {
            loop: {
              ...node.loop,
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
      to: { ...edge.to, nodeId: canvasNodeId(edge.to.nodeId) }
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
export function compileFlowGraph(graph: FlowGraph): CompiledGraph {
  const validation = validateFlowGraph(graph)
  if (!validation.ok) throw new FlowGraphCompileError(validation.errors)

  const mapped = toCanvasGraph(graph)
  const graphIdSlug = graph.graphId.replace(/[^a-zA-Z0-9_-]/g, '-')
  const coordinatorNodeId = `shape:coordinator-${graphIdSlug}`
  const stateNodeId = `shape:state-${graphIdSlug}`
  const compiledNodes = mapped.nodes.map((node) => compileNode(node, mapped))
  const specialistIds = compiledNodes.map((node) => node.id)

  const coordinatorConfig = AgentNodeConfigSchema.parse({
    schemaVersion: 1,
    role: 'coordinator',
    interactionMode: 'autonomous',
    skills: [],
    tools: [{ id: 'agent.dispatch', version: '1' }],
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
  const sm = deriveStateMachine(mapped)
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

  // ②：capability 节点的数据边端口重映射到处理器实际端口（in-value/out-value 等），
  // 否则落画布 createEdge 与 node.execute 输入端口校验会因 FlowGraph 通用端口名失配。
  const capabilityByNode = new Map(
    graph.nodes
      .filter((node) => node.kind === 'capability')
      .map((node) => [canvasNodeId(node.nodeId), CAPABILITY_COMPILE[node.capability!]])
  )
  const edges: CompiledEdge[] = mapped.edges
    .filter((edge) => edge.kind === 'data')
    .map((edge) => {
      const fromCap = capabilityByNode.get(edge.from.nodeId)
      const toCap = capabilityByNode.get(edge.to.nodeId)
      return {
        from: { nodeId: edge.from.nodeId, portId: fromCap ? fromCap.outputPort : edge.from.portId },
        to: { nodeId: edge.to.nodeId, portId: toCap ? toCap.inputPort : edge.to.portId }
      }
    })

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

  return { nodes, edges, coordinatorNodeId, stateNodeId }
}