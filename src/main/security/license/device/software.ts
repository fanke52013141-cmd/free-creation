/**
 * 软件设备适配器（仅限开发与测试）。
 *
 * 用 Node crypto 生成普通 RSA-2048 密钥并在文件中保存 PKCS#8 PEM，
 * 没有 TPM/PCP 的硬件绑定，也没有 EK。生产打包构建必须拒绝该适配器
 * （对应验收场景「替换公钥或用软件 TPM → 拒绝」）。
 *
 * 密钥文件写入 CANVAS_DATA_DIR/security/dev-device-keys.json，模式 0600。
 */
import { randomBytes, createPrivateKey, createPublicKey, sign as cryptoSign, privateDecrypt, constants, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Buffer } from 'node:buffer'
import {
  buildProofMessage,
  decodeBase64Url,
  deviceSummaryFromSpki,
  encodeBase64Url,
  hmacSha256,
  type DevicePublicKeys
} from '@free-creation/license-protocol'
import { LicenseError } from '../errors.ts'
import type { DeviceAttestationResult, DeviceKeyAdapter, DeviceProbeResult } from './adapter.ts'

interface StoredSoftwareKeys {
  version: 1
  warning: 'software-dev-only-not-protected'
  signPrivateKeyPem: string
  wrapPrivateKeyPem: string
}

export interface SoftwareAdapterOptions {
  /** dev-device-keys.json 的完整路径（一般是 <dataDir>/security/dev-device-keys.json）。 */
  keyStorePath: string
  /** 测试注入：true 时不落盘，密钥仅存于实例内存。 */
  inMemory?: boolean
}

function generateSoftwareKeyPair(): { spki: Buffer; pkcs8Pem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  return { spki: publicKey as Buffer, pkcs8Pem: privateKey as string }
}

export class SoftwareDeviceAdapter implements DeviceKeyAdapter {
  readonly keySource = 'software-dev' as const
  private signKeys: { spki: Buffer; pkcs8Pem: string } | null = null
  private wrapKeys: { spki: Buffer; pkcs8Pem: string } | null = null

  constructor(private readonly options: SoftwareAdapterOptions) {}

  async probe(): Promise<DeviceProbeResult> {
    if (this.signKeys && this.wrapKeys) {
      return { available: true, detail: '软件设备密钥已加载（内存）' }
    }
    if (!this.options.inMemory && existsSync(this.options.keyStorePath)) {
      return { available: true, detail: '软件设备密钥文件已存在（开发专用，无硬件绑定）' }
    }
    return { available: true, detail: '软件设备适配器可用（开发专用，无硬件绑定）' }
  }

  async createDeviceKeys(): Promise<void> {
    if (this.signKeys && this.wrapKeys) return
    if (!this.options.inMemory && existsSync(this.options.keyStorePath)) {
      // 幂等：已有密钥文件则加载。
      await this.loadFromDisk()
      return
    }
    this.signKeys = generateSoftwareKeyPair()
    this.wrapKeys = generateSoftwareKeyPair()
    if (!this.options.inMemory) {
      const payload: StoredSoftwareKeys = {
        version: 1,
        warning: 'software-dev-only-not-protected',
        signPrivateKeyPem: this.signKeys.pkcs8Pem,
        wrapPrivateKeyPem: this.wrapKeys.pkcs8Pem
      }
      await mkdir(dirname(this.options.keyStorePath), { recursive: true })
      await writeFile(this.options.keyStorePath, JSON.stringify(payload, null, 2), { mode: 0o600 })
      await chmod(this.options.keyStorePath, 0o600).catch(() => undefined)
    }
  }

