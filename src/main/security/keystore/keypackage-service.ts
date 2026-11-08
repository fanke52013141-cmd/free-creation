/**
 * 密钥包服务（方案 §4.1/§4.2 的主进程编排）。
 *
 * 三步流：
 * 1. exportReceiveCredential：接收设备导出 .csdevcred（有效授权信封 + K_wrap 公钥 + 设备摘要）；
 * 2. sealKeyPackageForRecipient：发放员（credentials.export 能力）选连接 + 密码 +
 *    接收凭证 → .cskeys；全程不向 renderer 返回明文 Key；
 * 3. openKeyPackagePreview / applyKeyPackageImport：接收端验签/解密 → 预览 →
 *    连接与 vault 密钥逐条原子写入 → 模型定义与导入记录在单事务内落库。
 *
 * 错误提示不区分「错密码」与「错设备」（协议层统一 SIGNATURE_INVALID）。
 */
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  kidFromSpki,
  openKeyPackage,
  parseFileJson,
  ReceiveDeviceCredentialSchema,
  FILE_SIZE_LIMITS,
  IssuerCertPayloadSchema,
  LicensePayloadSchema,
  sealKeyPackage,
  verifyEnvelope,
  type Envelope,
  type KeyPackagePayload,
  type TrustedRoot
} from '../../../../packages/license-protocol/src/index.ts'
import type { SqliteModelHost } from '../../model-host/sqlite-model-host'
import { assertLicenseActive } from '../license/gate'
import type { LicenseService } from '../license/service'
import type { SecretVault } from './vault'

export interface ConnectionPreview {
  id: string
  name: string
  protocol: string
  baseUrl: string
  modelCount: number
  hasKey: boolean
}

export interface KeyPackageDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
  /** better-sqlite3 语义：transaction(fn) 返回事务函数，需再调用一次才执行。 */
  transaction<T>(fn: () => T): () => T
}

interface StoredEnvelopes {
  license: Envelope
  issuerCert: Envelope
}

export class KeyPackageService {
  constructor(
    private readonly deps: {
      license: LicenseService
      vault: SecretVault
      host: SqliteModelHost
      database: () => KeyPackageDatabase
      trustedRoot: TrustedRoot
      /** 设备签名（K_sign 在 TPM 内），如 adapter.sign。 */
      signFn: (message: Uint8Array) => Promise<string>
      /** 设备解封装（K_wrap 在 TPM 内），如 adapter.unwrap。 */
      unwrapFn: (wrapped: Uint8Array) => Promise<Buffer>
      /** 本机设备公钥材料。 */
      deviceKeys: () => Promise<{ wrapPublicKey: string; signPublicKey: string; deviceSummary: string }>
    }
  ) {}

  // ------------------------------------------------------------------
  // 1. 接收设备凭证（.csdevcred）
  // ------------------------------------------------------------------

  async exportReceiveCredential(): Promise<{
    credentialText: string
    deviceSummary: string
    expiresAt: number | null
  }> {
    assertLicenseActive('keys.credential.export')
    const stored = await this.requireStoredEnvelopes()
    const device = await this.deps.deviceKeys()
    const credential = {
      v: 1,
      product: 'com.canvas-studio.app',
      license: stored.license,
      issuerCert: stored.issuerCert,
      wrapPublicKey: device.wrapPublicKey,
      deviceSummary: device.deviceSummary,
      exportedAt: Math.floor(Date.now() / 1000)
    }
    return {
      credentialText: JSON.stringify(credential, null, 2),
      deviceSummary: device.deviceSummary,
      expiresAt: this.deps.license.snapshot.expiresAt
    }
  }

  // ------------------------------------------------------------------
  // 2. 发放（.cskeys 导出；仅 credentials.export）
  // ------------------------------------------------------------------

  /** 发放对话框的多选列表（无明文 Key）。 */
  async listExportableConnections(): Promise<ConnectionPreview[]> {
    assertLicenseActive('keys.package.seal')
    this.requireExportCapability()
    return this.deps.host.listConnections().map((connection) => ({
      id: connection.id,
      name: connection.name,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      modelCount: this.deps.host.listModels(connection.id).length,
      hasKey: this.deps.vault.hasSecret('connection', connection.id) || this.hasLegacySecretRef(connection.id)
    }))
  }

