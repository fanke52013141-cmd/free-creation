import { GatewayError } from './factory'
/** Official GLM 5.3 always thinks; bounded desktop actions use low effort by default. */
export function glmRequestBody(
  url: string,
  body: Record<string, unknown>
): Record<string, unknown> {
  let endpoint: URL
  try {
    endpoint = new URL(url)
  } catch {
    return body
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.hostname !== 'open.bigmodel.cn' ||
    endpoint.pathname !== '/api/paas/v4/chat/completions' ||
    !['glm-5.3', 'glm-5.3-flash'].includes(String(body.model))
  )
    return body
  const thinking = typeof body.thinking === 'object' && body.thinking !== null ? body.thinking : {}
  return {
    ...body,
    thinking: { ...thinking, type: 'enabled' },
    reasoning_effort: body.reasoning_effort ?? 'low'
  }
}

/** P2 端点绑定：AI SDK 通道恒带 Authorization，3xx 一律拒绝（防凭据外发）。 */
async function fetchNoRedirect(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    throw new GatewayError(
      'REDIRECT_BLOCKED',
      '上游返回重定向，为防止凭据外发已拒绝；请使用最终直达地址'
    )
  }
  return response
}

/** Preserve SDK transport/cancellation; never inspect or log credentials or response bodies. */
export const glmCompatibleFetch: typeof fetch = (input, init) => {
  if (typeof init?.body !== 'string') return fetchNoRedirect(input, init)
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let body: Record<string, unknown>
  try {
    body = JSON.parse(init.body)
  } catch {
    return fetchNoRedirect(input, init)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fetchNoRedirect(input, init)
  const next = glmRequestBody(url, body)
  return fetchNoRedirect(input, next === body ? init : { ...init, body: JSON.stringify(next) })
}
