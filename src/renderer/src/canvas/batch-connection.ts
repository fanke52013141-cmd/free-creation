import type { Editor, TLShapeId } from 'tldraw'
import type { PortDecl } from '@shared/types'
import { getNodePorts, getNodeType } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import type { BatchConnectionMember, ConnectionFrom } from '../stores/connection'

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
 * 优先将同名、同类型、同 Schema 输出收敛为一个多值批量来源，保留“多张图片
 * 一起拖入”这一既有行为。若没有共有输出，但每个成员都有唯一可判定的输出，则
 * 返回显式的异构成员端口表；目标节点必须再为每个成员找到声明兼容的真实输入。
 *
 * 不会创建 `any`、猜测输出或合成隐式数据：有多个候选输出的异构节点必须从其
 * 具体输出端口开始拖动，避免手势替用户作业务决定。
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
  if (port) {
    return {
      shapeId: anchor.id,
      portId: port.id,
      portType: port.type,
      ...(port.schema ? { schema: port.schema } : {}),
      memberIds: members.map((member) => member.id)
    }
  }

  const memberPorts: BatchConnectionMember[] = []
  for (const member of members) {
    const spec = getNodeType(member.props.nodeType)
    const outputs = spec ? getNodePorts(spec, member).out : []
    const explicit =
      member.id === anchor.id && preferredPortId
        ? outputs.find((candidate) => candidate.id === preferredPortId)
        : outputs.length === 1
          ? outputs[0]
          : undefined
    if (!explicit) return null
    memberPorts.push({
      shapeId: member.id,
      portId: explicit.id,
      portType: explicit.type,
      ...(explicit.schema ? { schema: explicit.schema } : {})
    })
  }

  const anchorPort = memberPorts[0]
  return {
    shapeId: anchorPort.shapeId,
    portId: anchorPort.portId,
    portType: anchorPort.portType,
    ...(anchorPort.schema ? { schema: anchorPort.schema } : {}),
    memberIds: memberPorts.map((member) => member.shapeId),
    memberPorts
  }
}
