import type { CompositeInput, CompositeManifest, CompositeOutput } from './manifest'
import type { ContractInputMap } from '../engine/inputs'
import type { NodeValue } from '../engine/values'

/**
 * 节点流运行时的纯规划/收集逻辑（W1）。
 *
 * 这里只处理“公开端口 → 内部端口”的显式映射，不依赖 tldraw、节点注册表或 Electron：
 * - GUI 隔离执行器（renderer）据此创建虚拟上游节点和连线；
 * - CLI/MCP 与服务层测试可直接断言同一份结果。
 */

export type CompositeRuntimeIssuePhase = 'input' | 'step' | 'output'

export type CompositeRuntimeIssueCode =
  | 'INPUT_REQUIRED'
  | 'INPUT_TYPE_UNSUPPORTED'
  | 'INPUT_VALUE_INVALID'
  | 'OUTPUT_SOURCE_MISSING'
  | 'REQUIRED_OUTPUT_MISSING'
  | 'OUTPUT_TYPE_MISMATCH'
  | 'OUTPUT_VALUE_INVALID'

export interface CompositeRuntimeIssue {
  code: CompositeRuntimeIssueCode
  phase: CompositeRuntimeIssuePhase
  /** 用户可读、已脱敏：只含公开端口/内部节点/端口 ID，不含正文。 */
  message: string
  publicPortId?: string
  nodeId?: string
  portId?: string
}

export interface CompositeInputBinding {
  /** 公开输入端口 ID（不含 in- 前缀）。 */
  inputId: string
  label: string
  target: { nodeId: string; portId: string }
  value: NodeValue
  /** 多值端口内的先后顺序，从 1 开始。 */
  order: number
  /** 虚拟上游节点类型与输出端口，供宿主创建真实连线。 */
  sourceNodeType: 'text' | 'json' | 'image' | 'video' | 'audio' | 'file'
  sourcePortId: string
}

export interface CompositeInputPlan {
  bindings: CompositeInputBinding[]
  issues: CompositeRuntimeIssue[]
}

export interface CompositeOutputPlan {
  /** 公开输出端口 ID → 本次运行的正式值。 */
  outputs: Record<string, NodeValue>
  /** 兼容旧执行器的单一媒体结果（首个媒体输出）。 */
  media: { mediaId: string; mediaPath: string; mime: string } | null
  issues: CompositeRuntimeIssue[]
}

function issue(
  code: CompositeRuntimeIssueCode,
  phase: CompositeRuntimeIssuePhase,
  message: string,
  extra: Partial<Pick<CompositeRuntimeIssue, 'publicPortId' | 'nodeId' | 'portId'>> = {}
): CompositeRuntimeIssue {
  return { code, phase, message, ...extra }
}

/** 公开端口类型与节点值种类的兼容规则，与普通节点连线保持一致。 */
export function compositeValueMatchesPort(value: NodeValue, portType: string): boolean {
  if (portType === 'any') return true
  if (portType === 'text' || portType === 'markdown') {
    return value.kind === 'text' || value.kind === 'markdown'
  }
  return value.kind === portType
}

function sourceForValue(
  value: NodeValue,
  publicType: CompositeInput['type']
): { nodeType: CompositeInputBinding['sourceNodeType']; portId: string } | null {
  if (publicType === 'text' || publicType === 'markdown') {
    if (value.kind === 'text' || value.kind === 'markdown')
      return { nodeType: 'text', portId: 'out-text' }
    return null
  }
  if (publicType === 'json') {
    return value.kind === 'json' ? { nodeType: 'json', portId: 'out-json' } : null
  }
  if (publicType === 'image' && value.kind === 'image') return { nodeType: 'image', portId: 'out-image' }
  if (publicType === 'video' && value.kind === 'video') return { nodeType: 'video', portId: 'out-video' }
  if (publicType === 'audio' && value.kind === 'audio') return { nodeType: 'audio', portId: 'out-audio' }
  if (publicType === 'file' && value.kind === 'file') return { nodeType: 'file', portId: 'out-file' }
  if (publicType === 'any') {
    switch (value.kind) {
      case 'text':
      case 'markdown':
        return { nodeType: 'text', portId: 'out-text' }
      case 'json':
        return { nodeType: 'json', portId: 'out-json' }
      case 'image':
        return { nodeType: 'image', portId: 'out-image' }
      case 'video':
        return { nodeType: 'video', portId: 'out-video' }
      case 'audio':
        return { nodeType: 'audio', portId: 'out-audio' }
      case 'file':
        return { nodeType: 'file', portId: 'out-file' }
      default:
        return null
    }
  }
  return null
}

/**
 * 把本次调用的输入包按公开端口映射为虚拟上游。
 *
 * 输入包顺序即调用顺序；多值端口保留顺序。文本不会直接覆盖内部正文，
 * 而是作为 `in-text` 的上游，由普通文本节点执行器合并与投影。
 */
