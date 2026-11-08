/**
 * 规范字节与严格 JSON 解析。
 *
 * 授权文件签名一律针对「规范 JSON 字节」计算，验签时重新规范化并逐字节复核，
 * 避免键序、空白或编码差异导致的签名歧义。
 *
 * 本协议的 Schema 只允许整数、字符串、布尔、null、数组和对象（无浮点数），
 * 因此规范化的数值分支只需覆盖安全整数，规避 RFC 8785 的浮点序列化歧义。
 */
import { Buffer } from 'node:buffer'
import { LicenseProtocolError } from './errors.ts'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** 规范化 JSON 字符串：键按 UTF-16 码元排序，字符串走 JSON 转义，数值必须是安全整数。 */
export function canonicalJsonString(value: JsonValue): string {
  if (value === null) return 'null'
  const typeofValue = typeof value
  if (typeofValue === 'string') return JSON.stringify(value)
  if (typeofValue === 'boolean') return value ? 'true' : 'false'
  if (typeofValue === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new LicenseProtocolError(
        'NON_INTEGER_NUMBER',
        '协议数值必须是不超过安全整数范围的整数'
      )
    }
    return String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonString(item)).join(',')}]`
  }
  if (typeofValue === 'object') {
    const record = value as { [key: string]: JsonValue }
    const keys = Object.keys(record).sort()
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonString(record[key])}`)
    return `{${parts.join(',')}}`
  }
  throw new LicenseProtocolError('UNSUPPORTED_VALUE_TYPE', '协议值包含不可序列化的类型')
}

export function canonicalBytes(value: JsonValue): Buffer {
  return Buffer.from(canonicalJsonString(value), 'utf8')
}

/**
 * 严格 UTF-8 JSON 解析：
 * - 拒绝对象内重复键（JSON.parse 默认后者覆盖，会掩盖篡改）；
 * - 拒绝尾随内容、裸控制字符与非 JSON 数值文法；
 * - 限制嵌套深度，防止恶意深递归。
 */
export function parseStrictJson(text: string): JsonValue {
  return new StrictJsonParser(text).parseDocument()
}

const MAX_DEPTH = 32

class StrictJsonParser {
  private pos = 0

  constructor(private readonly text: string) {}

