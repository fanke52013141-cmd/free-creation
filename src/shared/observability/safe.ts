// 安全序列化（LOGGING_SPEC.md §8）：允许字段列表 + 安全模板 + 最后一道脱敏。
// 未知键丢弃并计数；不记录被丢弃字段的原值；数组超长截断并保留总数。
import { redactDiagnosticText } from '../diagnostics'
import {
  DIAGNOSTICS_ARRAY_MAX_ITEMS,
  DIAGNOSTICS_ATTRIBUTES_MAX_KEYS,
  DIAGNOSTICS_MESSAGE_MAX_CHARS
} from './limits'
import type { DiagnosticsAttributeKind, DiagnosticsEventDefinition } from './events'
import { safeId } from './ids'

export interface SafeAttributesResult {
  attributes: Record<string, string | number | boolean>
  truncatedFields: string[]
  /** 被拒绝的未知/非法键数量（不含截断），只计数不记值。 */
  droppedKeys: number
}

function stripControlChars(text: string): string {
  // 保留换行会破坏 JSONL 之外的摘要可读性；统一压成空格。
  // 这里是「剔除控制字符」的正当用途而非用其匹配业务输入，规则按行豁免。
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ')
}

/** message 安全摘要：固定模板调用方传入文本，这里做最后一道脱敏与截断。 */
export function safeMessage(
  message: unknown,
  privateValues: readonly string[] = [],
  maxChars = DIAGNOSTICS_MESSAGE_MAX_CHARS
): string {
  if (typeof message !== 'string') return ''
  return stripControlChars(redactDiagnosticText(message, maxChars, privateValues))
}

/** 受限短标识：枚举/操作名等，只允许短的可打印标识。 */
export function safeShort(value: unknown, maxChars = 80): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = stripControlChars(value).trim()
  if (!cleaned) return undefined
  return cleaned.slice(0, maxChars)
}

/**
 * 按事件注册表过滤 attributes。非法值（对象/数组/超长文本）丢弃；
 * 数组属性以 `字段.total` 记总数；丢弃数量只给计数。
 */
export function safeAttributes(
  definition: DiagnosticsEventDefinition | undefined,
  input: Record<string, unknown> | undefined,
  privateValues: readonly string[] = []
): SafeAttributesResult {
  const attributes: Record<string, string | number | boolean> = {}
  const truncatedFields: string[] = []
  let droppedKeys = 0
  if (!input) return { attributes, truncatedFields, droppedKeys }
  const allowed = definition?.attributes
  for (const [key, value] of Object.entries(input)) {
    if (!allowed || !Object.prototype.hasOwnProperty.call(allowed, key)) {
      droppedKeys += 1
      continue
    }
    if (attributes[key] !== undefined) {
      droppedKeys += 1
      continue
    }
    const kind: DiagnosticsAttributeKind = allowed[key]
    if (kind === 'int' && typeof value === 'number' && Number.isFinite(value)) {
      attributes[key] = Math.max(0, Math.round(value))
      continue
    }
    if (kind === 'flag' && typeof value === 'boolean') {
      attributes[key] = value
      continue
    }
    if (kind === 'id') {
      const id = safeId(value)
      if (id) attributes[key] = id
      else droppedKeys += 1
      continue
    }
    if (kind === 'short') {
      const text = safeShort(value)
      if (text) attributes[key] = text
      else droppedKeys += 1
      continue
    }
    droppedKeys += 1
  }
  // 数组类输入（例如来源端口列表）在调用方展开前先截断；这里兜底记录总数。
  for (const [key, value] of Object.entries(input)) {
    if (
      Array.isArray(value) &&
      value.length > DIAGNOSTICS_ARRAY_MAX_ITEMS &&
      attributes[`${key}Total`] === undefined &&
      Object.prototype.hasOwnProperty.call(allowed ?? {}, `${key}Total`)
    ) {
      attributes[`${key}Total`] = value.length
    }
  }
  const keys = Object.keys(attributes)
  if (keys.length > DIAGNOSTICS_ATTRIBUTES_MAX_KEYS) {
    for (const key of keys.slice(DIAGNOSTICS_ATTRIBUTES_MAX_KEYS)) delete attributes[key]
    truncatedFields.push('attributes')
  }
  if (privateValues.length > 0) {
    for (const key of Object.keys(attributes)) {
      const value = attributes[key]
      if (typeof value === 'string') {
        const redacted = redactDiagnosticText(value, 128, privateValues)
        attributes[key] = redacted
      }
    }
  }
  return { attributes, truncatedFields, droppedKeys }
}
