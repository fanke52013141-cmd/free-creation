import type { NodeExecutionMode, PortDecl } from '@shared/types'
import type { RawNodeOutputs } from '../nodes/nodeValues'

export type NodeReadinessKind = 'blocked' | 'ready' | 'manual-publish' | 'running' | 'failed'

export interface NodeReadiness {
  kind: NodeReadinessKind
  label: string
  detail: string
  /** T06：blocked 的结构化原因，供运行计划（T07）复用；ready 时缺省。 */
  reason?: 'not-connected' | 'config-missing'
}

/** 正文即输入的节点：正文为空时执行器必然 skipped（与执行器分支同步维护）。 */
const TEXT_REQUIRED_NODES: Readonly<Record<string, string>> = {
  'image-gen': '提示词',
  text: '文本内容',
  speech: '朗读文本',
  'ai-process': '任务说明'
}

export interface InputPortReadiness {
  count: number
  kind: 'missing' | 'connected' | 'optional'
  label: string
}

/** 将端口级连接数量投影为卡片和详情面板可共用的可读状态。 */
export function deriveInputPortReadiness(
  inputs: PortDecl[],
  incomingCounts: ReadonlyMap<string, number>
): ReadonlyMap<string, InputPortReadiness> {
  return new Map(
    inputs.map((port) => {
      const count = incomingCounts.get(port.id) ?? 0
      const kind: InputPortReadiness['kind'] =
        count > 0 ? 'connected' : port.required ? 'missing' : 'optional'
      const quantity =
        port.cardinality === 'many' ? `${count} 条连接` : count > 0 ? '已连接' : '未连接'
      return [
        port.id,
        {
          count,
          kind,
          label: kind === 'missing' ? `缺少必填输入` : quantity
        }
      ]
    })
  )
}

/**
 * 将节点规范、现有连线和正式输出转换为用户可理解的“下一步”。这不是另一套执行规则：
 * required/cardinality 与 output projection 都直接复用节点契约的单一真值。
 * T06：新增可选 nodeType/text，用于把“正文为空则运行必被跳过”提前呈现为待补充，
 * 判定清单须与执行器的 skipped 分支同步（imageGen/aiProcess/speech 等）。
 */
export function deriveNodeReadiness(input: {
  executionMode: NodeExecutionMode
  exec: string
  nodeType?: string
  text?: string
  inputs: PortDecl[]
  incomingCounts: ReadonlyMap<string, number>
  outputs: RawNodeOutputs
}): NodeReadiness {
  if (input.exec === 'running' || input.exec === 'queued' || input.exec === 'pending') {
    return {
      kind: 'running',
      label: '处理中',
      detail: '节点正在等待或执行，结果完成后会自动更新。'
    }
  }
  if (input.exec === 'failed') {
    return { kind: 'failed', label: '运行失败', detail: '打开节点详情查看错误原因并重试。' }
  }

  const missing = input.inputs.filter(
    (port) => port.required && (input.incomingCounts.get(port.id) ?? 0) === 0
  )
  if (missing.length > 0) {
    return {
      kind: 'blocked',
      reason: 'not-connected',
      label: `缺少输入：${missing.map((port) => port.name).join('、')}`,
      detail: '连接对应端口后即可运行。'
    }
  }

  // T06：正文必需节点的配置预检——正文为空时执行器必然 skipped，提前呈现待补充，
  // 避免用户点了运行才发现「无提示词」。
  const textRequirement = input.nodeType ? TEXT_REQUIRED_NODES[input.nodeType] : undefined
  if (textRequirement && !(input.text ?? '').trim()) {
    return {
      kind: 'blocked',
      reason: 'config-missing',
      label: `待补充：${textRequirement}`,
      detail: `填写${textRequirement}后即可运行。`
    }
  }

  if (input.executionMode === 'manual-publish') {
    const hasPublishedOutput = Object.keys(input.outputs).some((portId) => portId !== 'out-project')
    return hasPublishedOutput
      ? { kind: 'ready', label: '已发布', detail: '当前正式输出可供下游节点使用。' }
      : { kind: 'manual-publish', label: '等待发布', detail: '打开工作区，手动发布画面或媒体。' }
  }

  return {
    kind: 'ready',
    label: '可运行',
    detail: '输入与节点契约已满足，可执行此节点或整个工作流。'
  }
}
