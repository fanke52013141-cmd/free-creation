import { z } from 'zod'
import { GENERATED_NODE_CONTRACTS } from '../agent-access/generated/node-contracts.generated'
import type { NodeContractRecord } from '../agent-access/node-contracts'
import type { CompositeVersionRecord } from '../composite/types'
import { hasCompositeManualGate } from '../composite/manifest'
import type { FlowParticipation } from './flow-graph'

/**
 * BL-10 / NF-13：可编排能力目录（唯一真值）。
 *
 * 目录由两部分**生成**，不在编译器里手写能力白名单：
 * 1. 节点能力：`GENERATED_NODE_CONTRACTS`（节点注册表导出快照）逐项生成，端口/契约版本
 *    与画布同一来源；只有声明了编译载体的能力才 `agentSchedulable`。
 * 2. 节点流能力：已发布版本（`composite_versions`）逐条生成，端口取公开输入/输出，
 *    参与形态按 NF-13.2 推导（人工门/等待输入/含 human-task → 至少 collaborative）。
 *
 * 编译器、`flowAgent.catalog`、MCP 目录与上帝 Agent 的计划面都从本模块取。
 * 新增能力 = 在节点注册表登记 + 提供编译载体；禁止在编译器里加 if/白名单。
 */

export interface CapabilityRef {
  kind: 'node' | 'composite'
  id: string
  version: string
}

export interface CapabilityPort {
  portId: string
  type: string
  required: boolean
  cardinality: 'one' | 'many'
  name?: string
  description?: string
  schemaRef?: { id: string; version: number }
}

/** 计划面：上帝 Agent 生成 BuildPlan 时可用的字段约束（NF-13.3）。 */
export interface CapabilityPlanSurface {
  title: string
  inputType: 'text' | 'image' | 'audio' | 'video' | 'json'
  outputType: 'text' | 'image' | 'audio' | 'video' | 'json'
  instruction: 'required' | 'optional' | 'forbidden'
  template: 'required' | 'optional' | 'forbidden'
  reviewable: boolean
}

/** 编译载体：能力在画布上落到哪类节点、写什么固定配置、边接哪些真实端口。 */
export interface CapabilityCarrier {
  type: string
  contractVersion: number
  config: string
  /** 空串 = 不重映射（节点流公开端口由清单决定）。 */
  inputPort: string
  outputPort: string
}

export interface CapabilityDescriptor {
  capabilityRef: CapabilityRef
  label: string
  description: string
  inputs: CapabilityPort[]
  outputs: CapabilityPort[]
  /** NF-13.2 推导出的**下限**；FlowGraph 可以声明更高参与度，不能更低。 */
  participation: 'autonomous' | 'collaborative'
  cost: 'none' | 'possible' | 'certain'
  network: 'none' | 'required'
  agentSchedulable: boolean
  reason?: string
  carrier?: CapabilityCarrier
  plan?: CapabilityPlanSurface
  /** 计划步骤里的可变字段 → 编译配置（仅 builder 预览使用；不进入对外目录）。 */
  builder?: {
    configFromStep?: (step: { template?: string; instruction?: string }) => string
    textFromStep?: (step: { instruction?: string }) => string
  }
  /** 仅节点流能力：发布版本的内容摘要（编译时写入实例配置，保证固定版本）。 */
  contentHash?: string
}

const NODE_RECORDS = new Map<string, NodeContractRecord>(
  GENERATED_NODE_CONTRACTS.map((record) => [record.typeId, record])
)

/**
 * 媒体/文本能力的计划面与编译载体（历史 7 项口径）。
 * 这里不是白名单：其余节点类型仍会以 `agentSchedulable:false` 出现在目录里，
 * 编译器只按目录解析，不认识任何能力 ID。
 */
interface AdapterSpec {
  plan: CapabilityPlanSurface
  config: string
  /** 固定输入/输出端口（与历史编译映射逐字一致；目录不再猜第一个端口）。 */
  inputPort: string
  outputPort: string
  schedulable: boolean
  cost: 'none' | 'possible' | 'certain'
  network: 'none' | 'required'
  reason?: string
  /** 只有 text-template/text-pass 是 processor 的操作变体。 */
  carrierType?: string
  builder?: CapabilityDescriptor['builder']
}

