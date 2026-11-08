/**
 * 设备绑定密钥库（方案 §4.3）。
 *
 * 每条密钥：随机内容密钥 AES-256-GCM 加密明文（AAD 绑定 kind/id/origin/source/scope），
 * 内容密钥再由本机 K_wrap 公钥 RSA-OAEP 封装——明文只在主进程发请求的短时窗口内存在，
 * 换设备/复制数据目录都无法解开。`readForRequest` 额外校验请求目标来源与绑定来源一致，
 * 阻止改地址外发。
 *
 * TPM 解封装约 300-600ms，而 `getProvider`/`readSecret` 是每请求路径（含视频轮询），
 * 因此内置 5 分钟 TTL 内存缓存；写/删/迁移/锁定/系统恢复时必须 clearMemo()。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { originOf, rsaOaepSha256Encrypt } from '../../../../packages/license-protocol/src/index.ts'
import type { DeviceKeyAdapter } from '../license/device/adapter'

export type VaultKind = 'provider' | 'connection'
export type VaultScope = 'app.run' | 'credentials.export'

const SECRET_MEMO_TTL_MS = 5 * 60 * 1000

/** vault 稳定原因码（对外诊断/日志可见，只能新增）。 */
export type VaultErrorCode = 'VAULT_ORIGIN_MISMATCH' | 'VAULT_DECRYPT_FAILED' | 'VAULT_MISSING'

export class VaultError extends Error {
  readonly code: VaultErrorCode
  constructor(code: VaultErrorCode, message: string) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

export interface VaultRow {
  kind: string
  id: string
  origin: string
  credential_source: string
  scope: string
  content_cipher: string
  content_nonce: string
  wrapped_ck: string
  updated_at: number
}

export interface VaultDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
}

export interface VaultWriteInput {
  kind: VaultKind
  id: string
  /** 绑定的请求来源（scheme://host[:port]），来自连接的 baseUrl。 */
  origin: string
  /** 凭据来源：'local'（本机录入）| 'cskeys-import' | 'migrated'。 */
  source: 'local' | 'cskeys-import' | 'migrated'
  scope: VaultScope
  plain: string
}

interface MemoEntry {
  plain: string
  expiresAt: number
}

function aadFor(kind: string, id: string, origin: string, source: string, scope: string): Buffer {
  // 固定字段顺序 + 前缀，防拼接歧义。
  return Buffer.from(`CS/vault/v1|${kind}|${id}|${origin}|${source}|${scope}`, 'utf8')
}

export class SecretVault {
  private memo = new Map<string, MemoEntry>()
  private wrapPublicKeyCache: string | null = null

  constructor(
    private readonly deps: {
      adapter: DeviceKeyAdapter
      /** 一般传 getDb；测试注入内存/临时库。 */
      database: () => VaultDatabase
    }
  ) {}

  // ------------------------------------------------------------------
  // 写入
  // ------------------------------------------------------------------

