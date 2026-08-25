// 密钥加密工具（路线图 R7 / 发布与数据安全）
//
// 用 Electron safeStorage 对本地供应商 API Key 加密落盘，避免明文存储。
// 存储格式带前缀标记，兼容旧数据与 safeStorage 不可用的环境：
//   enc:<base64>   →  safeStorage 加密后的密文（推荐）
//   plain:<base64> →  safeStorage 不可用时的明文 base64（无加密能力时的降级）
//   裸值           →  旧版本明文（迁移兼容，读取时当作明文）
import { safeStorage } from 'electron'

const ENC_PREFIX = 'enc:'
const PLAIN_PREFIX = 'plain:'

/** 是否具备系统级加密能力（Windows DPAPI / macOS Keychain / Linux keyring）。 */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * 加密一段秘密并返回带前缀的存储串。safeStorage 可用时加密；否则降级为明文
 * base64（clear 标记），保证功能可用但不泄露系统密码库依赖。
 */
export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (encryptionAvailable()) {
    try {
      const buf = safeStorage.encryptString(plain)
      return `${ENC_PREFIX}${buf.toString('base64')}`
    } catch {
      // 加密失败降级，避免阻塞保存
    }
  }
  return `${PLAIN_PREFIX}${Buffer.from(plain, 'utf8').toString('base64')}`
}

/** 解密带前缀的存储串，还原原始秘密；无法解密时返回空串。 */
export function decryptSecret(stored: string | null): string {
  if (!stored) return ''
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
  // 旧版本裸明文：兼容读取
  return stored
}

/** 判断存储串是否为已加密的密文（用于日志/诊断脱敏）。 */
export function isEncryptedSecret(stored: string | null): boolean {
  return !!stored && stored.startsWith(ENC_PREFIX)
}
