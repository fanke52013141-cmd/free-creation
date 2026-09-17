import { nodeSchemasCompatible } from '@shared/node-schemas'
import type { NodeTypeId, PortDecl } from '@shared/types'
import { allNodeTypes } from '../nodes/registry'
import { portPairCompatible } from './graph'
import type { ConnectionFrom } from '../stores/connection'

export interface NodeCreateChoice {
  type: NodeTypeId
  /**
   * 菜单显式选定的端口：
   * - out 方向拉线：新建节点的目标输入端口；
   * - in 方向拉线：新建节点的源输出端口。
   */
  targetPortId?: string
  targetPort?: PortDecl
}

/**
 * 正向拉线（从输出端口拖到空白）：为每个兼容输入返回一个选项，
 * 而不是在新建多输入节点时静默选择第一个端口。
 */
export function compatibleNodeCreateChoices(source: ConnectionFrom): NodeCreateChoice[] {
  const asPort = { type: source.portType, schema: source.schema }
  return allNodeTypes().flatMap((spec) =>
    spec.ports.in
      .filter(
        (port) =>
          portPairCompatible(asPort, port) &&
          // 菜单层面的机位通道 Schema 收紧：机位端口成对出现时必须带同一 Schema。
          // 正式连线校验（tryConnect/createEdge）只对 json 做 Schema 硬校验；
          // 这里是入口过滤，保证菜单不会提出一个“选中后注定语义错误”的选项。
          !(
            source.portType === 'camera' &&
            port.type === 'camera' &&
            !nodeSchemasCompatible(source.schema, port.schema)
          ) &&
          // 批量来源只能落到显式声明为多值的输入；新建节点后不会产生
          // “看起来连上、实际只消费第一张”的隐式降级。
          (!source.memberIds?.length || port.cardinality === 'many')
      )
      .map((targetPort) => ({
        type: spec.type,
        targetPortId: targetPort.id,
        targetPort
      }))
  )
}

/**
 * 反向拉线（从输入端口拖到空白）：枚举可作为新上游节点的输出端口。
 *
 * 与 compatibleNodeCreateChoices 对称：新建节点后，其 `targetPortId`
 * 指向的输出端口会接入拖线的输入端口。输入端口已在拖出时确定，
 * 因此这里不再按基数过滤（基数约束只对输入端有意义）。
 */
export function compatibleUpstreamCreateChoices(source: ConnectionFrom): NodeCreateChoice[] {
  const asPort = { type: source.portType, schema: source.schema }
  return allNodeTypes().flatMap((spec) =>
    spec.ports.out
      .filter(
        (port) =>
          portPairCompatible(port, asPort) &&
          !(
            source.portType === 'camera' &&
            port.type === 'camera' &&
            !nodeSchemasCompatible(port.schema, source.schema)
          )
      )
      .map((sourcePort) => ({
        type: spec.type,
        targetPortId: sourcePort.id,
        targetPort: sourcePort
      }))
  )
}
