import type { Editor } from 'tldraw'
import { computeInputFingerprint } from '@shared/engine/input-fingerprint'
import type { NodeCardShape } from '../canvas/NodeCardShape'
import { getNodeType } from '../nodes/registry'
import { projectNodeOutputs, type NodeValue } from '../nodes/nodeValues'
import type { ContractInputMap } from './contracts'
import { readNodeRunHistory, readNodeRunRecord } from './runRecord'

type FingerprintInputs = ReadonlyMap<
  string,
  readonly { source: { nodeId: string; portId: string }; value: NodeValue | undefined }[]
>

export function fingerprintNodeInputs(
  shape: NodeCardShape,
  inputs: FingerprintInputs | ContractInputMap
): string {
  return computeInputFingerprint({
    contractVersion: getNodeType(shape.props.nodeType)?.contractVersion ?? 0,
    config: shape.props.config,
    text: shape.props.text,
    sources: Array.from(inputs.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([portId, packets]) =>
        packets.map((packet) => ({
          portId,
          nodeId: packet.source.nodeId,
          sourcePortId: packet.source.portId,
          value:
            packet.value && 'mediaId' in packet.value
              ? { kind: packet.value.kind, mediaId: packet.value.mediaId, mime: packet.value.mime }
              : packet.value
        }))
      )
  })
}

/** Uses the same saved arrow order as deriveGraph; missing outputs remain detectable. */
export function currentNodeFingerprint(editor: Editor, shape: NodeCardShape): string {
  const inputs = new Map<
    string,
    Array<{ source: { nodeId: string; portId: string }; value: NodeValue | undefined }>
  >()
  const seen = new Set<string>()
  for (const arrow of editor
    .getCurrentPageShapes()
    .sort((a, b) => String(a.index ?? '').localeCompare(String(b.index ?? '')))) {
    if (arrow.type !== 'arrow') continue
    const bindings = editor.getBindingsFromShape(arrow.id, 'arrow')
    const start = bindings.find((binding) => binding.props.terminal === 'start')
    const end = bindings.find((binding) => binding.props.terminal === 'end')
    if (!start || end?.toId !== shape.id) continue
    const portId = String(arrow.meta.toPort ?? '')
    const sourcePortId = String(arrow.meta.fromPort ?? '')
    const key = JSON.stringify([start.toId, sourcePortId, portId])
    if (seen.has(key)) continue
    seen.add(key)
    const source = editor.getShape<NodeCardShape>(start.toId)
    const value =
      source?.type === 'node-card' ? projectNodeOutputs(source)[sourcePortId] : undefined
    const packets = inputs.get(portId) ?? []
    packets.push({ source: { nodeId: start.toId, portId: sourcePortId }, value })
    inputs.set(portId, packets)
  }
  return fingerprintNodeInputs(shape, inputs)
}

export function successfulInputFingerprint(shape: NodeCardShape): string | undefined {
  const current = readNodeRunRecord(shape.meta.nodeRun)
  return (
    current?.status === 'success'
      ? current
      : readNodeRunHistory(shape.meta.nodeRunHistory).find((run) => run.status === 'success')
  )?.inputFingerprint
}
