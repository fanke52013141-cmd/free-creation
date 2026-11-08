/**
 * cs-issuer：Canvas Studio 离线发证工具（方案 §3.4）。
 *
 *   node tools/cs-issuer/cli.ts init-root   --subject <名称> [--store <目录>]
 *   node tools/cs-issuer/cli.ts enroll-ek   --request <csreq> [--note <备注>]
 *   node tools/cs-issuer/cli.ts challenge   --request <csreq> --out <cschallenge> [--strong]
 *   node tools/cs-issuer/cli.ts issue       --proof <csproof> (--days <N> | --permanent) --role <recipient|key-issuer> --out <cslicense> [--operator <名称>]
 *   node tools/cs-issuer/cli.ts issue       --request <csreq> --trust-request (--days <N> | --permanent) --out <cslicense>   ← 信任直发：一来一回
 *                                             （--allow-soft-dev 仅限隔离联调放行软件设备申请）
 *   node tools/cs-issuer/cli.ts inspect     --file <cslicense|cschallenge|cspolicy>
 *   node tools/cs-issuer/cli.ts revoke      --license-id <uuid> --out <cspolicy> [--operator <名称>]
 *   node tools/cs-issuer/cli.ts revoke-issuer --cert-id <uuid> --out <cspolicy> [--operator <名称>]
 *   node tools/cs-issuer/cli.ts list
 *
 * 环境变量 CS_ISSUER_STORE 可代替 --store（默认 qa/security-dev-root）。
 * 强模式（--strong）要求申请携带 EK 摘要且与台账登记一致，且拒绝软件设备密钥。
 * 私钥口令不经过命令行参数、Shell 历史与环境变量：开发根为明文文件（0600），
 * 生产根必须置于离线硬件（见 docs/security/01-P1-license-delivery.md）。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  canonicalBytes,
  ChallengePayloadSchema,
  decodeBase64Url,
  DeviceProofSchema,
  DeviceRequestSchema,
  FILE_SIZE_LIMITS,
  IssuerCertPayloadSchema,
  LicensePayloadSchema,
  parseFileJson,
  parseStrictJson,
  RevocationPolicyPayloadSchema,
  verifyEnvelope,
  verifyProof,
  validateRequest,
  issueChallenge,
  issueLicense,
  issueRevocationPolicy,
  type DeviceRequest,
  type Envelope,
  type IssuerRole
} from '../../packages/license-protocol/src/index.ts'
import { Ledger, type IssuerLedger } from './ledger.ts'
import { initKeys, loadIssuerCert, loadSigningKey } from './keystore.ts'

interface CliArgs {
  _: string[]
  flags: Map<string, string>
}

function parseArgs(argv: string[]): CliArgs {
  const _: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next)
        i += 1
      } else {
        flags.set(key, 'true')
      }
    } else {
      _.push(arg)
    }
  }
  return { _, flags }
}

function fail(message: string): never {
  console.error(`cs-issuer: ${message}`)
  process.exit(2)
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function utcText(sec: number | null): string {
  if (sec === null) return '永久有效'
  return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function storeDirOf(args: CliArgs): string {
  return resolve(args.flags.get('store') ?? process.env.CS_ISSUER_STORE ?? 'qa/security-dev-root')
}

function readTextFile(path: string, limit: number, label: string): string {
  if (!existsSync(path)) fail(`${label}不存在: ${path}`)
  const text = readFileSync(path, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > limit) fail(`${label}超过 ${limit} 字节上限`)
  return text
}

function writeOut(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

function asEnvelope(value: unknown, label: string): Envelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label}缺少信封`)
  return value as Envelope
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

function cmdInitRoot(args: CliArgs): void {
  const subject = args.flags.get('subject') ?? 'canvas-studio-issuer'
  const storeDir = storeDirOf(args)
  const validityDays = Number(args.flags.get('cert-days') ?? '365')
  if (!Number.isSafeInteger(validityDays) || validityDays <= 0) fail('--cert-days 必须为正整数')
  const { created, cert } = initKeys({
    storeDir,
    subject,
    nowSec: nowSec(),
    certValidityDays: validityDays,
    force: args.flags.get('force') === 'true'
  })
  new Ledger(storeDir).transact(nowSec(), () => undefined)
  console.log(`根密钥${created ? '已生成' : '已存在'}；签发人证书已${created ? '签发' : '刷新'}。`)
  console.log(`  证书 ID: ${cert.payload.certId}`)
  console.log(`  主体:    ${cert.payload.subject}`)
  console.log(`  有效期:  ${utcText(cert.payload.notBefore)} ~ ${utcText(cert.payload.notAfter)}`)
  console.log(`  根公钥:  ${readFileSync(join(storeDir, 'root.public.json'), 'utf8').includes('"kid"') ? '见 root.public.json' : ''}`)
  console.log('提醒：开发根为明文文件（0600），生产根必须离线硬件保管。')
}

function loadRequest(path: string): DeviceRequest {
  const text = readTextFile(path, FILE_SIZE_LIMITS.request, '设备申请')
  let parsed: unknown
  try {
    parsed = parseStrictJson(text)
  } catch (error) {
    fail(`设备申请解析失败: ${(error as Error).message}`)
  }
  const result = DeviceRequestSchema.safeParse(parsed)
  if (!result.success) fail('设备申请结构不符合协议')
  return result.data
}

function cmdEnrollEk(args: CliArgs): void {
  const storeDir = storeDirOf(args)
  const request = loadRequest(requireFlag(args, 'request'))
  const note = args.flags.get('note')
  const ledger = new Ledger(storeDir)
  ledger.transact(nowSec(), (data: IssuerLedger) => {
    if (data.enrollments.some((item) => item.deviceSummary === request.device.deviceSummary)) {
      console.log(`设备 ${request.device.deviceSummary} 已登记，跳过。`)
      return
    }
    data.enrollments.push({
      deviceSummary: request.device.deviceSummary,
      ekPublicKeyHash: request.device.ekPublicKeyHash,
      enrolledAtUtcSec: nowSec(),
      ...(note ? { note } : {})
    })
    console.log(`已登记设备 ${request.device.deviceSummary}（EK: ${request.device.ekPublicKeyHash ?? '未携带'}）。`)
  })
}

function cmdChallenge(args: CliArgs): void {
  const storeDir = storeDirOf(args)
  const requestPath = requireFlag(args, 'request')
  const outPath = requireFlag(args, 'out')
  const strong = args.flags.get('strong') === 'true'
  const request = loadRequest(requestPath)
  const ledger = new Ledger(storeDir)
  const issuer = loadSigningKey(storeDir, 'issuer')
  const cert = loadIssuerCert(storeDir)

  const enrolled = ledger.read().enrollments.find((item) => item.deviceSummary === request.device.deviceSummary)
  if (!enrolled && args.flags.get('allow-unenrolled') !== 'true') {
    fail(`设备 ${request.device.deviceSummary} 未登记；请先当面核验设备并执行 enroll-ek（或显式 --allow-unenrolled）`)
  }

  try {
    validateRequest({ request, enrolledEkHash: enrolled?.ekPublicKeyHash ?? null, requireEk: strong })
  } catch (error) {
    fail((error as Error).message)
  }

  const requestText = readTextFile(requestPath, FILE_SIZE_LIMITS.request, '设备申请')
  const challenge = issueChallenge({ issuer, request, requestText, nowSec: nowSec() })
  ledger.transact(nowSec(), (data) => {
    data.requestTexts[challenge.payload.requestSha256] = canonicalRequestText(request)
    data.challenges.push({
      challengeId: challenge.payload.challengeId,
      deviceSummary: request.device.deviceSummary,
      requestId: request.requestId,
      requestSha256: challenge.payload.requestSha256,
      nonce: challenge.payload.nonce,
      secretHex: challenge.secretHex,
      issuedAtUtcSec: challenge.payload.issuedAt,
      expiresAtUtcSec: challenge.payload.expiresAt,
      status: 'open'
    })
  })
  const fileText = JSON.stringify({ challenge: challenge.envelope, issuerCert: cert.envelope }, null, 2)
  writeOut(outPath, fileText)
  console.log(`挑战已签发: ${challenge.payload.challengeId}`)
  console.log(`  绑定申请: ${challenge.payload.requestSha256.slice(0, 16)}…`)
  console.log(`  有效期至: ${utcText(challenge.payload.expiresAt)}`)
  console.log(`  输出:     ${outPath}`)
}

function cmdIssue(args: CliArgs): void {
  const storeDir = storeDirOf(args)
  const outPath = requireFlag(args, 'out')
  const operator = args.flags.get('operator') ?? 'unspecified'
  const daysFlag = args.flags.get('days')
  const permanentFlag = args.flags.get('permanent') === 'true'
  const roleFlag = args.flags.get('role') ?? 'recipient'
  if (roleFlag !== 'recipient' && roleFlag !== 'key-issuer') fail('--role 必须是 recipient 或 key-issuer')
  const role = roleFlag as IssuerRole

  // 来源二选一：--proof（完整模式：挑战+证明）或 --request + --trust-request（信任直发）。
  const proofFlag = args.flags.get('proof')
  const requestFlag = args.flags.get('request')
  const trustFlag = args.flags.get('trust-request') === 'true'
  if (proofFlag && requestFlag) fail('--proof 与 --request 互斥，只能选择一种发证来源')
  if (!proofFlag && !requestFlag) fail('必须提供 --proof <csproof>（完整模式）或 --request <csreq> --trust-request（信任直发）')
  if (requestFlag && !trustFlag) fail('信任直发必须显式携带 --trust-request（确认理解跳过持有证明的风险）')
  const directMode = Boolean(requestFlag)

  // 期限互斥校验：必须且只能选择一种。
  if (daysFlag !== undefined && permanentFlag) fail('--days 与 --permanent 互斥，只能选择一种')
  if (daysFlag === undefined && !permanentFlag) fail('必须选择 --days <正整数> 或 --permanent（默认未选）')
  let days: number | null = null
  if (daysFlag !== undefined) {
    days = Number(daysFlag)
    if (!Number.isSafeInteger(days) || days <= 0) fail('--days 必须为正整数（拒绝空值、零、负数、小数）')
  }

  const ledger = new Ledger(storeDir)
  const issuer = loadSigningKey(storeDir, 'issuer')
  const cert = loadIssuerCert(storeDir)

  let proof: ReturnType<typeof DeviceProofSchema.parse> | null = null
  let proofRawText: string | null = null
  let directRequest: DeviceRequest | null = null
  let directRequestText = ''
  if (directMode) {
    // 信任直发：以申请文件为凭据。软件设备密钥（keySource=software-dev）是
    // 「一码多机」的唯一途径，直发模式一律拒绝——保证一个授权码只对一台真机有效。
    directRequestText = readTextFile(requireFlag(args, 'request'), FILE_SIZE_LIMITS.request, '设备申请')
    let parsed: DeviceRequest
    try {
      parsed = DeviceRequestSchema.parse(parseStrictJson(directRequestText))
    } catch (error) {
      fail(`设备申请结构非法: ${(error as Error).message}`)
    }
    if (parsed.device.keySource === 'software-dev' && args.flags.get('allow-soft-dev') !== 'true') {
      fail('信任直发拒绝 software-dev 设备申请（软件密钥可复制，无法保证一码一机）；仅隔离联调可用 --allow-soft-dev 显式放行')
    }
    directRequest = parsed
  } else {
    proofRawText = readTextFile(proofFlag!, FILE_SIZE_LIMITS.proof, '设备证明')
    try {
      proof = DeviceProofSchema.parse(parseStrictJson(proofRawText))
    } catch (error) {
      fail(`设备证明结构非法: ${(error as Error).message}`)
    }
  }

  if (directMode && directRequest) {
    issueDirect({
      ledger,
      issuer,
      cert,
      request: directRequest,
      requestText: directRequestText,
      role,
      term: permanentFlag ? 'permanent' : ('days' as const),
      days,
      operator,
      outPath
    })
    return
  }

  const result = ledger.transact(nowSec(), (data) => {
    const challenge = data.challenges.find((item) => item.challengeId === proof!.challengeId)
    if (!challenge) fail(`台账中没有挑战 ${proof!.challengeId}`)

    // 幂等重试：同一挑战已发过证 → 原样补发同一结果，不重复签发。
    const existing = data.issues.find((item) => item.challengeId === challenge.challengeId)
    if (existing) {
      return { replayed: true as const, issue: existing }
    }

    if (challenge.status !== 'open') fail('挑战已被消费，拒绝重用')
    if (nowSec() >= challenge.expiresAtUtcSec) fail(`挑战已过期（${utcText(challenge.expiresAtUtcSec)}），请重新申请`)

    // 台账取回申请原文与挑战秘密，核对双密钥持有证明。
    const requestRecord = loadRequestBySha(data, challenge.requestSha256)
    verifyProof({
      request: requestRecord,
      challenge: {
        envelope: challengeEnvelopeForVerification(),
        payload: {
          v: 1,
          product: 'com.canvas-studio.app',
          challengeId: challenge.challengeId,
          requestSha256: challenge.requestSha256,
          nonce: challenge.nonce,
          wrappedSecret: '',
          issuedAt: challenge.issuedAtUtcSec,
          expiresAt: challenge.expiresAtUtcSec
        },
        secretHex: challenge.secretHex
      },
      proofText: proofRawText!,
      nowSec: nowSec()
    })

    const sequence = data.issues.filter((item) => item.deviceSummary === challenge.deviceSummary).length + 1
    const license = issueLicense({
      issuer,
      issuerCert: {
        v: 1,
        certId: cert.payload.certId,
        subject: cert.payload.subject,
        purpose: 'license-issue',
        capabilities: cert.payload.capabilities as never,
        publicKey: cert.payload.publicKey,
        notBefore: cert.payload.notBefore,
        notAfter: cert.payload.notAfter
      },
      request: requestRecord,
      sequence,
      role,
      term: permanentFlag ? 'permanent' : 'days',
      days: days ?? undefined,
      nowSec: nowSec()
    })
    const record = {
      licenseId: license.payload.licenseId,
      mode: 'challenge' as const,
      challengeId: challenge.challengeId,
      deviceSummary: challenge.deviceSummary,
      sequence,
      role,
      term: permanentFlag ? ('permanent' as const) : ('days' as const),
      days,
      expiresAtUtcSec: license.payload.expiresAt,
      issuedAtUtcSec: license.payload.issuedAt,
      operator,
      licenseEnvelope: license.envelope,
      issuerCertEnvelope: cert.envelope
    }
    data.issues.push(record)
    challenge.status = 'consumed'
    return {
      replayed: false as const,
      issue: record,
      licenseText: JSON.stringify({ license: license.envelope, issuerCert: cert.envelope }, null, 2)
    }
  })

  if (result.replayed) {
    const record = result.issue
    writeOut(
      outPath,
      JSON.stringify({ license: record.licenseEnvelope, issuerCert: record.issuerCertEnvelope }, null, 2)
    )
    console.log(`该挑战此前已发证（授权 ${record.licenseId}），已原样补发同一结果，未重复签发。`)
    return
  }

  writeOut(outPath, result.licenseText)
  const record = result.issue
  console.log(`授权已签发: ${record.licenseId}`)
  console.log(`  设备摘要: ${record.deviceSummary}`)
  console.log(`  角色:     ${record.role === 'recipient' ? '使用者' : '模型密钥发放员'}`)
  console.log(`  期限:     ${record.term === 'permanent' ? '永久有效' : `${record.days} 天（至 ${utcText(record.expiresAtUtcSec)}）`}`)
  console.log(`  授权序号: ${record.sequence}`)
  console.log(`  输出:     ${outPath}`)
}

interface DirectIssueDeps {
  ledger: Ledger
  issuer: ReturnType<typeof loadSigningKey>
  cert: ReturnType<typeof loadIssuerCert>
  request: DeviceRequest
  requestText: string
  role: IssuerRole
  term: 'days' | 'permanent'
  days: number | null
  operator: string
  outPath: string
}

/**
 * 信任直发（--request + --trust-request）：跳过挑战/证明，以申请文件为凭据直接签发。
 * 一码一机由客户端设备绑定保证：授权焊死申请中的 TPM 密钥指纹，导入与每次开机都会
 * 核验本机密钥并做持有签名验证；software-dev 申请已在入口拒绝。
 * 同一申请重复签发 = 续期（授权序号递增），仍然只对该一台设备有效。
 */
