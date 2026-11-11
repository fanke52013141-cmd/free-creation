import type { CompositeManifest } from './manifest'

export interface CompositeConnectedPort {
  dir: 'in' | 'out'
  /** 组合实例对外端口 ID（in-<公开输入 id> / out-<公开输出 id>）。 */
  portId: string
  type: string
  cardinality: 'one' | 'many'
  /** 连接该端口的外层节点/边，用于把阻断定位到实际连线。 */
  nodeId?: string
  edgeId?: string
}

export interface CompositePortRequirementChange {
  portId: string
  from: boolean
  to: boolean
}

export interface CompositePortSchemaChange {
  portId: string
  from: string | null
  to: string | null
}

export interface CompositePortCardinalityChange {
  portId: string
  from: 'one' | 'many'
  to: 'one' | 'many'
}

export interface CompositeUpgradeImpact {
  fromVersion: string
  toVersion: string
  addedInputs: string[]
  removedInputs: string[]
  addedOutputs: string[]
  removedOutputs: string[]
  typeChanged: Array<{ portId: string; from: string; to: string }>
  requiredChanged: CompositePortRequirementChange[]
  schemaChanged: CompositePortSchemaChange[]
  cardinalityChanged: CompositePortCardinalityChange[]
  /** 新增必填输入：现有实例没有对应连线，升级前必须补线。 */
  addedRequiredInputs: string[]
  /** 已连接端口受影响时阻断升级；未连接端口可安全移除。 */
  breaking: Array<{ portId: string; reason: string; nodeId?: string; edgeId?: string }>
}

export interface CompositeUpgradePlan {
  ok: boolean
  impact: CompositeUpgradeImpact
}

/** GUI/CLI/MCP 共用的升级预检结果（不含内部 manifest 正文）。 */
export interface CompositeUpgradePreviewResult {
  previousVersion: string
  nextVersion: string
  ok: boolean
  runtimeVersion?: number
  issues?: Array<{ code: string; path: string; message: string }>
  impact: CompositeUpgradeImpact | null
}

interface PortShape {
  type: string
  cardinality: 'one' | 'many'
  required: boolean
  schemaId: string | null
}

function portKey(dir: 'in' | 'out', id: string): string {
  return `${dir}:${id}`
}

function schemaKey(schema: { id: string; version: number } | undefined): string | null {
  return schema ? `${schema.id}@${schema.version}` : null
}

function connectedTo(
  connected: readonly CompositeConnectedPort[],
  dir: 'in' | 'out',
  portId: string
): CompositeConnectedPort[] {
  return connected.filter((port) => port.dir === dir && port.portId === portId)
}

function collectPorts(manifest: CompositeManifest): Map<string, PortShape> {
  const ports = new Map<string, PortShape>()
  for (const input of manifest.inputs) {
    ports.set(portKey('in', `in-${input.id}`), {
      type: input.type,
      cardinality: input.cardinality,
      required: input.required,
      schemaId: schemaKey(input.schemaRef)
    })
  }
  for (const output of manifest.outputs) {
    ports.set(portKey('out', `out-${output.id}`), {
      type: output.type,
      cardinality: output.cardinality,
      required: output.required,
      schemaId: schemaKey(output.schemaRef)
    })
  }
  return ports
}

/**
 * 节点流实例升级预览（W1 公共预检）。
 *
 * 版本只前进不原地修改。比较公开端口 ID、方向、类型、Schema、必填性与基数，
 * 并结合外层实际连线给出阻断项与受影响的节点/边。新增必填输入也阻断升级，
 * 因为现有实例没有对应连线；未连接端口的移除是兼容变化。
 */
export function planCompositeUpgrade(
  previous: CompositeManifest,
  next: CompositeManifest,
  connected: readonly CompositeConnectedPort[]
): CompositeUpgradePlan {
  const before = collectPorts(previous)
  const after = collectPorts(next)

  const impact: CompositeUpgradeImpact = {
    fromVersion: previous.version,
    toVersion: next.version,
    addedInputs: next.inputs.map((input) => `in-${input.id}`).filter((id) => !before.has(portKey('in', id))),
    removedInputs: previous.inputs.map((input) => `in-${input.id}`).filter((id) => !after.has(portKey('in', id))),
    addedOutputs: next.outputs.map((output) => `out-${output.id}`).filter((id) => !before.has(portKey('out', id))),
    removedOutputs: previous.outputs.map((output) => `out-${output.id}`).filter((id) => !after.has(portKey('out', id))),
    typeChanged: [],
    requiredChanged: [],
    schemaChanged: [],
    cardinalityChanged: [],
    addedRequiredInputs: [],
    breaking: []
  }

  for (const input of next.inputs) {
    const portId = `in-${input.id}`
    if (!before.has(portKey('in', portId)) && input.required) {
      impact.addedRequiredInputs.push(portId)
      impact.breaking.push({
        portId,
        reason: '新增必填输入，现有实例没有对应连线，升级前需要补线或设为可选'
      })
    }
  }

  for (const [key, value] of before) {
    const nextValue = after.get(key)
    const [dir, portId] = key.split(':') as ['in' | 'out', string]
    const connections = connectedTo(connected, dir, portId)
    const first = connections[0]
    const location = first
      ? { ...(first.nodeId ? { nodeId: first.nodeId } : {}), ...(first.edgeId ? { edgeId: first.edgeId } : {}) }
      : {}

    if (!nextValue) {
      if (connections.length > 0) {
        impact.breaking.push({ portId, reason: '已连接端口在新版本中不存在', ...location })
      }
      continue
    }
    if (nextValue.type !== value.type) {
      impact.typeChanged.push({ portId, from: value.type, to: nextValue.type })
      if (connections.length > 0) {
        impact.breaking.push({
          portId,
          reason: `端口类型从 ${value.type} 变为 ${nextValue.type}`,
          ...location
        })
      }
    }
    if (nextValue.schemaId !== value.schemaId) {
      impact.schemaChanged.push({ portId, from: value.schemaId, to: nextValue.schemaId })
      if (connections.length > 0) {
        impact.breaking.push({
          portId,
          reason: `端口 Schema 从 ${value.schemaId ?? '无'} 变为 ${nextValue.schemaId ?? '无'}`,
          ...location
        })
      }
    }
    if (nextValue.cardinality !== value.cardinality) {
      impact.cardinalityChanged.push({
        portId,
        from: value.cardinality,
        to: nextValue.cardinality
      })
      if (connections.length > 0) {
        impact.breaking.push({
          portId,
          reason: `端口基数从 ${value.cardinality} 变为 ${nextValue.cardinality}`,
          ...location
        })
      }
    }
    if (nextValue.required !== value.required) {
      impact.requiredChanged.push({ portId, from: value.required, to: nextValue.required })
    }
  }

  return { ok: impact.breaking.length === 0, impact }
}
