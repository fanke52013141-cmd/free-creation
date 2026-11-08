/**
 * 签发台账：单一 JSON 文件 + 同卷临时文件原子替换。
 *
 * 方案 §3.3 要求「同一事务中消费挑战、递增序号和保存签发结果」——
 * 本台账把这三步实现为一次读取、一次原子写入。同一请求重试读取同一结果，
 * 不能重复签发。台账不进入客户端诊断，也不随客户包分发。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface EnrollmentRecord {
  deviceSummary: string
  ekPublicKeyHash: string | null
  enrolledAtUtcSec: number
  note?: string
}

export interface ChallengeRecord {
  challengeId: string
  deviceSummary: string
  requestId: string
  requestSha256: string
  /** 挑战随机数（base64url）；核对证明时重建消息用。 */
  nonce: string
  /** 挑战一次性秘密（十六进制）；仅台账留存，绝不写入挑战文件。 */
  secretHex: string
  issuedAtUtcSec: number
  expiresAtUtcSec: number
  /** open | consumed */
  status: 'open' | 'consumed'
}

export interface IssueRecord {
  licenseId: string
  /** 完整模式走挑战消费；信任直发绑定申请摘要。 */
  mode: 'challenge' | 'trust-request'
  /** trust-request 模式下为申请摘要；challenge 模式与挑战记录一致。 */
  challengeId: string
  deviceSummary: string
  sequence: number
  role: 'recipient' | 'key-issuer'
  term: 'days' | 'permanent'
  days: number | null
  expiresAtUtcSec: number | null
  issuedAtUtcSec: number
  operator: string
  /** 重试时原样补发的授权信封（含 payload），保证幂等。 */
  licenseEnvelope: unknown
  issuerCertEnvelope: unknown
}

export interface PolicyRecord {
  policyId: string
  sequence: number
  kind: 'license-revocation' | 'issuer-revocation'
  revokedLicenseIds: string[]
  revokedIssuerCertIds: string[]
  issuedAtUtcSec: number
  signedBy: 'root' | 'issuer'
}

export interface IssuerLedger {
  version: 1
  createdAtUtcSec: number
  enrollments: EnrollmentRecord[]
  challenges: ChallengeRecord[]
  issues: IssueRecord[]
  policies: PolicyRecord[]
  /** 申请原文（规范 JSON 文本），按申请摘要索引；发证核对时重建申请对象。 */
  requestTexts: Record<string, string>
}

function freshLedger(nowSec: number): IssuerLedger {
  return {
    version: 1,
    createdAtUtcSec: nowSec,
    enrollments: [],
    challenges: [],
    issues: [],
    policies: [],
    requestTexts: {}
  }
}

export class Ledger {
  private readonly path: string

  constructor(storeDir: string) {
    this.path = join(storeDir, 'ledger.json')
  }

  exists(): boolean {
    return existsSync(this.path)
  }

  read(): IssuerLedger {
    const ledger = this.readOrNull()
    if (!ledger) throw new Error('台账不存在，请先执行 init-root')
    return ledger
  }

  readOrNull(): IssuerLedger | null {
    if (!existsSync(this.path)) return null
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as IssuerLedger
    if (parsed.version !== 1) throw new Error('台账版本不受支持')
    return {
      ...parsed,
      enrollments: parsed.enrollments ?? [],
      challenges: parsed.challenges ?? [],
      issues: parsed.issues ?? [],
      policies: parsed.policies ?? [],
      requestTexts: parsed.requestTexts ?? {}
    }
  }

  /** 原子事务：读取 → 变更 → 同卷临时文件 + rename。 */
  transact<T>(nowSec: number, mutate: (ledger: IssuerLedger) => T): T {
    const ledger = this.readOrNull() ?? freshLedger(nowSec)
    const result = mutate(ledger)
    const tmpPath = join(this.path + `.${process.pid}.${Date.now()}.tmp`)
    writeFileSync(tmpPath, JSON.stringify(ledger, null, 2), { mode: 0o600 })
    renameSync(tmpPath, this.path)
    return result
  }
}