function issueDirect(deps: DirectIssueDeps): void {
  const requestSha256 = createHash('sha256').update(Buffer.from(deps.requestText, 'utf8')).digest('hex')
  const deviceSummary = deps.request.device.deviceSummary
  const record = deps.ledger.transact(nowSec(), (data) => {
    data.requestTexts[requestSha256] = canonicalRequestText(deps.request)
    const sequence = data.issues.filter((item) => item.deviceSummary === deviceSummary).length + 1
    const license = issueLicense({
      issuer: deps.issuer,
      issuerCert: {
        v: 1,
        certId: deps.cert.payload.certId,
        subject: deps.cert.payload.subject,
        purpose: 'license-issue',
        capabilities: deps.cert.payload.capabilities as never,
        publicKey: deps.cert.payload.publicKey,
        notBefore: deps.cert.payload.notBefore,
        notAfter: deps.cert.payload.notAfter
      },
      request: deps.request,
      sequence,
      role: deps.role,
      term: deps.term,
      days: deps.days ?? undefined,
      nowSec: nowSec()
    })
    const rec = {
      licenseId: license.payload.licenseId,
      mode: 'trust-request' as const,
      challengeId: `trust-${requestSha256.slice(0, 16)}`,
      deviceSummary,
      sequence,
      role: deps.role,
      term: deps.term,
      days: deps.days,
      expiresAtUtcSec: license.payload.expiresAt,
      issuedAtUtcSec: license.payload.issuedAt,
      operator: deps.operator,
      licenseEnvelope: license.envelope,
      issuerCertEnvelope: deps.cert.envelope
    }
    data.issues.push(rec)
    return {
      rec,
      licenseText: JSON.stringify({ license: license.envelope, issuerCert: deps.cert.envelope }, null, 2)
    }
  })
  writeOut(deps.outPath, record.licenseText)
  console.log(`授权已签发（信任直发）: ${record.rec.licenseId}`)
  console.log(`  设备摘要: ${record.rec.deviceSummary}`)
  console.log(`  角色:     ${record.rec.role === 'recipient' ? '使用者' : '模型密钥发放员'}`)
  console.log(`  期限:     ${record.rec.term === 'permanent' ? '永久有效' : `${record.rec.days} 天（至 ${utcText(record.rec.expiresAtUtcSec)}）`}`)
  console.log(`  授权序号: ${record.rec.sequence}`)
  console.log(`  绑定申请: ${requestSha256.slice(0, 16)}…（该授权仅对此设备有效）`)
  console.log(`  输出:     ${deps.outPath}`)
}