const MEDIA_ADAPTERS: Record<string, AdapterSpec> = {
  'text-template@1': {
    plan: {
      title: '文本模板',
      inputType: 'text',
      outputType: 'text',
      instruction: 'forbidden',
      template: 'required',
      reviewable: true
    },
    config: JSON.stringify({ operation: 'template', field: '', template: '{{value}}' }),
    inputPort: 'in-value',
    outputPort: 'out-value',
    schedulable: true,
    cost: 'none',
    network: 'none',
    builder: {
      configFromStep: (step) =>
        JSON.stringify({ operation: 'template', field: '', template: step.template ?? '{{value}}' })
    }
  },
  'text-pass@1': {
    plan: {
      title: '文本透传',
      inputType: 'text',
      outputType: 'text',
      instruction: 'forbidden',
      template: 'forbidden',
      reviewable: false
    },
    config: JSON.stringify({ operation: 'pass', field: '' }),
    inputPort: 'in-value',
    outputPort: 'out-value',
    schedulable: true,
    cost: 'none',
    network: 'none'
  },
  'image-gen@3': {
    plan: {
      title: '生图',
      inputType: 'text',
      outputType: 'image',
      instruction: 'required',
      template: 'forbidden',
      reviewable: false
    },
    config: JSON.stringify({ count: 1, retry: { maxRetries: 0 } }),
    inputPort: 'in-text',
    outputPort: 'out-image',
    schedulable: true,
    cost: 'certain',
    network: 'required',
    builder: { textFromStep: (step) => step.instruction ?? '' }
  },
  'image-edit@2': {
    plan: {
      title: 'P图',
      inputType: 'image',
      outputType: 'image',
      instruction: 'required',
      template: 'forbidden',
      reviewable: false
    },
    config: JSON.stringify({
      version: 1,
      modelKey: '',
      size: 'auto',
      aspectRatio: 'auto',
      instruction: '',
      annotations: [],
      mask: { enabled: false, strokes: [], brushSize: 0.08, invert: false }
    }),
    inputPort: 'in-image',
    outputPort: 'out-image',
    schedulable: true,
    cost: 'certain',
    network: 'required',
    builder: {
      configFromStep: (step) =>
        JSON.stringify({
          version: 1,
          modelKey: '',
          size: 'auto',
          aspectRatio: 'auto',
          instruction: step.instruction ?? '',
          annotations: [],
          mask: { enabled: false, strokes: [], brushSize: 0.08, invert: false }
        })
    }
  },
  'video@7': {
    plan: {
      title: '视频生成',
      inputType: 'text',
      outputType: 'video',
      instruction: 'required',
      template: 'forbidden',
      reviewable: true
    },
    config: JSON.stringify({ modelKey: '', mode: 'reference', params: {}, taskId: '' }),
    inputPort: 'in-text',
    outputPort: 'out-video',
    schedulable: true,
    cost: 'certain',
    network: 'required',
    builder: { textFromStep: (step) => step.instruction ?? '' }
  },
  'speech@4': {
    plan: {
      title: '语音合成',
      inputType: 'text',
      outputType: 'audio',
      instruction: 'optional',
      template: 'forbidden',
      reviewable: false
    },
    config: JSON.stringify({ backend: 'minimax' }),
    inputPort: 'in-text',
    outputPort: 'out-audio',
    schedulable: true,
    cost: 'certain',
    network: 'required'
  },
  'tts@4': {
    plan: {
      title: '语音克隆',
      inputType: 'audio',
      outputType: 'json',
      instruction: 'optional',
      template: 'forbidden',
      reviewable: false
    },
    config: JSON.stringify({ backend: 'minimax' }),
    inputPort: 'in-audio',
    outputPort: 'out-json',
    schedulable: true,
    cost: 'certain',
    network: 'required'
  }
}

/** 非媒体但会调用模型的直接节点；本地确定性节点不列入。 */
const DIRECT_AI_ECONOMICS: Record<string, Pick<CapabilityDescriptor, 'cost' | 'network'>> = {
  'voice-design': { cost: 'certain', network: 'required' },
  chat: { cost: 'possible', network: 'required' },
  'ai-process': { cost: 'possible', network: 'required' },
  agent: { cost: 'possible', network: 'required' },
  'ai-review': { cost: 'possible', network: 'required' }
}

function toPorts(record: NodeContractRecord | undefined): {
  inputs: CapabilityPort[]
  outputs: CapabilityPort[]
} {
  const map = (port: NodeContractRecord['ports']['in'][number]): CapabilityPort => ({
    portId: port.id,
    type: port.type,
    required: port.required,
    cardinality: port.cardinality,
    ...(port.name ? { name: port.name } : {}),
    ...(port.description ? { description: port.description } : {}),
    ...(port.schema ? { schemaRef: parseSchemaRef(port.schema) } : {})
  })
  return {
    inputs: (record?.ports.in ?? []).map(map),
    outputs: (record?.ports.out ?? []).map(map)
  }
}

