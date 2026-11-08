/**
 * 授权守卫：业务入口（模型调用、密钥读写、导入导出、Agent 接入）统一断言。
 *
 * main/index.ts 的授权门禁通过后调用 setLicenseGateService 注入服务实例；
 * 业务代码只依赖 assertLicenseActive / isLicenseActive，不感知服务内部。
 *
 * 双模式：
 * - 单元测试与既有测试路径不注入服务也未标记强制 → 放行（不破坏现有测试）；
 * - 生产启动路径先 markLicenseGateRequired() 再注册任何业务入口，此后服务缺失
 *   或未激活一律抛 LICENSE_REQUIRED（不存在生产绕行开关）。
 */
import { emitGatewayEvent } from '../../diagnostics/gateway-events'
import { LicenseError } from './errors.ts'
import type { LicenseService, LicenseSnapshot } from './service.ts'

let gateService: LicenseService | null = null
let gateRequired = false

export function setLicenseGateService(service: LicenseService | null): void {
  gateService = service
}

/** 生产入口在注册业务 IPC 之前调用；此后服务缺失视为致命配置错误。 */
export function markLicenseGateRequired(): void {
  gateRequired = true
}

/** 当前快照；授权服务未初始化时返回 unlicensed 快照。 */
export function licenseSnapshot(): LicenseSnapshot {
  return (
    gateService?.snapshot ?? {
      state: 'unlicensed',
      licenseId: null,
      sequence: null,
      term: null,
      expiresAt: null,
      capabilities: [],
      deviceSummary: null,
      reasonCode: null,
      message: gateRequired ? '授权服务未初始化' : '授权服务未注入（开发/测试路径）'
    }
  )
}

export function isLicenseActive(): boolean {
  return licenseSnapshot().state === 'active'
}

/**
 * 敏感操作准入断言。未激活时抛 LICENSE_REQUIRED（LicenseError）。
 * @param operation 面向诊断日志的稳定操作标识，如 'model.secret.read'。
 */
export function assertLicenseActive(operation: string): void {
  const service = gateService
  if (!service) {
    if (gateRequired) {
      throw new LicenseError('LICENSE_REQUIRED', `操作 ${operation} 被拒绝：授权服务未初始化`)
    }
    // 开发/测试路径未接入门禁：放行但留痕，便于在日志里发现漏接。
    emitGatewayEvent('license.guard.skipped', '授权门禁未注入（开发/测试路径）', undefined, {
      status: 'skipped',
      level: 'debug',
      attributes: { component: 'license', operation }
    })
    return
  }
  service.assertActive(operation)
}