  async sealKeyPackageForRecipient(input: {
    password: string
    recipientCredentialText: string
    connectionIds: string[]
  }): Promise<{ packageText: string; packageId: string; expiresAt: number; connectionCount: number }> {
    assertLicenseActive('keys.package.seal')
    this.requireExportCapability()

    // 接收凭证全量校验（文件来源，不可信任）。
    const credentialJson = parseFileJson(input.recipientCredentialText, FILE_SIZE_LIMITS.license, '接收设备凭证')
    const credential = ReceiveDeviceCredentialSchema.parse(credentialJson)
    const cert = verifyEnvelope({
      envelope: credential.issuerCert,
      purpose: 'issuerCert',
      schema: IssuerCertPayloadSchema,
      signerPublicKey: this.deps.trustedRoot.publicKey,
      maxPayloadBytes: FILE_SIZE_LIMITS.license,
      label: '接收凭证证书'
    })
    const recipientLicense = verifyEnvelope({
      envelope: credential.license,
      purpose: 'license',
      schema: LicensePayloadSchema,
      signerPublicKey: cert.publicKey,
      maxPayloadBytes: FILE_SIZE_LIMITS.license,
      label: '接收凭证授权'
    })
    if (kidFromSpki(decodeBase64UrlStrict(credential.wrapPublicKey)) !== recipientLicense.wrapKeyId) {
      throw new Error('接收凭证的设备公钥与其授权不匹配')
    }
    const nowSec = Math.floor(Date.now() / 1000)
    if (recipientLicense.expiresAt !== null && nowSec >= recipientLicense.expiresAt) {
      throw new Error('接收设备授权已到期，请先续期再发放')
    }

    // 组装负载：所选连接（模型 + 密钥）；无 Key 的连接明确拒绝。
    const connections: KeyPackagePayload['connections'] = []
    for (const connectionId of input.connectionIds) {
      const connection = this.deps.host.listConnections().find((c) => c.id === connectionId)
      if (!connection) throw new Error(`连接不存在: ${connectionId}`)
      const plain = await this.deps.vault.readSecret('connection', connectionId)
      if (!plain) throw new Error(`连接「${connection.name}」没有可导出的密钥`)
      const models = this.deps.host.listModels(connectionId).map((model) => ({
        id: model.id,
        connectionId: model.connectionId,
        modelId: model.modelId,
        name: model.name,
        capabilities: model.capabilities,
        enabled: model.enabled
      }))
      connections.push({
        id: connection.id,
        name: connection.name,
        protocol: connection.protocol,
        baseUrl: connection.baseUrl,
        headers: connection.headers ?? {},
        apiKey: plain,
        modelsJson: JSON.stringify(models)
      })
    }
    if (connections.length === 0) throw new Error('请至少选择一个要发放的连接')

    const stored = await this.requireStoredEnvelopes()
    const issuerDevice = await this.deps.deviceKeys()
    const sealed = await sealKeyPackage({
      packageId: randomUUID(),
      recipient: { wrapPublicKey: credential.wrapPublicKey, deviceSummary: credential.deviceSummary },
      issuerDevice: { signPublicKey: issuerDevice.signPublicKey, deviceSummary: issuerDevice.deviceSummary },
      password: input.password,
      payload: { connections, exportedAt: nowSec },
      recipientLicenseExpiresAtSec: recipientLicense.expiresAt,
      nowSec,
      signFn: this.deps.signFn,
      licenseEnvelope: stored.license,
      issuerCertEnvelope: stored.issuerCert
    })
    return {
      packageText: sealed.fileText,
      packageId: sealed.packageId,
      expiresAt: sealed.expiresAt,
      connectionCount: connections.length
    }
  }

  // ------------------------------------------------------------------
  // 3. 导入
  // ------------------------------------------------------------------