function requireFlag(args: CliArgs, key: string): string {
  const value = args.flags.get(key)
  if (value === undefined || value === 'true') fail(`缺少 --${key} 参数`)
  return value
}

function loadRequestBySha(data: IssuerLedger, requestSha256: string): DeviceRequest {
  // 台账挑战记录携带申请摘要；申请原文在 challenge 时存入 requestTexts。
  const stored = data.requestTexts[requestSha256]
  if (!stored) fail('台账中没有该申请原文（requestTexts 缺失）')
  return DeviceRequestSchema.parse(parseStrictJson(stored))
}

/** verifyProof 只用 payload/secretHex；信封字段在台账核对场景不参与。 */
function challengeEnvelopeForVerification(): Envelope {
  return { kid: 'sha256-' + '0'.repeat(64), payload: '', sig: '' }
}

/** 台账保存申请原文时使用规范形态（与设备端 requestText 字节一致的 JSON 文本）。 */
function canonicalRequestText(request: DeviceRequest): string {
  return canonicalBytes(request as unknown as Parameters<typeof canonicalBytes>[0]).toString('utf8')
}

function cmdInspect(args: CliArgs): void {
  const storeDir = storeDirOf(args)
  const path = requireFlag(args, 'file')
  const text = readTextFile(path, 4 * 1024 * 1024, '文件')
  const parsed = parseFileJson(text, 4 * 1024 * 1024, '文件')

  // 验签锚点：签发人证书信封（如有）先对根验签。
  let certPublicKey: string | null = null
  if (parsed.issuerCert) {
    const certEnvelope = asEnvelope(parsed.issuerCert, '签发人证书')
    const root = loadSigningKey(storeDir, 'root')
    const certPayload = verifyEnvelope({
      envelope: certEnvelope,
      purpose: 'issuerCert',
      schema: IssuerCertPayloadSchema,
      signerPublicKey: root.publicKey,
      maxPayloadBytes: FILE_SIZE_LIMITS.license,
      label: '签发人证书'
    })
    if (certEnvelope.kid !== root.kid) fail('签发人证书不是由本库根签署')
    certPublicKey = certPayload.publicKey
    console.log(`签发人:   ${certPayload.subject}（证书 ${certPayload.certId.slice(0, 8)}…，至 ${utcText(certPayload.notAfter)}，已验根签名）`)
  }

  try {
    if (parsed.license) {
      const envelope = asEnvelope(parsed.license, '授权')
      if (!certPublicKey) fail('授权文件缺少签发人证书信封，无法验签')
      const payload = verifyEnvelope({
        envelope,
        purpose: 'license',
        schema: LicensePayloadSchema,
        signerPublicKey: certPublicKey,
        maxPayloadBytes: FILE_SIZE_LIMITS.license,
        label: '授权'
      })
      console.log('类型:     授权 (.cslicense)【签名已验证】')
      console.log(`授权 ID:  ${payload.licenseId}`)
      console.log(`序号:     ${payload.sequence}`)
      console.log(`角色能力: ${payload.capabilities.join(', ')}`)
      console.log(`期限类型: ${payload.term === 'permanent' ? '永久授权' : '按天授权'}`)
      console.log(`期限:     ${payload.term === 'permanent' ? '永久有效' : `${Math.round(((payload.expiresAt ?? 0) - payload.issuedAt) / 86400)} 天（至 ${utcText(payload.expiresAt)}）`}`)
      console.log(`签发时间: ${utcText(payload.issuedAt)}`)
      console.log(`绑定设备: sign=${payload.signKeyId.slice(0, 20)}… wrap=${payload.wrapKeyId.slice(0, 20)}…`)
    } else if (parsed.challenge) {
      const envelope = asEnvelope(parsed.challenge, '挑战')
      if (!certPublicKey) fail('挑战文件缺少签发人证书信封，无法验签')
      const payload = verifyEnvelope({
        envelope,
        purpose: 'challenge',
        schema: ChallengePayloadSchema,
        signerPublicKey: certPublicKey,
        maxPayloadBytes: FILE_SIZE_LIMITS.challenge,
        label: '挑战'
      })
      console.log('类型:     挑战 (.cschallenge)【签名已验证】')
      console.log(`挑战 ID:  ${payload.challengeId}`)
      console.log(`绑定申请: ${payload.requestSha256.slice(0, 16)}…`)
      console.log(`有效期至: ${utcText(payload.expiresAt)}`)
    } else if (parsed.policy) {
      const envelope = asEnvelope(parsed.policy, '策略')
      // 策略可能由根或签发人签署。
      const payloadText = decodePayloadJson(envelope)
      const preview = RevocationPolicyPayloadSchema.parse(payloadText)
      const root = loadSigningKey(storeDir, 'root')
      const signerPublicKey = envelope.kid === root.kid ? root.publicKey : (certPublicKey ?? fail('策略由签发人签署但缺少证书'))
      verifyEnvelope({
        envelope,
        purpose: 'revocation',
        schema: RevocationPolicyPayloadSchema,
        signerPublicKey,
        maxPayloadBytes: FILE_SIZE_LIMITS.policy,
        label: '撤销策略'
      })
      console.log('类型:     撤销策略 (.cspolicy)【签名已验证】')
      console.log(`策略 ID:  ${preview.policyId}`)
      console.log(`序号:     ${preview.sequence}`)
      console.log(`种类:     ${preview.kind}`)
      console.log(`撤销授权: ${preview.revokedLicenseIds.length} 项`)
      console.log(`撤销证书: ${preview.revokedIssuerCertIds.length} 项`)
    } else {
      fail('无法识别的文件类型（需要 license/challenge/policy 字段之一）')
    }
  } catch (error) {
    fail(`文件校验失败: ${(error as Error).message}`)
  }
}

