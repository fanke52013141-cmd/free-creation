/**
 * P3 节点契约唯一来源门禁。
 *
 * Capability Registry 是端口、版本、描述、分类和执行语义的运行时事实来源；
 * renderer Spec 只能补充 UI、执行器与输出投影，不能自带另一份可生效的端口表。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { listCapabilities } from '@capabilities'
import { activeNodeTypes, getNodeType } from '@renderer/nodes/registry'
import { registerAllNodeTypes } from '../helpers/registerNodes'

beforeAll(() => registerAllNodeTypes())

describe('P3 · Capability Registry 是节点运行时契约唯一来源', () => {
  it('每个 ActiveNodeType 都有一份 Capability 契约', () => {
    const capabilities = listCapabilities()
    const nodeTypes = new Set(capabilities.map((capability) => capability.nodeType))

    for (const spec of activeNodeTypes()) {
      expect(nodeTypes.has(spec.type)).toBe(true)
    }
  })

  it('画布注册表的版本、语义、端口严格投影自 Capability', () => {
    for (const capability of listCapabilities()) {
      const spec = getNodeType(capability.nodeType)
      expect(spec, `${capability.nodeType} 未注册到画布`).toBeDefined()
      expect(spec?.contractVersion).toBe(capability.contractVersion)
      expect(spec?.label).toBe(capability.title)
      expect(spec?.description).toBe(capability.description)
      expect(spec?.category).toBe(capability.category)
      expect(spec?.executionMode).toBe(capability.runtime.executionMode)
      expect(spec?.ports.in).toEqual(capability.inputs.map((port) => ({ ...port, dir: 'in' })))
      expect(spec?.ports.out).toEqual(capability.outputs.map((port) => ({ ...port, dir: 'out' })))
    }
  })

  it('所有 Capability JSON 端口都有可注册的结构 Schema', () => {
    for (const capability of listCapabilities()) {
      for (const port of [...capability.inputs, ...capability.outputs]) {
        if (port.type === 'json') {
          expect(port.schema, `${capability.id}:${port.id}`).toBeDefined()
        } else {
          expect(port.schema, `${capability.id}:${port.id}`).toBeUndefined()
        }
      }
    }
  })
})
