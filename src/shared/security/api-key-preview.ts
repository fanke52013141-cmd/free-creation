/**
 * 密钥展示用的脱敏预览：只露出首尾各 5 位，中间用省略号代替。
 *
 * 仅用于设置面板告诉用户「已经保存的是哪一把 key」。不得用于请求、日志或导出。
 * 短 key（≤10 位）如果也按 5+5 展示就等于完整泄露，因此降级为首尾各 2 位。
 */
export function apiKeyPreview(secret: string | null | undefined): string | undefined {
  const key = (secret ?? '').trim()
  if (!key) return undefined
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return `${key.slice(0, 5)}…${key.slice(-5)}`
}
