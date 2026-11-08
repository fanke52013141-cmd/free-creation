/**
 * 授权协议基础层测试：规范字节、严格 JSON、base64url、Ed25519 签名、
 * 信封验签与授权期限语义。
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalBytes,
  canonicalJsonString,
  decodeBase64Url,
  encodeBase64Url,
  EnvelopeSchema,
  generateEd25519Key,
  LicensePayloadSchema,
  LicenseProtocolError,
  parseFileJson,
  parseStrictJson,
  safeEqual,
  sealEnvelopePayload,
  signWithPurpose,
  signingInput,
  SIGNING_PURPOSE,
  hmacSha256,
  verifyEnvelope,
  verifyWithPurpose,
  FILE_SIZE_LIMITS,
  LICENSE_PRODUCT
} from '@free-creation/license-protocol'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

describe('canonicalJsonString', () => {
  it('按键名排序并保持数组顺序', () => {
    const value = { b: 1, a: [2, 1], c: { z: null, y: true } }
    expect(canonicalJsonString(value)).toBe('{"a":[2,1],"b":1,"c":{"y":true,"z":null}}')
  })

  it('字符串转义保持确定', () => {
    expect(canonicalJsonString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"')
  })

  it('拒绝浮点数与超安全范围整数', () => {
    expect(() => canonicalJsonString(1.5)).toThrow(LicenseProtocolError)
    expect(() => canonicalJsonString(Number.MAX_SAFE_INTEGER + 1)).toThrow(LicenseProtocolError)
  })

  it('拒绝 undefined 与函数', () => {
    expect(() => canonicalJsonString(undefined as never)).toThrow(LicenseProtocolError)
  })

  it('规范字节稳定可复核', () => {
    const bytes = canonicalBytes({ a: 1, b: 'x' })
    expect(bytes.toString('utf8')).toBe('{"a":1,"b":"x"}')
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      createHash('sha256').update(Buffer.from('{"a":1,"b":"x"}', 'utf8')).digest('hex')
    )
  })
})

describe('parseStrictJson', () => {
  it('解析合法 JSON', () => {
    expect(parseStrictJson('{"a":1,"b":[true,null,"x"]}')).toEqual({ a: 1, b: [true, null, 'x'] })
  })

  it('拒绝对象重复键', () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(LicenseProtocolError)
    expect(() => parseStrictJson('{"o":{"k":1,"k":2}}')).toThrow(LicenseProtocolError)
  })

  it('拒绝尾随内容与裸控制字符', () => {
    expect(() => parseStrictJson('{"a":1} tail')).toThrow(LicenseProtocolError)
    expect(() => parseStrictJson('{"a":"x\ny"}')).toThrow(LicenseProtocolError)
  })

  it('拒绝非 JSON 数值文法与深层嵌套', () => {
    expect(() => parseStrictJson('{"a":01}')).toThrow(LicenseProtocolError)
    const deep = '['.repeat(40) + ']'.repeat(40)
    expect(() => parseStrictJson(deep)).toThrow(LicenseProtocolError)
  })
})

describe('base64url', () => {
  it('往返一致', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const encoded = encodeBase64Url(bytes)
    expect(encoded).not.toContain('=')
    expect(decodeBase64Url(encoded).equals(bytes)).toBe(true)
  })

  it('拒绝填充符与非法字符', () => {
    expect(() => decodeBase64Url('AB=C')).toThrow(LicenseProtocolError)
    expect(() => decodeBase64Url('AB C')).toThrow(LicenseProtocolError)
  })

  it('拒绝被截断的编码（重编码不一致）', () => {
    const full = encodeBase64Url(Buffer.from('hello world', 'utf8'))
    expect(() => decodeBase64Url(full.slice(0, full.length - 1))).toThrow(LicenseProtocolError)
  })
})

describe('Ed25519 签名', () => {
  const key = generateEd25519Key()
  const payloadBytes = Buffer.from('{"k":"v"}', 'utf8')

  it('签名可验证，篡改负载或签名后失败', () => {
    const sig = signWithPurpose({
      purpose: 'license',
      kid: key.kid,
      privateKeyPem: key.privateKeyPem,
      payloadBytes
    })
    expect(
      verifyWithPurpose({ purpose: 'license', kid: key.kid, publicKey: key.publicKey, payloadBytes, sig })
    ).toBe(true)
    const tampered = Buffer.from('{"k":"V"}', 'utf8')
    expect(
      verifyWithPurpose({ purpose: 'license', kid: key.kid, publicKey: key.publicKey, payloadBytes: tampered, sig })
    ).toBe(false)
    // 篡改签名中部的字符（Ed25519 末尾 base64 字符只影响被忽略的标量高位比特，
    // 必须改中间字节才能构成有效篡改样本）。
    const middle = Math.floor(sig.length / 2)
    const flipped = sig[middle] === 'A' ? 'B' : 'A'
    const tamperedSig = sig.slice(0, middle) + flipped + sig.slice(middle + 1)
    expect(
      verifyWithPurpose({ purpose: 'license', kid: key.kid, publicKey: key.publicKey, payloadBytes, sig: tamperedSig })
    ).toBe(false)
  })

  it('用途前缀不同则验证失败', () => {
    const sig = signWithPurpose({
      purpose: 'license',
      kid: key.kid,
      privateKeyPem: key.privateKeyPem,
      payloadBytes
    })
    expect(
      verifyWithPurpose({ purpose: 'challenge', kid: key.kid, publicKey: key.publicKey, payloadBytes, sig })
    ).toBe(false)
  })

  it('签名输入含用途与 kid 分隔', () => {
    const a = signingInput('license', 'sha256-' + '0'.repeat(64), payloadBytes)
    const b = signingInput('license', 'sha256-' + '1'.repeat(64), payloadBytes)
    expect(a.equals(b)).toBe(false)
    expect(SIGNING_PURPOSE.license).toBe('CS/license/v1')
  })

  it('kid 来自 SPKI DER 的 SHA-256', () => {
    const spki = decodeBase64Url(key.publicKey)
    expect(key.kid).toBe(`sha256-${createHash('sha256').update(spki).digest('hex')}`)
  })

  it('hmac 与 safeEqual 工作', () => {
    const mac = hmacSha256(Buffer.alloc(32, 7), Buffer.from('data'))
    expect(safeEqual(mac, Buffer.from(mac))).toBe(true)
    expect(safeEqual(mac, Buffer.alloc(32, 8))).toBe(false)
    expect(safeEqual(mac, Buffer.alloc(31, 8))).toBe(false)
  })
})

describe('信封验签 verifyEnvelope', () => {
  const key = generateEd25519Key()

  function sealedLicense() {
    const payload = {
      v: 1,
      product: LICENSE_PRODUCT,
      licenseId: '11111111-2222-4333-8444-555555555555',
      sequence: 1,
      signKeyId: key.kid,
      wrapKeyId: key.kid,
      capabilities: ['app.run'],
      issuedAt: 1_900_000_000,
      notBefore: 1_900_000_000,
      term: 'days',
      expiresAt: 1_900_086_400
    }
    const { payloadBytes } = sealEnvelopePayload(payload)
    const sig = signWithPurpose({
      purpose: 'license',
      kid: key.kid,
      privateKeyPem: key.privateKeyPem,
      payloadBytes
    })
    return {
      envelope: { kid: key.kid, payload: encodeBase64Url(payloadBytes), sig },
      payloadBytes
    }
  }

  it('正确签名返回负载对象', () => {
    const { envelope } = sealedLicense()
    const parsed = verifyEnvelope({
      envelope,
      purpose: 'license',
      schema: LicensePayloadSchema,
      signerPublicKey: key.publicKey,
      maxPayloadBytes: FILE_SIZE_LIMITS.license,
      label: '授权'
    })
    expect(parsed.term).toBe('days')
    expect(parsed.capabilities).toEqual(['app.run'])
  })

  it('签名者不匹配拒绝', () => {
    const { envelope } = sealedLicense()
    const other = generateEd25519Key()
    expect(() =>
      verifyEnvelope({
        envelope,
        purpose: 'license',
        schema: LicensePayloadSchema,
        signerPublicKey: other.publicKey,
        maxPayloadBytes: FILE_SIZE_LIMITS.license,
        label: '授权'
      })
    ).toThrowError(LicenseProtocolError)
  })

  it('负载对象被改后拒绝（payload 与 sig 不再一致）', () => {
    const { envelope, payloadBytes } = sealedLicense()
    const tampered = { ...envelope, payload: encodeBase64Url(Buffer.concat([payloadBytes, Buffer.from(' ')])) }
    expect(() =>
      verifyEnvelope({
        envelope: tampered,
        purpose: 'license',
        schema: LicensePayloadSchema,
        signerPublicKey: key.publicKey,
        maxPayloadBytes: FILE_SIZE_LIMITS.license,
        label: '授权'
      })
    ).toThrowError(LicenseProtocolError)
  })

  it('信封结构未知字段拒绝', () => {
    expect(() => EnvelopeSchema.parse({ kid: 'x', payload: 'y', sig: 'z', extra: 1 })).toThrow()
  })
})

describe('授权期限语义', () => {
  it('days：拒绝 expiresAt 为空、不超过 notBefore', () => {
    const base = {
      v: 1,
      product: LICENSE_PRODUCT,
      licenseId: '11111111-2222-4333-8444-555555555555',
      sequence: 1,
      signKeyId: `sha256-${'a'.repeat(64)}`,
      wrapKeyId: `sha256-${'b'.repeat(64)}`,
      capabilities: ['app.run'],
      issuedAt: 1000,
      notBefore: 1000,
      term: 'days'
    }
    expect(LicensePayloadSchema.safeParse({ ...base, expiresAt: null }).success).toBe(false)
    expect(LicensePayloadSchema.safeParse({ ...base, expiresAt: 1000 }).success).toBe(false)
    expect(LicensePayloadSchema.safeParse({ ...base, expiresAt: 1000 + 86_400 }).success).toBe(true)
  })

  it('days：拒绝 notBefore 不等于 issuedAt', () => {
    const result = LicensePayloadSchema.safeParse({
      v: 1,
      product: LICENSE_PRODUCT,
      licenseId: '11111111-2222-4333-8444-555555555555',
      sequence: 1,
      signKeyId: `sha256-${'a'.repeat(64)}`,
      wrapKeyId: `sha256-${'b'.repeat(64)}`,
      capabilities: ['app.run'],
      issuedAt: 1000,
      notBefore: 1001,
      term: 'days',
      expiresAt: 1000 + 86_400
    })
    expect(result.success).toBe(false)
  })

  it('permanent：expiresAt 必须为 null；未知 term 拒绝', () => {
    const base = {
      v: 1,
      product: LICENSE_PRODUCT,
      licenseId: '11111111-2222-4333-8444-555555555555',
      sequence: 1,
      signKeyId: `sha256-${'a'.repeat(64)}`,
      wrapKeyId: `sha256-${'b'.repeat(64)}`,
      capabilities: ['app.run', 'credentials.export'],
      issuedAt: 1000,
      notBefore: 1000,
      term: 'permanent',
      expiresAt: null
    }
    expect(LicensePayloadSchema.safeParse(base).success).toBe(true)
    // 缺少 expiresAt 字段本身也必须拒绝（缺少期限字段均拒绝）。
    const { expiresAt: _expiresAt, ...withoutExpiry } = base
    expect(LicensePayloadSchema.safeParse(withoutExpiry).success).toBe(false)
    expect(LicensePayloadSchema.safeParse({ ...base, expiresAt: 2000 }).success).toBe(false)
    expect(LicensePayloadSchema.safeParse({ ...base, term: 'forever' }).success).toBe(false)
  })
})

describe('parseFileJson', () => {
  it('超限拒绝并带尺寸信息', () => {
    expect(() => parseFileJson('x'.repeat(70 * 1024), FILE_SIZE_LIMITS.license, '授权')).toThrowError(
      /超过/
    )
  })

  it('顶层非对象拒绝', () => {
    expect(() => parseFileJson('[1,2]', 1024, '授权')).toThrowError(LicenseProtocolError)
  })
})
