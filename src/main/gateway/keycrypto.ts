/**
 * 密钥加密工具（路线图 R7 / P2 收口）。
 *
 * 存储格式带前缀标记：
 *   enc:<base64>   →  safeStorage 加密后的密文（本机 DPAPI 绑定）
 *   plain:<base64> →  历史降级数据（P2 起禁止新写入；读取仅为迁移兼容）
 *   裸值           →  更早版本的明文（读取仅为迁移兼容）
 *   vault:<kind>:<id> → P2 设备绑定密钥库引用（由 SecretVault 解密，本模块不处理）
 *
 * P2 变更（方案 §4.3「停用明文回退」）：safeStorage 不可用或加密失败时，
 * encryptSecret 直接抛错拒绝保存——绝不再静默降级为可复制明文。
 */
import { safeStorage } from 'electron'

const ENC_PREFIX = 'enc:'
const PLAIN_PREFIX = 'plain:'
export const VAULT_PREFIX = 'vault:'

/** 是否具备系统级加密能力（Windows DPAPI / macOS Keychain / Linux keyring）。 */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 加密一段秘密并返回带前缀的存储串。safeStorage 不可用或加密失败时抛错：
 * 调用方（保存路径）必须拒绝该次保存并保留原值，绝不落可复制明文。
 */
export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (!encryptionAvailable()) {
    throw new Error('SECRET_ENCRYPTION_UNAVAILABLE: 系统加密能力不可用，已拒绝保存密钥（明文回退已停用）')
  }
  try {
    const buf = safeStorage.encryptString(plain)
    return `${ENC_PREFIX}${buf.toString('base64')}`
  } catch (error) {
    throw new Error(`SECRET_ENCRYPTION_FAILED: ${String((error as Error).message).slice(0, 120)}`)
  }
}

/** 判断存储串是否为 vault 引用（由 SecretVault 解密，调用方不得交给 decryptSecret）。 */
export function isVaultRef(stored: string | null): boolean {
  return !!stored && stored.startsWith(VAULT_PREFIX)
}

/** 解析 vault 引用的 (kind, id)；非引用返回 null。 */
export function parseVaultRef(stored: string | null): { kind: 'provider' | 'connection'; id: string } | null {
  if (!stored || !stored.startsWith(VAULT_PREFIX)) return null
  const parts = stored.slice(VAULT_PREFIX.length).split(':')
  if (parts.length !== 2 || (parts[0] !== 'provider' && parts[0] !== 'connection') || !parts[1]) return null
  return { kind: parts[0], id: parts[1] }
}

/** 组装 vault 引用。 */
export function vaultRef(kind: 'provider' | 'connection', id: string): string {
  return `${VAULT_PREFIX}${kind}:${id}`
}

/**
 * 解密带前缀的存储串，还原原始秘密；无法解密时返回空串。
 * 注意：vault 引用不是本函数的输入——调用方必须先经 SecretVault。
 */
export function decryptSecret(stored: string | null): string {
  if (!stored) return ''
  if (isVaultRef(stored)) return ''
  if (stored.startsWith(ENC_PREFIX)) {
    // 只有当前具备解密能力时才能解；否则返回空（调用方提示重新输入密钥）。
    if (!encryptionAvailable()) return ''
    try {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      return ''
    }
  }
  if (stored.startsWith(PLAIN_PREFIX)) {
    try {
      return Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
    } catch {
      return ''
    }
  }
  // 旧版本裸明文：兼容读取（仅迁移路径应再遇到）
  return stored
}

/** 判断存储串是否为已加密的密文（用于日志/诊断脱敏）。 */
export function isEncryptedSecret(stored: string | null): boolean {
  return !!stored && stored.startsWith(ENC_PREFIX)
}