/** 端口 schema 常量形如 `json.any@1`；解析失败时忽略（不阻断目录）。 */
function parseSchemaRef(raw: string): { id: string; version: number } | undefined {
  const at = raw.lastIndexOf('@')
  if (at <= 0) return undefined
  const version = Number(raw.slice(at + 1))
  if (!Number.isInteger(version) || version < 1) return undefined
  return { id: raw.slice(0, at), version }
}

function mediaDescriptor(capabilityId: string, spec: AdapterSpec): CapabilityDescriptor {
  const [typeId, version] = capabilityId.split('@')
  const carrierType = spec.carrierType ?? typeId
  const record = NODE_RECORDS.get(carrierType)
  const compatibleRecord = record && String(record.contractVersion) === version ? record : null
  const schedulable = spec.schedulable && compatibleRecord !== null
  const ports = toPorts(record)
  return {
    capabilityRef: { kind: 'node', id: typeId, version },
    label: spec.plan.title,
    description: record?.description ?? spec.plan.title,
    inputs: ports.inputs,
    outputs: ports.outputs,
    participation: 'autonomous',
    cost: spec.cost,
    network: spec.network,
    agentSchedulable: schedulable,
    ...((spec.reason || !schedulable) ? {
      reason: spec.reason ?? `Capability ${capabilityId} has no exact carrier contract snapshot; refusing to borrow the current record`
    } : {}),
    ...(spec.builder ? { builder: spec.builder } : {}),
    ...(schedulable && compatibleRecord ? {
      carrier: {
        type: carrierType,
        contractVersion: compatibleRecord.contractVersion,
        config: spec.config,
        inputPort: spec.inputPort,
        outputPort: spec.outputPort
      }
    } : {}),
    plan: spec.plan
  }
}

/** 节点能力：每个 Active 节点类型一条；没有编译载体的如实标记不可调度。 */
export function nodeCapabilityDescriptors(): CapabilityDescriptor[] {
  const descriptors: CapabilityDescriptor[] = []
  const seen = new Set<string>()
  for (const record of GENERATED_NODE_CONTRACTS) {
    const capabilityId = `${record.typeId}@${record.contractVersion}`
    seen.add(capabilityId)
    const media = MEDIA_ADAPTERS[capabilityId]
    if (media) {
      descriptors.push(mediaDescriptor(capabilityId, media))
      continue
    }
    const ports = toPorts(record)
    const economics = DIRECT_AI_ECONOMICS[record.typeId] ?? { cost: 'none' as const, network: 'none' as const }
    descriptors.push({
      capabilityRef: { kind: 'node', id: record.typeId, version: String(record.contractVersion) },
      label: record.label,
      description: record.description,
      inputs: ports.inputs,
      outputs: ports.outputs,
      participation: record.executionMode === 'manual-publish' ? 'collaborative' : 'autonomous',
      ...economics,
      agentSchedulable: false,
      reason:
        record.executionDisabledReason ??
        '该节点类型尚未声明可编排的编译载体（BL-10 首批只开放媒体能力与已发布节点流）'
    })
  }
  // 处理器操作变体：text-template / text-pass 与 processor@1 共用端口。
  for (const [capabilityId, spec] of Object.entries(MEDIA_ADAPTERS)) {
    if (seen.has(capabilityId)) continue
    descriptors.push(mediaDescriptor(capabilityId, { ...spec, carrierType: 'processor' }))
  }
  return descriptors
}

/** 参与形态下限：只有 autonomous 与 collaborative 两档；human 由 human-task 节点本身表达。 */
export function participationRank(participation: FlowParticipation): number {
  if (participation === 'human') return 2
  return participation === 'collaborative' ? 1 : 0
}

function compositeParticipation(record: CompositeVersionRecord): 'autonomous' | 'collaborative' {
  const policy = record.manifest.executionPolicy
  if (policy?.requiresManualGate || policy?.waitForInput) return 'collaborative'
  return hasCompositeManualGate(record.manifest.graph)
    ? 'collaborative'
    : 'autonomous'
}

/** 只读固定引用；不导入 composite/outputs，避免经运行器回到 node-contracts/flow-graph 的运行时环。 */
function readNestedCompositeRef(config: string | undefined): { capabilityId: string; version: string } | null {
  if (!config) return null
  try {
    const value = JSON.parse(config) as { capabilityId?: unknown; version?: unknown; manifest?: unknown }
    if (value.manifest) return null
    return typeof value.capabilityId === 'string' && typeof value.version === 'string'
      ? { capabilityId: value.capabilityId, version: value.version }
      : null
  } catch {
    return null
  }
}

