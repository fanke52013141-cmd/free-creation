/**
 * 设备密钥适配器接口（方案 §3.4）。
 *
 * Windows 原生适配器只暴露六种操作；`sign` 与 `unwrap` 只允许授权服务和
 * 密钥库内部调用，preload 与 renderer 没有任何私钥操作通道。
 * 密钥丢失时进入重新登记流程，禁止在后台自动重建并继续运行。
 */
import type { DevicePublicKeys, KeySource } from '@free-creation/license-protocol'
import type { LicenseError } from '../errors.ts'

export interface DeviceProbeResult {
  available: boolean
  /** 简短诊断信息（面向授权窗展示，不含密钥材料）。 */
  detail: string
}

export interface DeviceAttestationResult {
  /** HMAC-SHA256(解封装秘密, proofHmac 消息)，证明 K_wrap 持有。 */
  secretHmac: string
  /** RSA-PSS K_sign 签名（proofSign 消息），证明 K_sign 持有。 */
  challengeSignature: string
}

export interface DeviceKeyAdapter {
  readonly keySource: KeySource

  /** 探测设备能力：TPM/PCP 是否可用、双密钥状态。不创建任何密钥。 */
  probe(): Promise<DeviceProbeResult>

  /** 创建设备双密钥。已齐全时为幂等 no-op；单边存在时必须报错（不自动补齐）。 */
  createDeviceKeys(): Promise<void>

  /** 读取两把公钥与 EK 摘要、设备摘要。密钥缺失时抛 DEVICE_KEY_MISSING。 */
  readPublicKeys(): Promise<DevicePublicKeys>

  /**
   * 解封装挑战并产出持有证明。只在激活流程中调用。
   * 适配器内部不得保留秘密明文的引用（用完即弃，不留缓存）。
   */
  attestChallenge(input: {
    challengeId: string
    nonceBase64Url: string
    wrappedSecretBase64Url: string
  }): Promise<DeviceAttestationResult>

  /** RSA-PSS/SHA-256 签名（授权激活后的本机持有验证用）。 */
  sign(data: Uint8Array): Promise<string>

  /** RSA-OAEP-SHA256 解封装（本机密钥库读取用）。 */
  unwrap(wrapped: Uint8Array): Promise<Buffer>

  /** 删除本机密钥（换机/重置流程显式调用；正常启动绝不调用）。 */
  destroyDeviceKeys(): Promise<void>
}

export type DeviceAdapterResult<T> = { ok: true; value: T } | { ok: false; error: LicenseError }
