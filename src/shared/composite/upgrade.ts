import type { CompositeManifest } from './manifest'

export interface CompositeConnectedPort {
  dir: 'in' | 'out'
  /** 组合实例对外端口 ID（in-<公开输入 id> / out-<公开输出 id>）。 */
  portId: string
  type: string
  cardinality: 'one' | 'many'
}

export interface CompositeUpgradeImpact {
  fromVersion: string
  toVersion: string
  addedInputs: string[]
  removedInputs: string[]
  addedOutputs: string[]
  removedOutputs: string[]
  typeChanged: Array<{ portId: string; from: string; to: string }>
  /** 已连接端口受影响时阻断升级；未连接端口可安全移除。 */
  breaking: Array<{ portId: string; reason: string }>
}

export interface CompositeUpgradePlan {
  ok: boolean
  impact: CompositeUpgradeImpact
}

function portKey(dir: 'in' | 'out', id: string): string {
  return `${dir}:${id}`
}

/**
 * 组合实例升级预览（P4）。版本只前进不原地修改；已连接端口被删除、类型变化或
 * 基数收紧时阻断，避免静默改写下游数据依赖。新端口/未连接端口移除是兼容变化。
 */
export function planCompositeUpgrade(
  previous: CompositeManifest,
  next: CompositeManifest,
  connected: readonly CompositeConnectedPort[]
): CompositeUpgradePlan {
  const before = new Map<string, { type: string; cardinality: 'one' | 'many' }>()
  for (const input of previous.inputs) before.set(portKey('in', `in-${input.id}`), { type: input.type, cardinality: input.cardinality })
  for (const output of previous.outputs) before.set(portKey('out', `out-${output.id}`), { type: output.type, cardinality: output.cardinality })
  const after = new Map<string, { type: string; cardinality: 'one' | 'many' }>()
  for (const input of next.inputs) after.set(portKey('in', `in-${input.id}`), { type: input.type, cardinality: input.cardinality })
  for (const output of next.outputs) after.set(portKey('out', `out-${output.id}`), { type: output.type, cardinality: output.cardinality })

  const impact: CompositeUpgradeImpact = {
    fromVersion: previous.version,
    toVersion: next.version,
    addedInputs: next.inputs.map((input) => `in-${input.id}`).filter((id) => !before.has(portKey('in', id))),
    removedInputs: previous.inputs.map((input) => `in-${input.id}`).filter((id) => !after.has(portKey('in', id))),
    addedOutputs: next.outputs.map((output) => `out-${output.id}`).filter((id) => !before.has(portKey('out', id))),
    removedOutputs: previous.outputs.map((output) => `out-${output.id}`).filter((id) => !after.has(portKey('out', id))),
    typeChanged: [],
    breaking: []
  }

  for (const [key, value] of before) {
    const nextValue = after.get(key)
    const [dir, portId] = key.split(':') as ['in' | 'out', string]
    if (!nextValue) {
      if (connected.some((port) => port.dir === dir && port.portId === portId)) {
        impact.breaking.push({ portId, reason: '已连接端口在新版本中不存在' })
      }
      continue
    }
    if (nextValue.type !== value.type) {
      impact.typeChanged.push({ portId, from: value.type, to: nextValue.type })
      if (connected.some((port) => port.dir === dir && port.portId === portId)) {
        impact.breaking.push({ portId, reason: `端口类型从 ${value.type} 变为 ${nextValue.type}` })
      }
    }
    if (value.cardinality === 'one' && nextValue.cardinality === 'many' && connected.some((port) => port.dir === dir && port.portId === portId)) {
      impact.breaking.push({ portId, reason: '单值端口放宽为多值，已连接的下游无法自动迁移' })
    }
  }

  return { ok: impact.breaking.length === 0, impact }
}