  /** 解密并预览（不落库）。 */
  async openKeyPackagePreview(input: {
    packageText: string
    password: string
  }): Promise<{
    packageId: string
    expiresAt: number
    issuerDeviceSummary: string
    connections: ConnectionPreview[]
    alreadyImported: boolean
    existingConnections: string[]
  }> {
    assertLicenseActive('keys.package.import')
    const opened = await this.openVerified(input)
    const seen = this.deps.database().prepare('SELECT imported_at FROM key_imports WHERE package_id = ?').get(opened.packageId) as
      | { imported_at: number }
      | undefined
    const existingConnections = opened.payload.connections
      .filter((connection) => this.deps.host.listConnections().some((c) => c.id === connection.id))
      .map((connection) => connection.name)
    return {
      packageId: opened.packageId,
      expiresAt: opened.header.expiresAt,
      issuerDeviceSummary: opened.header.issuerDevice.deviceSummary,
      connections: opened.payload.connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        protocol: connection.protocol,
        baseUrl: connection.baseUrl,
        modelCount: (safeParseModels(connection.modelsJson) as unknown[]).length,
        hasKey: true
      })),
      alreadyImported: seen !== undefined,
      existingConnections
    }
  }

  /** 预览确认后落库。连接与 vault 密钥逐条原子写入；模型与导入记录单事务。 */
  async applyKeyPackageImport(input: {
    packageText: string
    password: string
    overwriteConfirmed: boolean
  }): Promise<{ packageId: string; added: number; updated: number; modelCount: number }> {
    const opened = await this.openVerified(input)
    const seen = this.deps.database().prepare('SELECT imported_at FROM key_imports WHERE package_id = ?').get(opened.packageId) as
      | { imported_at: number }
      | undefined
    if (seen && !input.overwriteConfirmed) {
      throw new Error('该密钥包此前已导入过；如需覆盖现有连接请显式确认')
    }
    const conflicting = opened.payload.connections.filter((connection) =>
      this.deps.host.listConnections().some((c) => c.id === connection.id)
    )
    if (conflicting.length > 0 && !input.overwriteConfirmed) {
      throw new Error(`以下连接已存在，覆盖需要显式确认：${conflicting.map((c) => c.name).join('、')}`)
    }

    let added = 0
    let updated = 0
    let modelCount = 0
    for (const connection of opened.payload.connections) {
      const exists = this.deps.host.listConnections().some((c) => c.id === connection.id)
      if (exists) updated += 1
      else added += 1
      // saveConnection 内部把新密钥写入 vault 并更新端点绑定（异步、幂等、单条原子）。
      await this.deps.host.saveConnection({
        id: connection.id,
        name: connection.name,
        protocol: connection.protocol as never,
        baseUrl: connection.baseUrl,
        headers: connection.headers,
        apiKey: connection.apiKey
      })
    }
    // 模型定义与导入记录：单事务（同步 SQLite）。
    this.deps.database().transaction(() => {
      for (const connection of opened.payload.connections) {
        const models = safeParseModels(connection.modelsJson) as Array<{
          id: string
          modelId: string
          name?: string
          capabilities: Array<{ operation: string; [key: string]: unknown }>
          enabled?: boolean
        }>
        for (const model of models) {
          this.deps.host.saveModel({
            id: model.id,
            connectionId: connection.id,
            modelId: model.modelId,
            name: model.name || model.modelId,
            capabilities: model.capabilities as never
          })
          modelCount += 1
        }
      }
      this.deps
        .database()
        .prepare('INSERT OR REPLACE INTO key_imports (package_id, imported_at, connection_ids) VALUES (?, ?, ?)')
        .run(opened.packageId, Date.now(), JSON.stringify(opened.payload.connections.map((c) => c.id)))
    })()
    return { packageId: opened.packageId, added, updated, modelCount }
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  private async openVerified(input: { packageText: string; password: string }): Promise<{
    packageId: string
    header: { expiresAt: number; issuerDevice: { deviceSummary: string } }
    payload: KeyPackagePayload
  }> {
    const device = await this.deps.deviceKeys()
    const snapshot = this.deps.license.snapshot
    const opened = await openKeyPackage({
      file: input.packageText,
      localWrapPublicKey: device.wrapPublicKey,
      localLicenseExpiresAtSec: snapshot.expiresAt,
      password: input.password,
      nowSec: Math.floor(Date.now() / 1000),
      trustedRoot: this.deps.trustedRoot,
      unwrapFn: this.deps.unwrapFn
    })
    return { packageId: opened.header.packageId, header: opened.header, payload: opened.payload }
  }

  private requireExportCapability(): void {
    const snapshot = this.deps.license.snapshot
    if (snapshot.state !== 'active' || !snapshot.capabilities.includes('credentials.export')) {
      throw new Error('当前授权不具备密钥发放能力（credentials.export）')
    }
  }

  private async requireStoredEnvelopes(): Promise<StoredEnvelopes> {
    const stored = await this.deps.license.getStoredLicenseEnvelopes()
    if (!stored) throw new Error('本机没有已存储的授权')
    return stored
  }

  private hasLegacySecretRef(connectionId: string): boolean {
    try {
      const row = this.deps.database().prepare('SELECT secret_ref FROM model_connections WHERE id = ?').get(connectionId) as
        | { secret_ref: string | null }
        | undefined
      return Boolean(row?.secret_ref)
    } catch {
      return false
    }
  }
}

function decodeBase64UrlStrict(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new Error('接收凭证公钥编码非法')
  return decoded
}

function safeParseModels(modelsJson: string): unknown {
  try {
    return JSON.parse(modelsJson)
  } catch {
    return []
  }
}
