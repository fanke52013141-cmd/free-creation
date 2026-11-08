/**
 * 授权域诊断事件。
 *
 * 事件族：license.check.*（启动/复验）、license.activation.*（导入授权）、
 * license.policy.*（撤销策略导入）、license.request.*（设备申请/证明导出）。
 *
 * 隐私边界（方案 §5.2）：只记录版本、操作类型、阶段、原因码、耗时与可重试标记；
 * 公钥、EK/AK、原始证明、设备码、签名文件内容、密码、供应商头与 API Key 一律不记录。
 */
import { emitGatewayEvent } from '../../diagnostics/gateway-events'

function emit(
  event: string,
  status: 'success' | 'failed' | 'cancelled' | 'skipped',
  attributes: Record<string, unknown>,
  startedAtMs: number,
  level: 'info' | 'warn' | 'error'
): void {
  emitGatewayEvent(event, '授权状态变更', undefined, {
    status,
    level,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    attributes: { component: 'license', ...attributes }
  })
}

export interface LicenseCheckLog {
  started(): void
  completed(state: string, reasonCode: string | null): void
  failed(reasonCode: string): void
}

export function licenseCheckLog(trigger: string): LicenseCheckLog {
  const startedAtMs = Date.now()
  emit('license.check.started', 'success', { trigger }, startedAtMs, 'info')
  return {
    started: () => undefined,
    completed: (state, reasonCode) =>
      emit('license.check.completed', 'success', { trigger, state, reasonCode: reasonCode ?? 'none' }, startedAtMs, 'info'),
    failed: (reasonCode) =>
      emit('license.check.failed', 'failed', { trigger, reasonCode }, startedAtMs, 'warn')
  }
}

export function licenseActivationLog(status: 'success' | 'failed', reasonCode: string | null, durationMs: number): void {
  emit('license.activation.completed', status === 'success' ? 'success' : 'failed', { reasonCode: reasonCode ?? 'none' }, Date.now() - durationMs, status === 'success' ? 'info' : 'warn')
}

export function licensePolicyLog(applied: boolean, sequence: number, reasonCode: string | null): void {
  emit(
    'license.policy.completed',
    applied ? 'success' : 'skipped',
    { applied, sequence, reasonCode: reasonCode ?? 'none' },
    Date.now(),
    applied ? 'info' : 'warn'
  )
}

export function licenseRequestLog(action: 'export-request' | 'export-proof' | 'challenge-import', status: 'success' | 'failed', reasonCode: string | null): void {
  emit('license.request.completed', status, { action, reasonCode: reasonCode ?? 'none' }, Date.now(), status === 'success' ? 'info' : 'warn')
}