function decodePayloadJson(envelope: Envelope): unknown {
  return parseStrictJson(decodeBase64Url(envelope.payload).toString('utf8'))
}

function cmdRevoke(args: CliArgs, kind: 'license-revocation' | 'issuer-revocation'): void {
  const storeDir = storeDirOf(args)
  const outPath = requireFlag(args, 'out')
  const operator = args.flags.get('operator') ?? 'unspecified'
  const id = requireFlag(args, kind === 'license-revocation' ? 'license-id' : 'cert-id')
  const ledger = new Ledger(storeDir)

  const issuer = loadSigningKey(storeDir, 'issuer')
  const cert = loadIssuerCert(storeDir)
  const signer = kind === 'issuer-revocation' ? loadSigningKey(storeDir, 'root') : issuer
  const signedBy: 'root' | 'issuer' = kind === 'issuer-revocation' ? 'root' : 'issuer'

  // 序号必须在台账事务内确定后签署（信封绑定序号）。
  const { policyText, record } = ledger.transact(nowSec(), (data) => {
    const sequence = data.policies.length + 1
    const issued = issueRevocationPolicy({
      signer,
      sequence,
      kind,
      revokedLicenseIds: kind === 'license-revocation' ? [id] : [],
      revokedIssuerCertIds: kind === 'issuer-revocation' ? [id] : [],
      nowSec: nowSec()
    })
    const rec = {
      policyId: issued.payload.policyId,
      sequence,
      kind,
      revokedLicenseIds: issued.payload.revokedLicenseIds,
      revokedIssuerCertIds: issued.payload.revokedIssuerCertIds,
      issuedAtUtcSec: issued.payload.issuedAt,
      signedBy
    }
    data.policies.push(rec)
    const envelopes =
      signedBy === 'issuer'
        ? { policy: issued.envelope, issuerCert: cert.envelope }
        : { policy: issued.envelope }
    return { policyText: JSON.stringify(envelopes, null, 2), record: rec }
  })
  writeOut(outPath, policyText)
  console.log(`撤销策略已签发: ${record.policyId}（序号 ${record.sequence}，由${signedBy === 'root' ? '根' : '签发人'}签署）`)
  console.log(`  撤销目标: ${id}`)
  console.log(`  输出:     ${outPath}（分发给目标设备导入后生效）`)
  void operator
}