  parseDocument(): JsonValue {
    const value = this.parseValue(0)
    this.skipWhitespace()
    if (this.pos !== this.text.length) {
      throw new LicenseProtocolError('TRAILING_CONTENT', 'JSON 文档末尾存在多余内容')
    }
    return value
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text.charCodeAt(this.pos)
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) this.pos += 1
      else break
    }
  }

  private peek(): string {
    if (this.pos >= this.text.length) {
      throw new LicenseProtocolError('JSON_MALFORMED', 'JSON 提前结束')
    }
    return this.text[this.pos]
  }

  private parseValue(depth: number): JsonValue {
    if (depth > MAX_DEPTH) {
      throw new LicenseProtocolError('JSON_MALFORMED', 'JSON 嵌套深度超限')
    }
    this.skipWhitespace()
    const ch = this.peek()
    if (ch === '{') return this.parseObject(depth)
    if (ch === '[') return this.parseArray(depth)
    if (ch === '"') return this.parseString()
    if (ch === 't') return this.parseLiteral('true', true)
    if (ch === 'f') return this.parseLiteral('false', false)
    if (ch === 'n') return this.parseLiteral('null', null)
    return this.parseNumber()
  }

  private parseLiteral(literal: string, value: JsonValue): JsonValue {
    if (this.text.startsWith(literal, this.pos)) {
      this.pos += literal.length
      return value
    }
    throw new LicenseProtocolError('JSON_MALFORMED', `非法字面量（期望 ${literal}）`)
  }

  private parseObject(depth: number): { [key: string]: JsonValue } {
    this.pos += 1 // '{'
    const result: { [key: string]: JsonValue } = {}
    const seen = new Set<string>()
    this.skipWhitespace()
    if (this.peek() === '}') {
      this.pos += 1
      return result
    }
    for (;;) {
      this.skipWhitespace()
      if (this.peek() !== '"') {
        throw new LicenseProtocolError('JSON_MALFORMED', '对象键必须是字符串')
      }
      const key = this.parseString()
      if (seen.has(key)) {
        throw new LicenseProtocolError('DUPLICATE_KEY', `对象存在重复键: ${key}`)
      }
      seen.add(key)
      this.skipWhitespace()
      if (this.peek() !== ':') {
        throw new LicenseProtocolError('JSON_MALFORMED', '对象键后缺少冒号')
      }
      this.pos += 1
      result[key] = this.parseValue(depth + 1)
      this.skipWhitespace()
      const ch = this.peek()
      if (ch === ',') {
        this.pos += 1
        continue
      }
      if (ch === '}') {
        this.pos += 1
        return result
      }
      throw new LicenseProtocolError('JSON_MALFORMED', '对象中缺少逗号或右花括号')
    }
  }

  private parseArray(depth: number): JsonValue[] {
    this.pos += 1 // '['
    const result: JsonValue[] = []
    this.skipWhitespace()
    if (this.peek() === ']') {
      this.pos += 1
      return result
    }
    for (;;) {
      result.push(this.parseValue(depth + 1))
      this.skipWhitespace()
      const ch = this.peek()
      if (ch === ',') {
        this.pos += 1
        continue
      }
      if (ch === ']') {
        this.pos += 1
        return result
      }
      throw new LicenseProtocolError('JSON_MALFORMED', '数组中缺少逗号或右方括号')
    }
  }

  private parseString(): string {
    const start = this.pos
    this.pos += 1 // opening quote
    for (;;) {
      if (this.pos >= this.text.length) {
        throw new LicenseProtocolError('JSON_MALFORMED', '字符串未闭合')
      }
      const code = this.text.charCodeAt(this.pos)
      if (code < 0x20) {
        throw new LicenseProtocolError('JSON_MALFORMED', '字符串包含裸控制字符')
      }
      if (code === 0x22) {
        this.pos += 1
        const token = this.text.slice(start, this.pos)
        // token 已确认结构完整，交给 JSON.parse 处理转义序列（含 \uXXXX、代理对）。
        return JSON.parse(token) as string
      }
      if (code === 0x5c) {
        this.pos += 2 // 跳过转义字符与被转义字符，合法性由 JSON.parse 校验
        continue
      }
      this.pos += 1
    }
  }

  private parseNumber(): number {
    const rest = this.text.slice(this.pos)
    const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(rest)
    if (!match || match[0].length === 0) {
      throw new LicenseProtocolError('JSON_MALFORMED', '非法数值文法')
    }
    this.pos += match[0].length
    return Number(match[0])
  }
}

// ---------------------------------------------------------------------------
// base64url（无填充）
// ---------------------------------------------------------------------------

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function decodeBase64Url(value: string): Buffer {
  if (value.length % 4 === 1 || !BASE64URL_PATTERN.test(value)) {
    throw new LicenseProtocolError('BAD_BASE64URL', '非法 base64url 编码')
  }
  const decoded = Buffer.from(value, 'base64url')
  // 重编码比对：Node 解码会忽略非法尾部余量，重编码不一致即视为篡改或截断。
  if (decoded.toString('base64url') !== value) {
    throw new LicenseProtocolError('BAD_BASE64URL', 'base64url 解码长度不一致')
  }
  return decoded
}

// ---------------------------------------------------------------------------
// 签名输入：用途前缀
// ---------------------------------------------------------------------------

/** 用途前缀常量。签名输入 = utf8(用途) || 0x00 || utf8(kid) || 0x00 || 负载规范字节。 */
export const SIGNING_PURPOSE = {
  license: 'CS/license/v1',
  issuerCert: 'CS/issuer-cert/v1',
  challenge: 'CS/challenge/v1',
  revocation: 'CS/revocation/v1',
  proofHmac: 'CS/proof/hmac/v1',
  proofSign: 'CS/proof/sign/v1'
} as const

export type SigningPurpose = keyof typeof SIGNING_PURPOSE

export function signingInput(purpose: SigningPurpose, kid: string, payloadBytes: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(SIGNING_PURPOSE[purpose], 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(kid, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(payloadBytes)
  ])
}
