/**
 * LicenseService：单机授权状态机与激活流程（方案 §3.2/§3.3）。
 *
 * 状态只允许 unlicensed / checking / active / locked。active 之前调用方
 * （main/index.ts）不得注册业务 IPC、媒体协议、外部接入，也不得打开项目数据库。
 *
 * 激活验证顺序：文件尺寸 → 严格 JSON → 信封结构 → 根验签发人证书（用途/有效期/
 * 能力）→ 签发人验签授权 → Schema（期限组合）→ 产品/设备绑定 → 时间窗 →
 * 序号回归检查 → 撤销检查 → 本机私钥持有验证 → 原子替换存储。任一步失败都
 * 保留原有授权文件不动。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import {
  canonicalBytes,
  ChallengePayloadSchema,
  decodeBase64Url,
  DeviceProofSchema,
  DeviceRequestSchema,
  FILE_SIZE_LIMITS,
  IssuerCertPayloadSchema,
  kidFromSpki,
  LICENSE_PRODUCT,
  LicensePayloadSchema,
  LICENSE_PROTOCOL_VERSION,
  LicenseProtocolError,
  parseFileJson,
  parseStrictJson,
  RevocationPolicyPayloadSchema,
  rsaPssSha256Verify,
  verifyEnvelope,
  verifyWithPurpose,
  type DeviceRequest,
  type Envelope,
  type IssuerCertPayload,
  type JsonValue,
  type LicenseCapability,
  type LicensePayload,
  type TrustedRoot
} from '@free-creation/license-protocol'
import type { DeviceKeyAdapter } from './device/adapter.ts'
import { LicenseError, type LicenseErrorCode } from './errors.ts'
import {
  licenseActivationLog,
  licenseCheckLog,
  licensePolicyLog,
  licenseRequestLog
} from './log.ts'
import { LicenseStore, type StoredLicenseFile } from './store.ts'

export type LicenseStateName = 'unlicensed' | 'checking' | 'active' | 'locked'

export interface LicenseSnapshot {
  state: LicenseStateName
  licenseId: string | null
  sequence: number | null
  term: 'days' | 'permanent' | null
  /** days 授权的到期 UTC 秒；permanent 与未授权为 null。 */
  expiresAt: number | null
  capabilities: LicenseCapability[]
  deviceSummary: string | null
  reasonCode: LicenseErrorCode | null
  /** 面向授权窗的简短诊断（不含密钥材料与文件内容）。 */
  message: string
}

/** 时钟回拨容忍（秒）：只识别显著回拨，普通 NTP 微调不受影响。 */
const ROLLBACK_TOLERANCE_SEC = 300

/** 本机持有验证消息前缀。 */
const HOLD_CHECK_PURPOSE = 'CS/license-hold/v1'

export interface LicenseServiceDeps {
  root: TrustedRoot
  adapter: DeviceKeyAdapter
  /** 授权存储目录（与项目数据分离）。 */
  storageDir: string
  now?: () => number
}

interface VerifiedLicenseChain {
  license: LicensePayload
  licenseEnvelope: Envelope
  cert: IssuerCertPayload
  certEnvelope: Envelope
}