export function planCompositeInputBindings(
  manifest: CompositeManifest,
  inputs: ContractInputMap
): CompositeInputPlan {
  const bindings: CompositeInputBinding[] = []
  const issues: CompositeRuntimeIssue[] = []
  for (const input of manifest.inputs) {
    const packets = inputs.get(`in-${input.id}`) ?? []
    if (packets.length === 0) {
      // 可选空值：不接虚拟上游，内部节点使用自身正文/默认配置。
      if (input.required && input.defaultValue === undefined) {
        issues.push(
          issue('INPUT_REQUIRED', 'input', `缺少必需输入「${input.label}」（${input.id}）`, {
            publicPortId: input.id
          })
        )
      }
      continue
    }
    if (input.cardinality === 'one' && packets.length > 1) {
      issues.push(
        issue(
          'INPUT_VALUE_INVALID',
          'input',
          `输入「${input.label}」（${input.id}）是单值端口，收到 ${packets.length} 份值`,
          { publicPortId: input.id }
        )
      )
      continue
    }
    for (const [index, packet] of packets.entries()) {
      if (!compositeValueMatchesPort(packet.value, input.type)) {
        issues.push(
          issue(
            'INPUT_TYPE_UNSUPPORTED',
            'input',
            `输入「${input.label}」（${input.id}）声明为 ${input.type}，实际收到 ${packet.value.kind}`,
            { publicPortId: input.id }
          )
        )
        continue
      }
      const source = sourceForValue(packet.value, input.type)
      if (!source) {
        issues.push(
          issue(
            'INPUT_TYPE_UNSUPPORTED',
            'input',
            `输入「${input.label}」（${input.id}）的 ${packet.value.kind} 暂不支持接入节点流`,
            { publicPortId: input.id }
          )
        )
        continue
      }
      for (const target of input.targets) {
        bindings.push({
          inputId: input.id,
          label: input.label,
          target: { nodeId: target.nodeId, portId: target.portId },
          value: packet.value,
          order: index + 1,
          sourceNodeType: source.nodeType,
          sourcePortId: source.portId
        })
      }
    }
  }
  return { bindings, issues }
}

/**
 * 按公开输出映射收集本次运行结果。缺少必需输出返回可定位失败；
 * 可选输出缺失是正常结果。媒体同时返回一个兼容旧执行器的单一产物。
 */
export function collectCompositeOutputs(
  manifest: CompositeManifest,
  read: (nodeId: string, portId: string) => NodeValue | undefined
): CompositeOutputPlan {
  const outputs: Record<string, NodeValue> = {}
  const issues: CompositeRuntimeIssue[] = []
  const mediaOutputs: Array<{ mediaId: string; mediaPath: string; mime: string }> = []

  for (const output of manifest.outputs) {
    const value = read(output.source.nodeId, output.source.portId)
    if (!value) {
      if (output.required) {
        issues.push(
          issue(
            'REQUIRED_OUTPUT_MISSING',
            'output',
            `公开输出「${output.label}」（${output.id}）缺少本次运行结果：内部 ${output.source.nodeId}.${output.source.portId}`,
            { publicPortId: output.id, nodeId: output.source.nodeId, portId: output.source.portId }
          )
        )
      }
      continue
    }
    if (!compositeValueMatchesPort(value, output.type)) {
      issues.push(
        issue(
          'OUTPUT_TYPE_MISMATCH',
          'output',
          `公开输出「${output.label}」（${output.id}）声明为 ${output.type}，实际为 ${value.kind}`,
          { publicPortId: output.id, nodeId: output.source.nodeId, portId: output.source.portId }
        )
      )
      continue
    }
    outputs[output.id] = value
    if (
      value.kind === 'image' ||
      value.kind === 'video' ||
      value.kind === 'audio' ||
      value.kind === 'file'
    ) {
      mediaOutputs.push({ mediaId: value.mediaId, mediaPath: value.mediaPath, mime: value.mime })
    }
  }

  return { outputs, media: mediaOutputs[0] ?? null, issues }
}

/** 供 Agent/GUI 展示的端口摘要；不含正文与媒体路径。 */
export function compositeOutputSummary(
  manifest: CompositeManifest,
  outputs: Record<string, NodeValue>
): Array<{ portId: string; kind: string }> {
  return manifest.outputs
    .filter((output) => outputs[output.id] !== undefined)
    .map((output) => ({ portId: `out-${output.id}`, kind: outputs[output.id]!.kind }))
}

export function findCompositeOutput(
  manifest: CompositeManifest,
  portId: string
): CompositeOutput | undefined {
  const bare = portId.startsWith('out-') ? portId.slice(4) : portId
  return manifest.outputs.find((output) => output.id === bare)
}

export function findCompositeInput(
  manifest: CompositeManifest,
  portId: string
): CompositeInput | undefined {
  const bare = portId.startsWith('in-') ? portId.slice(3) : portId
  return manifest.inputs.find((input) => input.id === bare)
}
