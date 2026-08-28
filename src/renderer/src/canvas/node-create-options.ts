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
          !(
            source.portType === 'json' &&
            port.type === 'json' &&
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
