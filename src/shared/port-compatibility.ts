import type { PortDecl, PortType } from './types'

/**
 * 连线阶段的 Schema 兼容规则：通用 JSON 可与具体 Schema 相连，但会在运行时按
 * 目标 Schema 验证；具体业务 Schema 必须使用完全相同的 ID 与版本。
 *
 * 说明：实现放在本模块（而不是 node-schemas）以避免
 * `flow-graph → port-compatibility → node-schemas → node-contracts → flow-graph` 运行时环；
 * `node-schemas` 继续 re-export 同一函数，调用方无需改动。
 */
export function nodeSchemasCompatible(
  source: { id: string; version: number } | undefined,
  target: { id: string; version: number } | undefined
): boolean {
  if (!source || !target) return false
  if (source.id === 'json.any' || target.id === 'json.any') return true
  return source.id === target.id && source.version === target.version
}

/**
 * BL-11 / G8：端口兼容判定的**唯一实现**（画布与节点流/Agent Flow 共用）。
 *
 * 此前判定在 renderer 的节点注册表与画布图里，main/shared 侧拿不到，导致节点流只能按
 * 通用端口名重映射。下沉到 shared 后，FlowGraph 校验、编译器、协调器与画布使用同一规则。
 */

/** 基础类型兼容：同类型、文本族互通、iteration 可注入 JSON/媒体、any 通配。 */
export function portCompatible(a: PortType, b: PortType): boolean {
  const bothTextual = (a === 'text' || a === 'markdown') && (b === 'text' || b === 'markdown')
  // 循环项不是普通项目级输出；运行时按列表项形态注入 JSON 或媒体资产引用。
  const iterationTarget =
    a === 'iteration' &&
    (b === 'json' ||
      b === 'camera' ||
      b === 'image' ||
      b === 'video' ||
      b === 'audio' ||
      b === 'file')
  return a === b || bothTextual || iterationTarget || a === 'any' || b === 'any'
}

/**
 * 源输出端口能否接入目标输入端口（类型 + 结构化 Schema 双重校验）。
 *
 * 方向固定为 (out, in)：`portCompatible` 对 iteration 输出是非对称规则
 * （循环项只能作为输出注入 JSON 或符合类型的媒体输入）。所有兼容判断统一经过本函数。
 */
export function portPairCompatible(
  out: { type: PortDecl['type']; schema?: PortDecl['schema'] },
  input: { type: PortDecl['type']; schema?: PortDecl['schema'] }
): boolean {
  const schemaCompatible =
    out.type === 'camera'
      ? Boolean(
          out.schema &&
          input.schema &&
          out.schema.id === input.schema.id &&
          out.schema.version === input.schema.version
        )
      : out.type === 'json'
        ? nodeSchemasCompatible(out.schema, input.schema)
        : true
  return (
    portCompatible(out.type, input.type) &&
    !(
      out.type === input.type &&
      (out.type === 'json' || out.type === 'camera') &&
      !schemaCompatible
    )
  )
}
