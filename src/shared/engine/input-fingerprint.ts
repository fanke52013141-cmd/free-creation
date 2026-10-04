/** Stable serialization ignores object key order while preserving input order. */
export function stableInputJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  )
}
export interface InputFingerprintInput {
  contractVersion: number
  config: string
  text: string
  sources: ReadonlyArray<{ portId: string; nodeId: string; sourcePortId?: string; value?: unknown }>
}
/** Only the versioned digest is persisted, never the input body. */
export function computeInputFingerprint(input: InputFingerprintInput): string {
  let config: unknown = input.config
  try {
    config = JSON.parse(input.config)
  } catch {
    /* Preserve incomplete configuration. */
  }
  const serialized = stableInputJson({ ...input, config })
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let i = 0; i < serialized.length; i += 1) {
    first = Math.imul(first ^ serialized.charCodeAt(i), 0x01000193)
    second = Math.imul(second ^ serialized.charCodeAt(i), 0x85ebca6b)
  }
  return `v1:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}
