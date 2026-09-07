import { nodeSchemasCompatible } from '@shared/node-schemas'
import type { NodeTypeId, PortDecl } from '@shared/types'
import { allNodeTypes, portCompatible } from '../nodes/registry'
import type { ConnectionFrom } from '../stores/connection'

export interface NodeCreateChoice {
  type: NodeTypeId
  targetPortId?: string
  targetPort?: PortDecl
}

/**
 * Return one item per compatible input, rather than silently selecting the
 * first port on a newly created multi-input node.
 */
export function compatibleNodeCreateChoices(source: ConnectionFrom): NodeCreateChoice[] {
  return allNodeTypes().flatMap((spec) =>
    spec.ports.in
      .filter(
        (port) =>
          portCompatible(source.portType, port.type) &&
          // 批量来源只能落到显式声明为多值的输入；新建节点后不会产生
          // “看起来连上、实际只消费第一张”的隐式降级。
          (!source.memberIds?.length || port.cardinality === 'many') &&
          !(
            (source.portType === 'json' || source.portType === 'camera') &&
            port.type === source.portType &&
            !nodeSchemasCompatible(source.schema, port.schema)
          )
      )
      .map((targetPort) => ({
        type: spec.type,
        targetPortId: targetPort.id,
        targetPort
      }))
  )
}
