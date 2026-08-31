/**
 * CapabilityService — 能力查询
 *
 * 提供 Agent 友好的能力发现接口。
 * Agent 可以先查询可用能力和节点规范，再决定如何组装工作流。
 */

import {
  getCapability,
  getCapabilityByNodeType,
  listCapabilities
} from '@capabilities'
import type { Capability, ConfigFieldSchema } from '@capabilities/types'
import type { Result, ServiceContext } from '../types'
import { ok, fail } from '../types'

export class CapabilityService {
  constructor(_ctx: ServiceContext) {}

  /** 列出所有暴露给当前入口的能力 */
  async listCapabilities(exposure?: 'desktop' | 'cli' | 'mcp'): Promise<Result<Capability[]>> {
    const all = listCapabilities()
    const filtered = exposure
      ? all.filter((cap) => cap.expose[exposure])
      : all
    return ok(filtered)
  }

  /** 获取指定能力的完整定义 */
  async getCapability(id: string): Promise<Result<Capability>> {
    const cap = getCapability(id)
    if (!cap) {
      return fail('CAPABILITY_NOT_FOUND', `能力不存在: ${id}`, { entityId: id })
    }
    return ok(cap)
  }

  /** 按节点类型获取能力 */
  async getCapabilityByNodeType(nodeType: string): Promise<Result<Capability>> {
    const cap = getCapabilityByNodeType(nodeType)
    if (!cap) {
      return fail('CAPABILITY_NOT_FOUND', `节点类型 ${nodeType} 未注册`, { entityId: nodeType })
    }
    return ok(cap)
  }

  /** 获取能力的配置 Schema（用于动态渲染设置面板或校验参数） */
  async getConfigSchema(capabilityId: string): Promise<Result<Capability['configSchema']>> {
    const cap = getCapability(capabilityId)
    if (!cap) {
      return fail('CAPABILITY_NOT_FOUND', `能力不存在: ${capabilityId}`)
    }
    return ok(cap.configSchema)
  }

  /**
   * 校验节点配置是否符合能力定义。
   * Agent 在设置节点参数前可调用此方法预先校验。
   */
  async validateNodeConfig(
    nodeType: string,
    config: Record<string, unknown>
  ): Promise<Result<{ valid: boolean; errors: string[] }>> {
    const cap = getCapabilityByNodeType(nodeType)
    if (!cap) {
      return fail('CAPABILITY_NOT_FOUND', `节点类型 ${nodeType} 未注册`)
    }

    const errors: string[] = []

    for (const [key, field] of Object.entries(cap.configSchema) as Array<[string, ConfigFieldSchema]>) {
      const value = config[key]

      if (field.required && (value === undefined || value === null || value === '')) {
        errors.push(`缺少必填配置: ${key}`)
        continue
      }

      if (value === undefined) continue

      // 类型检查
      if (field.type === 'enum' && field.enumValues && !field.enumValues.includes(String(value))) {
        errors.push(`配置 ${key} 的值 "${value}" 不在允许范围: ${field.enumValues.join(', ')}`)
      }

      if (field.type === 'number') {
        const num = Number(value)
        if (isNaN(num)) {
          errors.push(`配置 ${key} 需要数字类型`)
        } else {
          if (field.minimum !== undefined && num < field.minimum) {
            errors.push(`配置 ${key} 不能小于 ${field.minimum}`)
          }
          if (field.maximum !== undefined && num > field.maximum) {
            errors.push(`配置 ${key} 不能大于 ${field.maximum}`)
          }
        }
      }
    }

    return ok({ valid: errors.length === 0, errors })
  }
}
