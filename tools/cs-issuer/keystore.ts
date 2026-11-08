/**
 * 密钥保管：根 / 签发人私钥文件（0600）。
 *
 * 开发根保存在 qa/security-dev-root/（已 gitignore）。生产环境中根与签发人
 * 密钥必须放在离线硬件或加密介质（方案 §3.1），本文件的明文 PEM 形态仅用于
 * 开发与隔离联调；文件头带 warning 字段防止误当成生产密钥。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  generateIssuerKey,
  generateRootKey,
  issueIssuerCert,
  type IssuerSigningKey
} from '../../packages/license-protocol/src/index.ts'

export interface StoredSigningKey {
  version: 1
  kind: 'root' | 'issuer'
  warning: 'development-only-plaintext-key'
  kid: string
  publicKey: string
  privateKeyPem: string
  createdAtUtcSec: number
}

export interface StoredIssuerCert {
  version: 1
  envelope: unknown
  payload: {
    certId: string
    subject: string
    publicKey: string
    notBefore: number
    notAfter: number
    capabilities: string[]
  }
}

export function keyPath(storeDir: string, kind: 'root' | 'issuer'): string {
  return join(storeDir, `${kind}-signing.private.json`)
}

export function certPath(storeDir: string): string {
  return join(storeDir, 'issuer-cert.json')
}

export function rootPublicPath(storeDir: string): string {
  return join(storeDir, 'root.public.json')
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

export function loadSigningKey(storeDir: string, kind: 'root' | 'issuer'): IssuerSigningKey {
  const path = keyPath(storeDir, kind)
  if (!existsSync(path)) {
    throw new Error(`${kind} 密钥不存在（${path}），请先执行 init-root`)
  }
  const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredSigningKey
  if (stored.version !== 1 || stored.kind !== kind) throw new Error(`${kind} 密钥文件结构非法`)
  return { privateKeyPem: stored.privateKeyPem, publicKey: stored.publicKey, kid: stored.kid }
}

export function loadIssuerCert(storeDir: string): StoredIssuerCert {
  const path = certPath(storeDir)
  if (!existsSync(path)) throw new Error('签发人证书不存在，请先执行 init-root')
  const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredIssuerCert
  if (stored.version !== 1) throw new Error('签发人证书文件结构非法')
  return stored
}

/** init-root：生成（或复用）根 + 签发人密钥，并由根签发签发人证书。 */
export function initKeys(input: {
  storeDir: string
  subject: string
  nowSec: number
  certValidityDays: number
  force?: boolean
}): { created: boolean; cert: StoredIssuerCert } {
  mkdirSync(input.storeDir, { recursive: true })
  const created = !existsSync(keyPath(input.storeDir, 'root'))

  let root: IssuerSigningKey
  let issuer: IssuerSigningKey
  if (created || input.force) {
    root = generateRootKey()
    issuer = generateIssuerKey()
    const rootStored: StoredSigningKey = {
      version: 1,
      kind: 'root',
      warning: 'development-only-plaintext-key',
      kid: root.kid,
      publicKey: root.publicKey,
      privateKeyPem: root.privateKeyPem,
      createdAtUtcSec: input.nowSec
    }
    const issuerStored: StoredSigningKey = {
      version: 1,
      kind: 'issuer',
      warning: 'development-only-plaintext-key',
      kid: issuer.kid,
      publicKey: issuer.publicKey,
      privateKeyPem: issuer.privateKeyPem,
      createdAtUtcSec: input.nowSec
    }
    writeAtomic(keyPath(input.storeDir, 'root'), JSON.stringify(rootStored, null, 2))
    writeAtomic(keyPath(input.storeDir, 'issuer'), JSON.stringify(issuerStored, null, 2))
    writeAtomic(
      rootPublicPath(input.storeDir),
      JSON.stringify(
        {
          version: 1,
          environment: 'development',
          note: '将此公钥固定到客户端构建（trusted-root）；生产根必须离线生成并保管',
          kid: root.kid,
          publicKey: root.publicKey
        },
        null,
        2
      )
    )
  } else {
    root = loadSigningKey(input.storeDir, 'root')
    issuer = loadSigningKey(input.storeDir, 'issuer')
  }

  const notBefore = input.nowSec - 60
  const notAfter = input.nowSec + input.certValidityDays * 86400
  const { envelope, payload } = issueIssuerCert({
    root,
    issuer,
    subject: input.subject,
    capabilities: ['challenge.issue', 'license.issue', 'revocation.issue'],
    notBefore,
    notAfter
  })
  const cert: StoredIssuerCert = {
    version: 1,
    envelope,
    payload: {
      certId: payload.certId,
      subject: payload.subject,
      publicKey: payload.publicKey,
      notBefore: payload.notBefore,
      notAfter: payload.notAfter,
      capabilities: [...payload.capabilities]
    }
  }
  writeAtomic(certPath(input.storeDir), JSON.stringify(cert, null, 2))
  return { created, cert }
}
