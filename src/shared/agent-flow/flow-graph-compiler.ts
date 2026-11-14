import {
  AgentNodeConfigSchema,
  HumanTaskNodeConfigSchema,
  ReviewNodeConfigSchema,
  StateMachineNodeConfigSchema
} from './node-contracts'
import { validateFlowGraph, type FlowGraph, type FlowNode, type FlowGraphError } from './flow-graph'

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
  const base = { id: node.nodeId, title: node.title, text: node.goal }
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
 * 编译入口（纯函数）。先静态校验，非法图抛 FlowGraphCompileError（稳定错误码）。
 * 产物：各专业节点 + 一个 coordinator 主控 + 一个派生状态机；数据边 + 控制边。
 */
export function compileFlowGraph(graph: FlowGraph): CompiledGraph {
  const validation = validateFlowGraph(graph)
  if (!validation.ok) throw new FlowGraphCompileError(validation.errors)

  const coordinatorNodeId = `coordinator:${graph.graphId}`
  const stateNodeId = `state:${graph.graphId}`
  const compiledNodes = graph.nodes.map((node) => compileNode(node, graph))
  const specialistIds = compiledNodes.map((node) => node.id)

  const coordinatorConfig = AgentNodeConfigSchema.parse({
    schemaVersion: 1,
    role: 'coordinator',
    interactionMode: 'autonomous',
    skills: [],
    tools: [{ id: 'agent.dispatch', version: '1' }],
    allowedNodeIds: specialistIds,
    maxSteps: graph.budgets.maxSteps,
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
  const sm = deriveStateMachine(graph)
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
      contractVersion: 1
    },
    ...compiledNodes,
    {
      id: stateNodeId,
      type: 'state-machine',
      title: '流程状态',
      text: '',
      config: JSON.stringify(stateConfig),
      contractVersion: 1
    }
  ]

  const edges: CompiledEdge[] = graph.edges
    .filter((edge) => edge.kind === 'data')
    .map((edge) => ({ from: edge.from, to: edge.to }))

  return { nodes, edges, coordinatorNodeId, stateNodeId }
}