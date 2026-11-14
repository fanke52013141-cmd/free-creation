import type { WorkflowInput } from '@shared/agent-access/run-ops'
import type { CanvasEdge, CanvasNode, MediaAsset, PortDecl } from '@shared/types'
import type { ContractInputMap } from '@shared/engine/inputs'
import type { NodeValue } from '@shared/engine/values'
import { portCompatible } from '../nodes/registry'
import { portsOf } from './contracts'
import { readCompositeInstanceManifest } from '@shared/composite/outputs'

export type RequestWorkflowInput = (request: {
  projectId: string
  title: string
  port: PortDecl
  onCancel: (listener: () => void) => () => void
}) => Promise<WorkflowInput['value'] | null>

/** 汇总表单的一次缺口项（节点 + 端口）。 */
export interface WorkflowInputGap {
  nodeId: string
  title: string
  port: PortDecl
}

/** 批量补输入：一次列出所有缺口，返回用户填写的输入集合；null 表示取消整个运行。 */
export type RequestWorkflowInputs = (request: {
  projectId: string
  gaps: readonly WorkflowInputGap[]
  onCancel: (listener: () => void) => () => void
}) => Promise<readonly WorkflowInput[] | null>

export interface WorkflowInputOptions {
  inputs?: readonly WorkflowInput[]
  requestInput?: RequestWorkflowInput
  /** GUI 优先使用的汇总表单回调；缺省时回退串行 requestInput。 */
  requestInputs?: RequestWorkflowInputs
  confirmPaidRerun?: boolean
}

/**
 * 内容即输入的节点：内容缺失时执行器必然 skipped，需把 in-text 视为待补输入。
 * 单一真值，供补输入缺口判定使用；判定条件与各执行器的 skipped 分支保持一致。
 * hasSource(portId) 表示该端口已有上游连线/已收集输入/已供临时值。
 */
export function nodeNeedsContentInput(
  nodeType: string,
  body: string,
  hasSource: (portId: string) => boolean
): boolean {
  switch (nodeType) {
    case 'text':
      return !body.trim()
    case 'ai-process':
      return !hasSource('in-json')
    case 'image-gen':
      return !body.trim() && !hasSource('in-prompt')
    case 'speech':
      return !body.trim() && !hasSource('in-text')
    case 'chat': {
      if (hasSource('in-text')) return false
      // 交互式对话：已有待发送的用户消息时，消息本身即本轮输入，无需补充输入端口
      // （否则聊天发送会卡在"等待补充本次运行的输入"，无法进入生图/对话执行）。
      try {
        const data = JSON.parse(body) as {
          activeConversationId?: string
          conversations?: Array<{ id?: string; messages?: Array<{ role?: string }> }>
          messages?: Array<{ role?: string }>
        }
        const conversation =
          data.conversations?.find((item) => item.id === data.activeConversationId) ??
          data.conversations?.[0]
        const messages = conversation?.messages ?? data.messages ?? []
        if (messages.at(-1)?.role === 'user') return false
      } catch {
        /* 正文非合法 JSON 时按需要输入处理。 */
      }
      return true
    }
    case 'video':
      return !body.trim() && !hasSource('in-prompt') && !hasSource('in-text')
    case 'voice-design':
      return !body.trim() && !hasSource('in-text')
    case 'json':
    case 'storyboard':
      return !body.trim() && !hasSource('in-json') && !hasSource('in-text')
    case 'structured':
      // 正文是 JSON 模板（in-text 仅喂占位符）；正文空时需补模板，经 temporaryText 注入正文。
      return !body.trim()
    default:
      return false
  }
}

export function missingWorkflowPorts(
  node: CanvasNode,
  body: string,
  edges: readonly CanvasEdge[],
  inputs: ContractInputMap,
  supplied: readonly WorkflowInput[]
): PortDecl[] {
  const ports = portsOf(node).in
  const connected = new Set(
    edges.filter((edge) => edge.to.nodeId === node.id).map((edge) => edge.to.portId)
  )
  const hasInput = (id: string): boolean => (inputs.get(id)?.length ?? 0) > 0
  const isSupplied = (id: string): boolean =>
    supplied.some((entry) => entry.nodeId === node.id && entry.portId === id)
  const hasSource = (id: string): boolean => hasInput(id) || connected.has(id) || isSupplied(id)
  // 节点流公开输入的 defaultValue 与运行时必填口径一致：不强制补充临时输入。
  const fixedSatisfied = new Set<string>()
  if (node.type === 'composite') {
    const config = node.params.config
    const manifest = readCompositeInstanceManifest({
      props: { config: typeof config === 'string' ? config : undefined },
      meta: node.meta
    })
    for (const input of manifest?.inputs ?? []) {
      if (input.defaultValue !== undefined) fixedSatisfied.add(`in-${input.id}`)
    }
  }
  const needsText = nodeNeedsContentInput(node.type, body, hasSource)
  const groups = new Set<string>()
  return ports.filter((port) => {
    if (hasInput(port.id) || connected.has(port.id) || fixedSatisfied.has(port.id)) return false
    if (port.exclusiveGroup) {
      if (
        groups.has(port.exclusiveGroup) ||
        ports.some(
          (other) =>
            other.exclusiveGroup === port.exclusiveGroup &&
            (hasInput(other.id) || connected.has(other.id))
        )
      )
        return false
      // Respect an explicitly supplied member before picking a default for the form.
      const preferred = supplied.find(
        (entry) =>
          entry.nodeId === node.id &&
          ports.some(
            (other) => other.id === entry.portId && other.exclusiveGroup === port.exclusiveGroup
          )
      )
      if (preferred && preferred.portId !== port.id) return false
      groups.add(port.exclusiveGroup)
      return true
    }
    return port.required || (port.id === 'in-text' && needsText) || isSupplied(port.id)
  })
}

export function workflowInputValue(
  port: PortDecl,
  input: WorkflowInput['value'],
  assets: readonly MediaAsset[]
): NodeValue {
  if (input.kind !== 'media') {
    if (!portCompatible(input.kind, port.type)) throw new Error('输入契约：临时输入类型不匹配')
    return input
  }
  const asset = assets.find((candidate) => candidate.id === input.mediaId)
  if (!asset) throw new Error('输入契约：素材不属于当前项目或已删除')
  const kind = port.type === 'file' ? 'file' : asset.kind
  if (!portCompatible(kind, port.type)) throw new Error('输入契约：素材类型不匹配')
  return { kind, mediaId: asset.id, mediaPath: asset.path, mime: asset.mime }
}