  async writeSecret(input: VaultWriteInput): Promise<void> {
    if (!input.plain) throw new VaultError('VAULT_DECRYPT_FAILED', 'vault 不接受空密钥')
    const wrapPublicKey = await this.requireWrapPublicKey()
    const contentKey = randomBytes(32)
    const nonce = randomBytes(12)
    const aad = aadFor(input.kind, input.id, input.origin, input.source, input.scope)
    const cipher = createCipheriv('aes-256-gcm', contentKey, nonce, { authTagLength: 16 })
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(input.plain, 'utf8')), cipher.final()])
    const tag = cipher.getAuthTag()
    const wrappedCk = rsaOaepSha256Encrypt({ wrapPublicKey, plaintext: contentKey })
    const database = this.deps.database()
    database
      .prepare(
        `INSERT INTO secret_vault (kind, id, origin, credential_source, scope, content_cipher, content_nonce, wrapped_ck, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET
           origin=excluded.origin, credential_source=excluded.credential_source, scope=excluded.scope,
           content_cipher=excluded.content_cipher, content_nonce=excluded.content_nonce,
           wrapped_ck=excluded.wrapped_ck, updated_at=excluded.updated_at`
      )
      .run(
        input.kind,
        input.id,
        input.origin,
        input.source,
        input.scope,
        Buffer.concat([ciphertext, tag]).toString('base64'),
        nonce.toString('base64'),
        wrappedCk.toString('base64'),
        Date.now()
      )
    this.setMemo(input.kind, input.id, input.plain)
  }

  async deleteSecret(kind: VaultKind, id: string): Promise<void> {
    this.deps.database().prepare('DELETE FROM secret_vault WHERE kind = ? AND id = ?').run(kind, id)
    this.memo.delete(memoKey(kind, id))
  }

  hasSecret(kind: VaultKind, id: string): boolean {
    const row = this.deps.database().prepare('SELECT id FROM secret_vault WHERE kind = ? AND id = ?').get(kind, id)
    return row !== undefined
  }

  /** 元数据读取（不触 TPM）：来源绑定与更新时间。 */
  getMeta(kind: VaultKind, id: string): { origin: string; source: string; scope: string; updatedAt: number } | null {
    const row = this.deps
      .database()
      .prepare('SELECT origin, credential_source, scope, updated_at FROM secret_vault WHERE kind = ? AND id = ?')
      .get(kind, id) as { origin: string; credential_source: string; scope: string; updated_at: number } | undefined
    if (!row) return null
    return { origin: row.origin, source: row.credential_source, scope: row.scope, updatedAt: row.updated_at }
  }

  // ------------------------------------------------------------------
  // 读取
  // ------------------------------------------------------------------

  /** 读取明文（无请求上下文；用于凭据哈希、导出预检等）。 */
  async readSecret(kind: VaultKind, id: string): Promise<string | null> {
    const memoHit = this.memo.get(memoKey(kind, id))
    if (memoHit && memoHit.expiresAt > Date.now()) return memoHit.plain

    const row = this.deps
      .database()
      .prepare('SELECT * FROM secret_vault WHERE kind = ? AND id = ?')
      .get(kind, id) as VaultRow | undefined
    if (!row) return null
    const plain = await this.decryptRow(row)
    this.setMemo(kind, id, plain)
    return plain
  }

  /**
   * 请求时读取：目标 URL 的来源必须与绑定来源一致，否则拒绝释放凭据
   * （阻止改地址/代理外发，方案 §4.3「只向匹配的允许来源发送鉴权头」）。
   */
  async readForRequest(kind: VaultKind, id: string, targetUrl: string): Promise<string | null> {
    const row = this.deps
      .database()
      .prepare('SELECT origin FROM secret_vault WHERE kind = ? AND id = ?')
      .get(kind, id) as { origin: string } | undefined
    if (!row) return null
    let requestOrigin: string
    try {
      requestOrigin = originOf(targetUrl)
    } catch {
      throw new VaultError('VAULT_ORIGIN_MISMATCH', `请求地址无法解析来源: ${targetUrl.slice(0, 32)}`)
    }
    if (requestOrigin !== row.origin) {
      throw new VaultError(
        'VAULT_ORIGIN_MISMATCH',
        `凭据绑定来源 ${row.origin}，请求目标 ${requestOrigin}，已拒绝释放`
      )
    }
    return this.readSecret(kind, id)
  }

  private async decryptRow(row: VaultRow): Promise<string> {
    try {
      const blob = Buffer.from(row.content_cipher, 'base64')
      const tag = blob.subarray(blob.length - 16)
      const ciphertext = blob.subarray(0, blob.length - 16)
      const nonce = Buffer.from(row.content_nonce, 'base64')
      const contentKey = await this.deps.adapter.unwrap(Buffer.from(row.wrapped_ck, 'base64'))
      const decipher = createDecipheriv('aes-256-gcm', contentKey, nonce, { authTagLength: 16 })
      decipher.setAAD(aadFor(row.kind, row.id, row.origin, row.credential_source, row.scope))
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      contentKey.fill(0)
      return plain.toString('utf8')
    } catch (error) {
      throw new VaultError(
        'VAULT_DECRYPT_FAILED',
        `密钥库解密失败（设备不匹配或数据损坏）: ${String((error as Error).message).slice(0, 80)}`
      )
    }
  }

  // ------------------------------------------------------------------
  // 缓存
  // ------------------------------------------------------------------

  private setMemo(kind: string, id: string, plain: string): void {
    this.memo.set(memoKey(kind, id), { plain, expiresAt: Date.now() + SECRET_MEMO_TTL_MS })
  }

  /** 写/删/迁移/授权锁定/系统恢复后必须调用（方案：短时使用，及时清理）。 */
  clearMemo(): void {
    this.memo.clear()
  }

  private async requireWrapPublicKey(): Promise<string> {
    if (this.wrapPublicKeyCache) return this.wrapPublicKeyCache
    const publicKeys = await this.deps.adapter.readPublicKeys()
    this.wrapPublicKeyCache = publicKeys.wrapPublicKey
    return publicKeys.wrapPublicKey
  }
}

function memoKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

/** 进程级单例（由 main/index.ts 在门禁通过后注入适配器；测试直接构造）。 */
let activeVault: SecretVault | null = null

export function setActiveVault(vault: SecretVault | null): void {
  activeVault = vault
}

export function getActiveVault(): SecretVault | null {
  return activeVault
}

/** 业务守卫接入点：vault 操作前置授权断言由调用方执行（model.secret.read/write）。 */
export async function vaultReadForRequest(kind: VaultKind, id: string, targetUrl: string): Promise<string | null> {
  if (!activeVault) return null
  return activeVault.readForRequest(kind, id, targetUrl)
}