/** 直接节点与嵌套固定版本的保守 economics 汇总。未知/循环引用按 possible + required。 */
function compositeEconomics(
  record: CompositeVersionRecord,
  records: ReadonlyMap<string, CompositeVersionRecord>,
  visiting = new Set<string>()
): {
  cost: CapabilityDescriptor['cost']
  network: CapabilityDescriptor['network']
} {
  const key = capabilityRefKey({ kind: 'composite', id: record.capabilityId, version: record.version })
  if (visiting.has(key)) return { cost: 'possible', network: 'required' }
  visiting.add(key)
  let cost: CapabilityDescriptor['cost'] = 'none'
  let network: CapabilityDescriptor['network'] = 'none'
  const merge = (
    nextCost: CapabilityDescriptor['cost'],
    nextNetwork: CapabilityDescriptor['network']
  ): void => {
    if (nextCost === 'certain') cost = 'certain'
    else if (nextCost === 'possible' && cost === 'none') cost = 'possible'
    if (nextNetwork === 'required') network = 'required'
  }
  try {
    const byType = new Map(cachedNodeCapabilities().map((item) => [item.capabilityRef.id, item]))
    for (const node of record.manifest.graph.nodes) {
      if (node.nodeType === 'composite') {
        const ref = readNestedCompositeRef(node.config)
        const nested = ref
          ? records.get(capabilityRefKey({ kind: 'composite', id: ref.capabilityId, version: ref.version }))
          : undefined
        if (nested) {
          const economics = compositeEconomics(nested, records, visiting)
          merge(economics.cost, economics.network)
        } else merge('possible', 'required')
        continue
      }
      const descriptor = byType.get(node.nodeType)
      merge(descriptor?.cost ?? 'possible', descriptor?.network ?? 'required')
    }
    return { cost, network }
  } finally {
    visiting.delete(key)
  }
}

let nodeCapabilityCache: CapabilityDescriptor[] | null = null
function cachedNodeCapabilities(): CapabilityDescriptor[] {
  nodeCapabilityCache ??= nodeCapabilityDescriptors()
  return nodeCapabilityCache
}

/** 已发布节点流 → 能力描述（NF-13.1）。 */
export function compositeCapabilityDescriptor(
  record: CompositeVersionRecord,
  availableRecords: readonly CompositeVersionRecord[] = [record]
): CapabilityDescriptor {
  const manifest = record.manifest
  const participation = compositeParticipation(record)
  const records = new Map(availableRecords.map((item) => [
    capabilityRefKey({ kind: 'composite', id: item.capabilityId, version: item.version }),
    item
  ]))
  const economics = compositeEconomics(record, records)
  return {
    capabilityRef: {
      kind: 'composite',
      id: record.capabilityId,
      version: record.version
    },
    label: manifest.name,
    description: manifest.description ?? `已发布节点流 ${record.capabilityId}@${record.version}`,
    inputs: manifest.inputs.map((input) => ({
      portId: `in-${input.id}`,
      type: input.type,
      required: input.required,
      cardinality: input.cardinality,
      name: input.label,
      ...(input.description ? { description: input.description } : {}),
      ...(input.schemaRef ? { schemaRef: input.schemaRef } : {})
    })),
    outputs: manifest.outputs.map((output) => ({
      portId: `out-${output.id}`,
      type: output.type,
      required: output.required,
      cardinality: output.cardinality,
      name: output.label,
      ...(output.description ? { description: output.description } : {}),
      ...(output.schemaRef ? { schemaRef: output.schemaRef } : {})
    })),
    participation,
    cost: economics.cost,
    network: economics.network,
    agentSchedulable: true,
    carrier: {
      type: 'composite',
      contractVersion: 1,
      config: JSON.stringify({
        capabilityId: record.capabilityId,
        version: record.version,
        contentHash: record.contentHash
      }),
      inputPort: '',
      outputPort: ''
    },
    contentHash: record.contentHash
  }
}

/** 目录 = 节点能力 + 已发布节点流（后者覆盖同 ID 的旧条目）。 */
export function buildCapabilityCatalog(
  composites: readonly CompositeVersionRecord[] = []
): CapabilityDescriptor[] {
  const byKey = new Map<string, CapabilityDescriptor>()
  for (const descriptor of nodeCapabilityDescriptors())
    byKey.set(capabilityRefKey(descriptor.capabilityRef), descriptor)
  for (const record of composites) {
    const descriptor = compositeCapabilityDescriptor(record, composites)
    byKey.set(capabilityRefKey(descriptor.capabilityRef), descriptor)
  }
  return [...byKey.values()]
}