function snapshotOf(partial: Partial<LicenseSnapshot> & { state: LicenseStateName }): LicenseSnapshot {
  return {
    licenseId: null,
    sequence: null,
    term: null,
    expiresAt: null,
    capabilities: [],
    deviceSummary: null,
    reasonCode: null,
    message: '',
    ...partial
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class LicenseService {
  private current: LicenseSnapshot
  private readonly now: () => number
  private readonly store: LicenseStore

  constructor(private readonly deps: LicenseServiceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
    this.current = snapshotOf({ state: 'unlicensed', message: '尚未导入授权' })
    mkdirSync(deps.storageDir, { recursive: true })
    this.store = new LicenseStore(deps.storageDir)
  }

  get snapshot(): LicenseSnapshot {
    return this.current
  }

  /** 供密钥包服务读取当前生效授权与签发人证书信封（不含任何明文密钥材料）。 */
  async getStoredLicenseEnvelopes(): Promise<{ license: Envelope; issuerCert: Envelope } | null> {
    const stored = await this.store.readStoredLicense()
    if (!stored) return null
    return { license: stored.license, issuerCert: stored.issuerCert }
  }

  // ---------------------------------------------------------------------------
  // 设备申请
  // ---------------------------------------------------------------------------

  /** 探测设备（授权窗展示用）。 */
  async probeDevice(): Promise<{ available: boolean; detail: string; keySource: string }> {
    try {
      const probe = await this.deps.adapter.probe()
      return { available: probe.available, detail: probe.detail, keySource: this.deps.adapter.keySource }
    } catch (error) {
      return {
        available: false,
        detail: String((error as Error).message).slice(0, 200),
        keySource: this.deps.adapter.keySource
      }
    }
  }

  /** 创建（或复用）设备密钥并导出 .csreq 内容。 */
  async createDeviceRequest(): Promise<{ requestText: string; deviceSummary: string; requestId: string }> {
    const startedAt = Date.now()
    try {
      await this.deps.adapter.createDeviceKeys()
      const device = await this.deps.adapter.readPublicKeys()
      const nowSec = this.now()
      const request: DeviceRequest = DeviceRequestSchema.parse({
        v: LICENSE_PROTOCOL_VERSION,
        product: LICENSE_PRODUCT,
        requestId: randomUUID(),
        createdAt: nowSec,
        device
      })
      const requestText = canonicalBytes(request as unknown as JsonValue).toString('utf8')
      const requestSha256 = sha256Hex(canonicalBytes(request as unknown as JsonValue))
      await this.store.writePendingRequest({
        version: 1,
        requestId: request.requestId,
        requestText,
        requestSha256,
        deviceSummary: device.deviceSummary,
        createdAtUtcSec: nowSec
      })
      licenseRequestLog('export-request', 'success', null)
      void startedAt
      return { requestText, deviceSummary: device.deviceSummary, requestId: request.requestId }
    } catch (error) {
      licenseRequestLog('export-request', 'failed', reasonCodeOf(error))
      throw error
    }
  }

  // ---------------------------------------------------------------------------
  // 挑战导入 → 设备证明导出
  // ---------------------------------------------------------------------------

  /**
   * 导入 .cschallenge：验证签发人链与挑战绑定，执行设备解封装证明，
   * 返回 .csproof 内容（文本）。
   */
  async importChallenge(challengeFileText: string): Promise<{ proofText: string; deviceSummary: string }> {
    const startedAt = Date.now()
    try {
      const pending = await this.store.readPendingRequest()
      if (!pending) {
        throw new LicenseError('ACTIVATION_CHALLENGE_MISMATCH', '本机尚未导出设备申请，无法处理挑战')
      }

      // 1. 证书链：文件携带签发人证书信封。
      const parsedFile = parseFileJson(challengeFileText, FILE_SIZE_LIMITS.challenge, '挑战文件')
      const certEnvelope = asEnvelope(parsedFile.issuerCert, '签发人证书')
      const cert = verifyEnvelope({
        envelope: certEnvelope,
        purpose: 'issuerCert',
        schema: IssuerCertPayloadSchema,
        signerPublicKey: this.deps.root.publicKey,
        maxPayloadBytes: FILE_SIZE_LIMITS.license,
        label: '签发人证书'
      })
      if (certEnvelope.kid !== this.deps.root.kid) {
        throw new LicenseError('KID_MISMATCH', '签发人证书不是由受信根签署')
      }
      const nowSec = this.now()
      if (nowSec < cert.notBefore || nowSec > cert.notAfter) {
        throw new LicenseError('CERT_EXPIRED', '签发人证书不在有效期内')
      }
      if (!cert.capabilities.includes('challenge.issue')) {
        throw new LicenseError('CERT_CAPABILITY_MISSING', '签发人证书缺少 challenge.issue 能力')
      }

      // 2. 挑战信封：签发人签名。
      const challengeEnvelope = asEnvelope(parsedFile.challenge, '挑战')
      const challenge = verifyEnvelope({
        envelope: challengeEnvelope,
        purpose: 'challenge',
        schema: ChallengePayloadSchema,
        signerPublicKey: cert.publicKey,
        maxPayloadBytes: FILE_SIZE_LIMITS.challenge,
        label: '挑战'
      })

      // 3. 挑战必须绑定本机导出的申请（摘要 + 期限）。
      const requestSha256 = sha256Hex(Buffer.from(pending.requestText, 'utf8'))
      if (challenge.requestSha256 !== requestSha256) {
        throw new LicenseError('ACTIVATION_CHALLENGE_MISMATCH', '挑战与本机申请不匹配')
      }
      if (nowSec >= challenge.expiresAt) {
        throw new LicenseError('ACTIVATION_CHALLENGE_MISMATCH', '挑战已过期，请重新申请')
      }

      // 4. 设备证明：解封装 + 双密钥持有。
      const device = await this.deps.adapter.readPublicKeys()
      const attestation = await this.deps.adapter.attestChallenge({
        challengeId: challenge.challengeId,
        nonceBase64Url: challenge.nonce,
        wrappedSecretBase64Url: challenge.wrappedSecret
      })

      const proof = DeviceProofSchema.parse({
        v: LICENSE_PROTOCOL_VERSION,
        product: LICENSE_PRODUCT,
        requestId: pending.requestId,
        challengeId: challenge.challengeId,
        requestSha256,
        secretHmac: attestation.secretHmac,
        challengeSignature: attestation.challengeSignature,
        device,
        createdAt: nowSec
      })
      const proofText = canonicalBytes(proof as unknown as JsonValue).toString('utf8')
      licenseRequestLog('challenge-import', 'success', null)
      void startedAt
      return { proofText, deviceSummary: device.deviceSummary }
    } catch (error) {
      licenseRequestLog('challenge-import', 'failed', reasonCodeOf(error))
      throw error
    }
  }

  // ---------------------------------------------------------------------------
  // 授权导入（激活）
  // ---------------------------------------------------------------------------

  /** 导入 .cslicense 并激活。任何一步失败都保留原有授权文件不动。 */
  async importLicense(licenseFileText: string): Promise<LicenseSnapshot> {
    const startedAt = Date.now()
    try {
      const chain = this.verifyLicenseFileText(licenseFileText)
      const nowSec = this.now()

      // 替换前的完整可用性检查：设备绑定、时间窗、撤销、序号、本机持有验证。
      const state = await this.store.readState(nowSec)
      if (chain.license.sequence < state.maxSequenceSeen) {
        throw new LicenseError('LICENSE_SEQUENCE_REGRESSED', '授权序号低于历史记录，疑似旧文件覆盖')
      }
      const blocked = await this.checkLicenseUsable(chain.license, chain.cert, nowSec)
      if (blocked !== null) {
        throw new LicenseError(blocked.reasonCode ?? 'LICENSE_INVALID', blocked.message)
      }

      await this.store.writeStoredLicense({
        version: 1,
        license: chain.licenseEnvelope,
        issuerCert: chain.certEnvelope,
        storedAtUtcSec: nowSec
      })
      await this.store.updateState(nowSec, (current) => ({
        ...current,
        maxSequenceSeen: Math.max(current.maxSequenceSeen, chain.license.sequence),
        lastAcceptedUtcSec: nowSec
      }))
      await this.store.clearPendingRequest()
      const snapshot = await this.evaluateOnBoot('activation')
      licenseActivationLog('success', null, Date.now() - startedAt)
      return snapshot
    } catch (error) {
      licenseActivationLog('failed', reasonCodeOf(error), Date.now() - startedAt)
      if (error instanceof LicenseProtocolIssue) {
        throw error.toLicenseError()
      }
      throw error
    }
  }

  // ---------------------------------------------------------------------------
  // 撤销策略导入
  // ---------------------------------------------------------------------------

  /** 导入 .cspolicy。只接受比已应用序号更大的策略。 */
  async importRevocationPolicy(policyFileText: string): Promise<{ applied: boolean; sequence: number }> {
    const parsedFile = parseFileJson(policyFileText, FILE_SIZE_LIMITS.policy, '策略文件')
    const certEnvelope = parsedFile.issuerCert ? asEnvelope(parsedFile.issuerCert, '签发人证书') : null
    const policyEnvelope = asEnvelope(parsedFile.policy, '策略')
    const nowSec = this.now()

    let signerPublicKey: string
    if (policyEnvelope.kid === this.deps.root.kid) {
      signerPublicKey = this.deps.root.publicKey
    } else {
      if (!certEnvelope) {
        throw new LicenseError('CERT_CHAIN_INVALID', '策略由签发人签署但未携带证书')
      }
      const cert = verifyEnvelope({
        envelope: certEnvelope,
        purpose: 'issuerCert',
        schema: IssuerCertPayloadSchema,
        signerPublicKey: this.deps.root.publicKey,
        maxPayloadBytes: FILE_SIZE_LIMITS.license,
        label: '签发人证书'
      })
      if (!cert.capabilities.includes('revocation.issue')) {
        throw new LicenseError('CERT_CAPABILITY_MISSING', '签发人证书缺少 revocation.issue 能力')
      }
      if (nowSec < cert.notBefore || nowSec > cert.notAfter) {
        throw new LicenseError('CERT_EXPIRED', '签发人证书不在有效期内')
      }
      signerPublicKey = cert.publicKey
    }

    const policy = verifyEnvelope({
      envelope: policyEnvelope,
      purpose: 'revocation',
      schema: RevocationPolicyPayloadSchema,
      signerPublicKey,
      maxPayloadBytes: FILE_SIZE_LIMITS.policy,
      label: '撤销策略'
    })

    const state = await this.store.readState(nowSec)
    if (policy.sequence <= state.appliedPolicySequence) {
      licensePolicyLog(false, policy.sequence, 'POLICY_SEQUENCE_REGRESSED')
      return { applied: false, sequence: policy.sequence }
    }

    await this.store.updateState(nowSec, (current) => ({
      ...current,
      appliedPolicySequence: policy.sequence,
      revokedLicenseIds: union(current.revokedLicenseIds, policy.revokedLicenseIds),
      revokedIssuerCertIds: union(current.revokedIssuerCertIds, policy.revokedIssuerCertIds)
    }))
    licensePolicyLog(true, policy.sequence, null)

    // 策略生效后立即复验当前授权是否已被撤销。
    await this.evaluateOnBoot('policy-applied')
    return { applied: true, sequence: policy.sequence }
  }

  // ---------------------------------------------------------------------------
  // 启动评估与复验
  // ---------------------------------------------------------------------------

  /** 冷启动/恢复后的完整复验。结果写入内存快照并返回。 */
  async evaluateOnBoot(trigger: string = 'boot'): Promise<LicenseSnapshot> {
    const log = licenseCheckLog(trigger)
    const nowSec = this.now()
    try {
      const stored = await this.store.readStoredLicense()
      if (!stored) {
        this.current = snapshotOf({ state: 'unlicensed', message: '尚未导入授权' })
        log.completed('unlicensed', null)
        return this.current
      }
      const snapshot = await this.verifyStoredLicense(stored, nowSec)
      this.current = snapshot
      if (snapshot.state === 'active') {
        await this.store.updateState(nowSec, (state) => ({
          ...state,
          maxSequenceSeen: Math.max(state.maxSequenceSeen, snapshot.sequence ?? 0),
          lastAcceptedUtcSec: nowSec
        }))
      }
      log.completed(snapshot.state, snapshot.reasonCode)
      return snapshot
    } catch (error) {
      const code = reasonCodeOf(error)
      this.current = snapshotOf({
        state: 'locked',
        reasonCode: 'LICENSE_INVALID',
        message: `授权校验异常：${code}`
      })
      log.failed(code)
      return this.current
    }
  }

  /**
   * 敏感操作前的授权断言（模型调用、密钥读写、导入导出、Agent 接入）。
   * 基于内存快照 + 便宜的到期检查；设备签名复验由 evaluateOnBoot 负责。
   */
  assertActive(operation: string): void {
    const snapshot = this.current
    if (snapshot.state !== 'active') {
      throw new LicenseError('LICENSE_REQUIRED', `操作 ${operation} 被拒绝：授权状态为 ${snapshot.state}`)
    }
    if (snapshot.term === 'days' && snapshot.expiresAt !== null && this.now() >= snapshot.expiresAt) {
      // 到期瞬间之后拒绝并转入锁定，等待下一次 evaluateOnBoot 更新展示。
      this.current = snapshotOf({
        state: 'locked',
        licenseId: snapshot.licenseId,
        sequence: snapshot.sequence,
        term: snapshot.term,
        expiresAt: snapshot.expiresAt,
        deviceSummary: snapshot.deviceSummary,
        reasonCode: 'LICENSE_EXPIRED',
        message: '按天授权已到期，请导入续期授权'
      })
      throw new LicenseError('LICENSE_REQUIRED', `操作 ${operation} 被拒绝：授权已过期`)
    }
  }

  // ---------------------------------------------------------------------------
  // 内部：文件验证
  // ---------------------------------------------------------------------------

  /** 验证 .cslicense 文本（含签发人证书），返回已验证的链。 */
  private verifyLicenseFileText(licenseFileText: string): VerifiedLicenseChain {
    const parsedFile = parseFileJson(licenseFileText, FILE_SIZE_LIMITS.license, '授权文件')
    const certEnvelope = asEnvelope(parsedFile.issuerCert, '签发人证书')
    const licenseEnvelope = asEnvelope(parsedFile.license, '授权')

    // 1. 根 → 签发人证书。
    if (certEnvelope.kid !== this.deps.root.kid) {
      throw new LicenseProtocolIssue('CERT_CHAIN_INVALID', '签发人证书不是由受信根签署')
    }
    const cert = this.parseOrIssue(IssuerCertPayloadSchema.safeParse(decodePayload(certEnvelope.payload)))
    if (
      !verifyWithPurpose({
        purpose: 'issuerCert',
        kid: certEnvelope.kid,
        publicKey: this.deps.root.publicKey,
        payloadBytes: decodeBase64Url(certEnvelope.payload),
        sig: certEnvelope.sig
      })
    ) {
      throw new LicenseProtocolIssue('SIGNATURE_INVALID', '签发人证书签名验证失败')
    }

    // 2. 签发人 → 授权。证书必须覆盖授权签发时间；证书能力必须含 license.issue。
    if (!cert.capabilities.includes('license.issue')) {
      throw new LicenseProtocolIssue('CERT_CAPABILITY_MISSING', '签发人证书缺少 license.issue 能力')
    }
    const license = this.parseOrIssue(LicensePayloadSchema.safeParse(decodePayload(licenseEnvelope.payload)))
    if (license.issuedAt < cert.notBefore || license.issuedAt > cert.notAfter) {
      throw new LicenseProtocolIssue('CERT_EXPIRED', '签发人证书未覆盖授权签发时间')
    }
    if (
      !verifyWithPurpose({
        purpose: 'license',
        kid: licenseEnvelope.kid,
        publicKey: cert.publicKey,
        payloadBytes: decodeBase64Url(licenseEnvelope.payload),
        sig: licenseEnvelope.sig
      })
    ) {
      throw new LicenseProtocolIssue('SIGNATURE_INVALID', '授权签名验证失败')
    }
    if (licenseEnvelope.kid !== kidFromSpki(decodeBase64Url(cert.publicKey))) {
      throw new LicenseProtocolIssue('KID_MISMATCH', '授权 kid 与证书公钥不一致')
    }

    // 3. 语义：产品、期限组合、设备绑定、序号。
    if (license.product !== LICENSE_PRODUCT) {
      throw new LicenseProtocolIssue('PRODUCT_MISMATCH', '授权产品不匹配')
    }
    if (license.term === 'days') {
      if (license.expiresAt === null || license.expiresAt <= license.notBefore) {
        throw new LicenseProtocolIssue('TERM_INVALID', '按天授权缺少合法到期时间')
      }
    } else if (license.expiresAt !== null) {
      throw new LicenseProtocolIssue('TERM_INVALID', '永久授权不得携带到期时间')
    }

    return { license, licenseEnvelope, cert, certEnvelope }
  }

  /** 对已存储授权做完整复验（启动/策略变更后）。 */
  private async verifyStoredLicense(stored: StoredLicenseFile, nowSec: number): Promise<LicenseSnapshot> {
    const device = await this.deps.adapter.readPublicKeys()
    const base = { deviceSummary: device.deviceSummary }

    let license: LicensePayload
    let cert: IssuerCertPayload
    try {
      const chain = this.verifyLicenseFileText(JSON.stringify({ license: stored.license, issuerCert: stored.issuerCert }))
      license = chain.license
      cert = chain.cert
    } catch (error) {
      return snapshotOf({
        state: 'locked',
        ...base,
        reasonCode: error instanceof LicenseProtocolIssue ? error.code : 'LICENSE_INVALID',
        message: '已存储授权验证失败，请导入新授权'
      })
    }

    // 序号回归（旧文件覆盖检测）。
    const state = await this.store.readState(nowSec)
    if (license.sequence < state.maxSequenceSeen) {
      return snapshotOf({
        state: 'locked',
        licenseId: license.licenseId,
        sequence: license.sequence,
        ...base,
        reasonCode: 'LICENSE_SEQUENCE_REGRESSED',
        message: '授权序号低于历史记录，疑似旧文件覆盖'
      })
    }

    const blocked = await this.checkLicenseUsable(license, cert, nowSec)
    if (blocked !== null) return blocked

    return snapshotOf({
      state: 'active',
      licenseId: license.licenseId,
      sequence: license.sequence,
      term: license.term,
      expiresAt: license.expiresAt,
      capabilities: license.capabilities as LicenseCapability[],
      ...base,
      reasonCode: null,
      message: license.term === 'permanent' ? '永久授权生效中' : '按天授权生效中'
    })
  }

  /**
   * 授权可用性检查：撤销 → 设备绑定 → 时间窗 → 时钟回拨 → 本机持有验证。
   * 返回 null 表示可用；否则返回锁定快照（importLicense 与启动复验共用）。
   */
  private async checkLicenseUsable(
    license: LicensePayload,
    cert: IssuerCertPayload,
    nowSec: number
  ): Promise<LicenseSnapshot | null> {
    const device = await this.deps.adapter.readPublicKeys()
    const base = { deviceSummary: device.deviceSummary }
    const state = await this.store.readState(nowSec)

    if (state.revokedIssuerCertIds.includes(cert.certId)) {
      return snapshotOf({
        state: 'locked',
        licenseId: license.licenseId,
        ...base,
        reasonCode: 'LICENSE_REVOKED',
        message: '签发人证书已被撤销'
      })
    }
    if (state.revokedLicenseIds.includes(license.licenseId)) {
      return snapshotOf({
        state: 'locked',
        licenseId: license.licenseId,
        ...base,
        reasonCode: 'LICENSE_REVOKED',
        message: '授权已被撤销'
      })
    }

    // 设备绑定：授权必须绑定本机两把设备公钥。
    const localSignKid = kidFromSpki(decodeBase64Url(device.signPublicKey))
    const localWrapKid = kidFromSpki(decodeBase64Url(device.wrapPublicKey))
    if (license.signKeyId !== localSignKid || license.wrapKeyId !== localWrapKid) {
      return snapshotOf({
        state: 'locked',
        licenseId: license.licenseId,
        sequence: license.sequence,
        ...base,
        reasonCode: 'LICENSE_DEVICE_MISMATCH',
        message: '授权绑定的是其他设备'
      })
    }

    // 时间窗与时钟回拨。
    if (nowSec < license.notBefore) {
      return snapshotOf({
        state: 'locked',
        licenseId: license.licenseId,
        sequence: license.sequence,
        term: license.term,
        expiresAt: license.expiresAt,
        ...base,
        reasonCode: 'LICENSE_TIME_AMBIGUOUS',
        message: '授权尚未生效（系统时间早于签发时间）'
      })
    }
    if (license.expiresAt !== null && nowSec >= license.expiresAt) {
      return snapshotOf({
        state: 'locked',
        licenseId: license.licenseId,
        sequence: license.sequence,
        term: license.term,
        expiresAt: license.expiresAt,
        ...base,
        reasonCode: 'LICENSE_EXPIRED',
        message: '按天授权已到期，请导入续期授权'
      })
    }
    if (state.lastAcceptedUtcSec !== null && nowSec + ROLLBACK_TOLERANCE_SEC < state.lastAcceptedUtcSec) {
      return snapshotOf({
        state: 'locked',
        licenseId: license.licenseId,
        sequence: license.sequence,
        term: license.term,
        expiresAt: license.expiresAt,
        ...base,
        reasonCode: 'LICENSE_TIME_AMBIGUOUS',
        message: '检测到系统时间明显回拨，请校准时间后重试'
      })
    }

    // 本机私钥持有验证。
    const holdMessage = Buffer.concat([
      Buffer.from(HOLD_CHECK_PURPOSE, 'utf8'),
      Buffer.from([0x00]),
      Buffer.from(license.licenseId, 'utf8')
    ])
    try {
      const signature = await this.deps.adapter.sign(holdMessage)
      if (!rsaPssSha256Verify({ signPublicKey: device.signPublicKey, message: holdMessage, sig: signature })) {
        throw new LicenseError('DEVICE_SIGN_FAILED', '持有验证签名无效')
      }
    } catch (error) {
      return snapshotOf({
        state: 'locked',
        licenseId: license.licenseId,
        sequence: license.sequence,
        term: license.term,
        expiresAt: license.expiresAt,
        ...base,
        reasonCode: error instanceof LicenseError ? error.code : 'DEVICE_SIGN_FAILED',
        message:
          error instanceof LicenseError && error.code === 'DEVICE_KEY_MISSING'
            ? '设备密钥不可用（可能已重装系统或清除 TPM），需要重新登记'
            : '设备密钥持有验证失败，请重试或重新登记'
      })
    }
    return null
  }

  private parseOrIssue<T>(result: { success: true; data: T } | { success: false; error: unknown }): T {
    if (result.success) return result.data
    throw new LicenseProtocolIssue('SCHEMA_INVALID', '文件字段不符合协议 Schema')
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function asEnvelope(value: unknown, label: string): Envelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LicenseProtocolIssue('SCHEMA_INVALID', `${label}缺少信封`)
  }
  return value as Envelope
}

function decodePayload(payloadB64Url: string): JsonValue {
  const bytes = decodeBase64Url(payloadB64Url)
  return parseStrictJson(bytes.toString('utf8'))
}

function union<T>(a: T[], b: T[]): T[] {
  return Array.from(new Set([...a, ...b]))
}

function reasonCodeOf(error: unknown): string {
  if (error instanceof LicenseError) return error.code
  if (error instanceof LicenseProtocolIssue) return error.code
  if (error instanceof LicenseProtocolError) return error.code
  const name = (error as { name?: string } | null)?.name
  if (name === 'ZodError') return 'SCHEMA_INVALID'
  return 'UNKNOWN'
}

/** 内部携带协议码的异常，激活失败时转换成 LicenseError。 */
class LicenseProtocolIssue extends Error {
  constructor(
    readonly code: LicenseErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'LicenseProtocolIssue'
  }
  toLicenseError(): LicenseError {
    return new LicenseError(this.code, this.message)
  }
}
