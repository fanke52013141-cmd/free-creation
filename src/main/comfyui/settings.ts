// ComfyUI 桥设置：服务地址持久化（settings 表，key-value）。
import { getDb } from '../store/db'

const SETTINGS_KEY = 'comfyui.baseUrl'
export const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188'

export function getComfyuiBaseUrl(): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
    { value: string } | undefined
  const stored = row?.value?.trim()
  return stored ? normalizeBaseUrl(stored) : DEFAULT_COMFYUI_BASE_URL
}

/** 归一化并保存；返回归一化后的地址（存前已校验，坏输入抛错）。 */
export function saveComfyuiBaseUrl(rawUrl: string): string {
  const normalized = normalizeBaseUrl(rawUrl)
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(SETTINGS_KEY, normalized)
  return normalized
}

export function normalizeBaseUrl(rawUrl: string): string {
  const input = rawUrl.trim()
  if (!input) throw new Error('ComfyUI 地址不能为空')
  const withScheme = /^https?:\/\//i.test(input) ? input : `http://${input}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error(`无法解析 ComfyUI 地址：${input}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('ComfyUI 地址仅支持 http / https')
  }
  // 保留可能的反向代理路径前缀（如 /comfyui），仅去掉尾部斜杠。
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${path}`
}
