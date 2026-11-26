/** renderer 错误只保留显式稳定码；其余统一归类，原始文案绝不落库/回传。 */
export function externalRunErrorCode(raw: string | undefined): string {
  if (raw && /^[A-Z][A-Z0-9_]{2,79}$/.test(raw)) return raw
  return 'NODE_EXECUTION_FAILED'
}
