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

export interface WorkflowInputOptions {
  inputs?: readonly WorkflowInput[]
  requestInput?: RequestWorkflowInput
  confirmPaidRerun?: boolean
}

export function missingWorkflowPorts(
  node: CanvasNode,
  body: string,
  edges: readonly CanvasEdge[],
  inputs: ContractInputMap,
  supplied: readonly WorkflowInput[]
): PortDecl[] {
  const ports = portsOf(node).in
  const connected = new Set(edges.filter((edge) => edge.to.nodeId === node.id).map((edge) => edge.to.portId))
  const hasInput = (id: string): boolean => (inputs.get(id)?.length ?? 0) > 0
  const isSupplied = (id: string): boolean => supplied.some((entry) => entry.nodeId === node.id && entry.portId === id)
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
  const needsText =
    (node.type === 'text' && !body.trim()) ||
    (node.type === 'ai-process' && !hasSource('in-json')) ||
    (node.type === 'image-gen' && !body.trim() && !hasSource('in-prompt'))
  const groups = new Set<string>()
  return ports.filter((port) => {
    if (hasInput(port.id) || connected.has(port.id) || fixedSatisfied.has(port.id)) return false
    if (port.exclusiveGroup) {
      if (groups.has(port.exclusiveGroup) || ports.some((other) =>
        other.exclusiveGroup === port.exclusiveGroup && (hasInput(other.id) || connected.has(other.id))
      )) return false
      // Respect an explicitly supplied member before picking a default for the form.
      const preferred = supplied.find((entry) => entry.nodeId === node.id && ports.some((other) =>
        other.id === entry.portId && other.exclusiveGroup === port.exclusiveGroup
      ))
      if (preferred && preferred.portId !== port.id) return false
      groups.add(port.exclusiveGroup)
      return true
    }
    return port.required || (port.id === 'in-text' && needsText) ||
      isSupplied(port.id)
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
