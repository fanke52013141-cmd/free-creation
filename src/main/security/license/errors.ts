/**
 * 授权域稳定错误码。
 *
 * 对外出现在授权窗口、日志原因码与签发工具输出中：
 * 只能新增，不能修改既有码的含义。
 * 协议层码（文件/签名/证书）与授权域码（状态机/流程）共用一个命名空间。
 */
import type { LicenseProtocolErrorCode } from '@free-creation/license-protocol'

export type LicenseDomainErrorCode =
  // 授权文件层
  | 'LICENSE_MISSING'
  | 'LICENSE_INVALID'
  | 'LICENSE_EXPIRED'
  | 'LICENSE_REVOKED'
  | 'LICENSE_DEVICE_MISMATCH'
  | 'LICENSE_SEQUENCE_REGRESSED'
  | 'LICENSE_TIME_AMBIGUOUS'
  // 激活流程层
  | 'ACTIVATION_CHALLENGE_MISMATCH'
  | 'ACTIVATION_PROOF_REJECTED'
  | 'ACTIVATION_STORE_FAILED'
  // 守卫层
  | 'LICENSE_REQUIRED'
  // 设备层
  | 'DEVICE_PROBE_FAILED'
  | 'DEVICE_UNSUPPORTED'
  | 'DEVICE_KEY_CREATION_FAILED'
  | 'DEVICE_KEY_MISSING'
  | 'DEVICE_KEY_STATE_SPLIT'
  | 'DEVICE_SIGN_FAILED'
  | 'DEVICE_UNWRAP_FAILED'
  // 设备工具层
  | 'DEVICE_TOOL_ERROR'
  | 'DEVICE_TOOL_TIMEOUT'

export type LicenseErrorCode = LicenseDomainErrorCode | LicenseProtocolErrorCode

export class LicenseError extends Error {
  readonly code: LicenseErrorCode

  constructor(code: LicenseErrorCode, message: string) {
    super(message)
    this.name = 'LicenseError'
    this.code = code
  }
}