  private async loadFromDisk(): Promise<void> {
    const raw = await readFile(this.options.keyStorePath, 'utf8')
    const parsed = JSON.parse(raw) as StoredSoftwareKeys
    if (parsed.version !== 1 || !parsed.signPrivateKeyPem || !parsed.wrapPrivateKeyPem) {
      throw new LicenseError('DEVICE_KEY_MISSING', '软件设备密钥文件结构非法')
    }
    this.signKeys = { spki: spkiOfPem(parsed.signPrivateKeyPem), pkcs8Pem: parsed.signPrivateKeyPem }
    this.wrapKeys = { spki: spkiOfPem(parsed.wrapPrivateKeyPem), pkcs8Pem: parsed.wrapPrivateKeyPem }
  }

  private requireKeys(): { signKeys: { spki: Buffer; pkcs8Pem: string }; wrapKeys: { spki: Buffer; pkcs8Pem: string } } {
    if (!this.signKeys || !this.wrapKeys) {
      throw new LicenseError('DEVICE_KEY_MISSING', '软件设备密钥尚未创建或加载')
    }
    return { signKeys: this.signKeys, wrapKeys: this.wrapKeys }
  }

  async readPublicKeys(): Promise<DevicePublicKeys> {
    const { signKeys, wrapKeys } = this.requireKeys()
    return {
      signPublicKey: encodeBase64Url(signKeys.spki),
      wrapPublicKey: encodeBase64Url(wrapKeys.spki),
      ekPublicKeyHash: null,
      keySource: this.keySource,
      deviceSummary: deviceSummaryFromSpki(signKeys.spki, wrapKeys.spki)
    }
  }

  async attestChallenge(input: {
    challengeId: string
    nonceBase64Url: string
    wrappedSecretBase64Url: string
  }): Promise<DeviceAttestationResult> {
    const { signKeys } = this.requireKeys()
    const secret = await this.unwrap(decodeBase64Url(input.wrappedSecretBase64Url))
    try {
      const hmacMessage = buildProofMessage('proofHmac', input.challengeId, input.nonceBase64Url)
      const mac = hmacSha256(secret, hmacMessage)
      const signature = cryptoSign('sha256', buildProofMessage('proofSign', input.challengeId, input.nonceBase64Url), {
        key: createPrivateKey(signKeys.pkcs8Pem),
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32
      })
      return { secretHmac: encodeBase64Url(mac), challengeSignature: encodeBase64Url(signature) }
    } finally {
      secret.fill(0)
    }
  }

  async sign(data: Uint8Array): Promise<string> {
    const { signKeys } = this.requireKeys()
    try {
      const signature = cryptoSign('sha256', Buffer.from(data), {
        key: createPrivateKey(signKeys.pkcs8Pem),
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32
      })
      return encodeBase64Url(signature)
    } catch (error) {
      throw new LicenseError('DEVICE_SIGN_FAILED', `软件设备签名失败: ${String((error as Error).message).slice(0, 120)}`)
    }
  }

  async unwrap(wrapped: Uint8Array): Promise<Buffer> {
    const { wrapKeys } = this.requireKeys()
    try {
      return privateDecrypt(
        { key: createPrivateKey(wrapKeys.pkcs8Pem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(wrapped)
      )
    } catch (error) {
      throw new LicenseError('DEVICE_UNWRAP_FAILED', `软件设备解封装失败: ${String((error as Error).message).slice(0, 120)}`)
    }
  }

  async destroyDeviceKeys(): Promise<void> {
    this.signKeys = null
    this.wrapKeys = null
    if (!this.options.inMemory) {
      await rm(this.options.keyStorePath, { force: true })
    }
  }
}

function spkiOfPem(pkcs8Pem: string): Buffer {
  const derivedPublic = createPublicKey(createPrivateKey(pkcs8Pem))
  return Buffer.from(derivedPublic.export({ format: 'der', type: 'spki' }))
}

/** 测试辅助：随机软件适配器（内存密钥，无磁盘）。 */
export function createInMemorySoftwareAdapter(): SoftwareDeviceAdapter {
  return new SoftwareDeviceAdapter({ keyStorePath: join('in-memory', `${randomBytes(6).toString('hex')}.json`), inMemory: true })
}