export function capabilityRefKey(ref: CapabilityRef): string {
  return `${ref.kind}:${ref.id}@${ref.version}`
}

/** 兼容旧 JSON 的 `capability: 'image-gen@3'`（kind 缺省为 node）。 */
export function parseLegacyCapability(value: string): CapabilityRef {
  const at = value.lastIndexOf('@')
  if (at <= 0) return { kind: 'node', id: value, version: '' }
  return { kind: 'node', id: value.slice(0, at), version: value.slice(at + 1) }
}

export function findCapability(
  catalog: readonly CapabilityDescriptor[],
  ref: CapabilityRef | null | undefined
): CapabilityDescriptor | undefined {
  if (!ref) return undefined
  return catalog.find(
    (descriptor) => capabilityRefKey(descriptor.capabilityRef) === capabilityRefKey(ref)
  )
}

/** 对外目录 DTO：不暴露编译载体配置（配置是实现细节，不是能力契约）。 */
export function capabilityCatalogDto(
  catalog: readonly CapabilityDescriptor[],
  limit = 400
): Array<Omit<CapabilityDescriptor, 'carrier' | 'contentHash' | 'builder'>> {
  // 对外 schema 的 max400 只约束展示集合；validate/compile 始终使用完整目录。
  // 节点顺序稳定，仓储按发布日期倒序提供 composite，因此截到前 400 是最新展示集合。
  return catalog.slice(0, Math.max(0, Math.trunc(limit))).map(
    ({
      capabilityRef,
      label,
      description,
      inputs,
      outputs,
      participation,
      cost,
      network,
      agentSchedulable,
      reason,
      plan
    }) => ({
      capabilityRef,
      label,
      description,
      inputs,
      outputs,
      participation,
      cost,
      network,
      agentSchedulable,
      ...(reason ? { reason } : {}),
      ...(plan ? { plan } : {})
    })
  )
}

/** 计划面（上帝 Agent 可用能力）：只暴露声明了计划面的能力，顺序与媒体适配表一致。 */
export function planCapabilityCatalog(): Array<{ id: string; plan: CapabilityPlanSurface }> {
  return Object.entries(MEDIA_ADAPTERS).map(([id, spec]) => ({ id, plan: spec.plan }))
}

export function planCapabilitySurface(capabilityId: string): CapabilityPlanSurface | null {
  const [typeId, version] = capabilityId.split('@')
  return MEDIA_ADAPTERS[`${typeId}@${version}`]?.plan ?? null
}

// ── 对外 DTO（CLI/MCP 输出 schema；不包含编译载体配置与 builder 钩子）──

export const capabilityPortDtoSchema = z
  .object({
    portId: z.string().min(1).max(80),
    type: z.string().min(1).max(40),
    required: z.boolean(),
    cardinality: z.enum(['one', 'many']),
    name: z.string().max(80).optional(),
    description: z.string().max(300).optional(),
    schemaRef: z
      .object({ id: z.string().min(1).max(80), version: z.number().int().positive() })
      .strict()
      .optional()
  })
  .strict()

export const capabilityPlanDtoSchema = z
  .object({
    title: z.string().min(1).max(120),
    inputType: z.enum(['text', 'image', 'audio', 'video', 'json']),
    outputType: z.enum(['text', 'image', 'audio', 'video', 'json']),
    instruction: z.enum(['required', 'optional', 'forbidden']),
    template: z.enum(['required', 'optional', 'forbidden']),
    reviewable: z.boolean()
  })
  .strict()

export const capabilityDescriptorDtoSchema = z
  .object({
    capabilityRef: z
      .object({
        kind: z.enum(['node', 'composite']),
        id: z.string().min(1).max(80),
        version: z.string().min(1).max(40)
      })
      .strict(),
    label: z.string().min(1).max(200),
    description: z.string().max(1000),
    inputs: z.array(capabilityPortDtoSchema).max(64),
    outputs: z.array(capabilityPortDtoSchema).max(64),
    participation: z.enum(['autonomous', 'collaborative']),
    cost: z.enum(['none', 'possible', 'certain']),
    network: z.enum(['none', 'required']),
    agentSchedulable: z.boolean(),
    reason: z.string().max(500).optional(),
    plan: capabilityPlanDtoSchema.optional()
  })
  .strict()
