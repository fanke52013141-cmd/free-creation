import type { Editor, TLShapeId } from 'tldraw'
import type { PortDecl } from '@shared/types'
import { getNodePorts, getNodeType } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import type { ConnectionFrom } from '../stores/connection'

function schemaKey(schema: PortDecl['schema']): string {
  return schema ? `${schema.id}@${schema.version}` : ''
}

function selectedNodeShapes(editor: Editor, ids: readonly TLShapeId[]): NodeCardShape[] {
  return ids
    .map((id) => editor.getShape<NodeCardShape>(id))
    .filter((shape): shape is NodeCardShape => shape?.type === 'node-card')
}

/**
 * 把多个已选节点收敛成一个可拖拽的批量输出来源。
 *
 * 只有每个成员都拥有同名、同类型、同 Schema 的输出端口时才允许批量连线；
 * 这保证“多张图片一起拖入”不会把不相干的节点混进同一条数据输入。
 */
export function batchConnectionFromSelection(
  editor: Editor,
  ids: readonly TLShapeId[],
  preferredPortId?: string
): ConnectionFrom | null {
  const members = selectedNodeShapes(editor, [...new Set(ids)])
  if (members.length < 2) return null
  const anchor = members[0]
  const anchorSpec = getNodeType(anchor.props.nodeType)
  if (!anchorSpec) return null
  const port = getNodePorts(anchorSpec, anchor).out.find((candidate) => {
    if (preferredPortId && candidate.id !== preferredPortId) return false
    return members.every((member) => {
      const spec = getNodeType(member.props.nodeType)
      const peer = spec
        ? getNodePorts(spec, member).out.find((item) => item.id === candidate.id)
        : undefined
      return peer?.type === candidate.type && schemaKey(peer.schema) === schemaKey(candidate.schema)
    })
  })
  if (!port) return null
  return {
    shapeId: anchor.id,
    portId: port.id,
    portType: port.type,
    ...(port.schema ? { schema: port.schema } : {}),
    memberIds: members.map((member) => member.id)
  }
}
