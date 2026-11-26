import type { Connection } from '@free-creation/model-contracts'

/** Canonical request origin used to bind credentials to an endpoint. */
export function originOf(targetUrl: string): string | null {
  try {
    const url = new URL(targetUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

const canonicalHeaders = (headers: Record<string, string> | undefined): string =>
  JSON.stringify(
    Object.entries(headers ?? {})
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  )

/**
 * Endpoint facts that must not silently inherit an existing credential.
 * Path-only changes on the same origin are allowed; protocol/header/origin changes are not.
 */
export function endpointBindingChanged(
  previous: Pick<Connection, 'protocol' | 'baseUrl' | 'headers'>,
  next: Pick<Connection, 'protocol' | 'baseUrl' | 'headers'>
): boolean {
  const previousOrigin = originOf(previous.baseUrl)
  const nextOrigin = originOf(next.baseUrl)
  return (
    previous.protocol !== next.protocol ||
    canonicalHeaders(previous.headers) !== canonicalHeaders(next.headers) ||
    previousOrigin !== nextOrigin ||
    (previousOrigin === null && previous.baseUrl !== next.baseUrl)
  )
}