function cmdList(args: CliArgs): void {
  const ledger = new Ledger(storeDirOf(args))
  const data = ledger.read()
  console.log(`登记设备: ${data.enrollments.length}`)
  for (const item of data.enrollments) {
    console.log(`  - ${item.deviceSummary}（EK: ${item.ekPublicKeyHash ? item.ekPublicKeyHash.slice(0, 16) + '…' : '无'}，${utcText(item.enrolledAtUtcSec)}）`)
  }
  console.log(`挑战: ${data.challenges.length}（open: ${data.challenges.filter((c) => c.status === 'open').length}）`)
  console.log(`已发授权: ${data.issues.length}`)
  for (const item of data.issues) {
    console.log(`  - ${item.licenseId} 设备=${item.deviceSummary} 序号=${item.sequence} ${item.term === 'permanent' ? '永久' : `${item.days}天`} 角色=${item.role} 模式=${item.mode ?? 'challenge'} 操作人=${item.operator}`)
  }
  console.log(`策略: ${data.policies.length}`)
  for (const item of data.policies) {
    console.log(`  - 序号=${item.sequence} ${item.kind} 授权=${item.revokedLicenseIds.length} 证书=${item.revokedIssuerCertIds.length}`)
  }
}

// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  try {
    switch (command) {
      case 'init-root':
        return cmdInitRoot(args)
      case 'enroll-ek':
        return cmdEnrollEk(args)
      case 'challenge':
        return cmdChallenge(args)
      case 'issue':
        return cmdIssue(args)
      case 'inspect':
        return cmdInspect(args)
      case 'revoke':
        return cmdRevoke(args, 'license-revocation')
      case 'revoke-issuer':
        return cmdRevoke(args, 'issuer-revocation')
      case 'list':
        return cmdList(args)
      default:
        console.log('用法: node tools/cs-issuer/cli.ts <init-root|enroll-ek|challenge|issue|inspect|revoke|revoke-issuer|list> ...')
        process.exit(command === undefined ? 0 : 2)
    }
  } catch (error) {
    fail((error as Error).message)
  }
}

main()
