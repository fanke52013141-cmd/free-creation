/** Stable data carried by a website node's website.link@1 output. */
export interface WebsiteLink {
  name: string
  url: string
}

/** Normalize a user-entered target and allow only browser web URLs. */
export function normalizeWebsiteUrl(value: string): string | null {
  const input = value.trim()
  if (!input) return null

  const candidate = /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`
  try {
    const parsed = new URL(candidate)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null
    if (parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}

/** Parse and validate the fixed configuration stored in node props.config. */
export function readWebsiteLink(config: string): WebsiteLink | null {
  let value: unknown
  try {
    value = JSON.parse(config || '{}')
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const data = value as Record<string, unknown>
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const url = typeof data.url === 'string' ? normalizeWebsiteUrl(data.url) : null
  return name && url ? { name, url } : null
}
