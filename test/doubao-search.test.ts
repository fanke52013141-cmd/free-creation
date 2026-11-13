import { afterEach, describe, expect, it, vi } from 'vitest'

// 事件发射 no-op：单测聚焦请求/解析/错误归一，不写诊断。
vi.mock('../src/main/diagnostics/gateway-events', () => ({
  emitGatewayEvent: vi.fn()
}))

import { searchDoubao } from '../src/main/gateway/doubao-search'
import { GatewayError } from '../src/main/gateway/factory'

const REAL_URL = 'https://open.feedcoopapi.com/search_api/web_search'

function mockFetchOnce(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('豆包搜索受控客户端（C2）', () => {
  it('使用官方真实端点 + Bearer 认证，解析 WebResults 摘要', async () => {
    const fetchMock = mockFetchOnce({
      ResponseMetadata: { RequestId: 'r1' },
      Result: {
        ResultCount: 1,
        WebResults: [
          {
            Title: '标题',
            Url: 'https://example.com/a',
            Summary: '相关摘要正文',
            Snippet: '短片段',
            SiteName: '示例站',
            PublishTime: '2026-11-13T10:00:00+08:00',
            AuthInfoLevel: 2
          }
        ]
      }
    })
    const result = await searchDoubao('secret-key', { query: '测试查询', connectionId: 'doubao-search' })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      title: '标题',
      url: 'https://example.com/a',
      summary: '相关摘要正文',
      siteName: '示例站',
      authInfoLevel: 2
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(REAL_URL)
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer secret-key'
    })
    const sent = JSON.parse(String((init as RequestInit).body))
    expect(sent).toMatchObject({ Query: '测试查询', SearchType: 'web' })
  })

  it('Summary 缺失时回退 Snippet；无链接且无正文的条目丢弃', async () => {
    mockFetchOnce({
      Result: {
        ResultCount: 2,
        WebResults: [
          { Title: '只有片段', Url: 'https://example.com/b', Snippet: '片段正文' },
          { Title: '空条目' }
        ]
      }
    })
    const result = await searchDoubao('k', { query: 'q' })
    expect(result.items).toHaveLength(1)
    expect(result.items[0].summary).toBe('片段正文')
  })

  it('body 错误（HTTP 200）先查 ResponseMetadata.Error，归一稳定码', async () => {
    mockFetchOnce({
      ResponseMetadata: { Error: { Code: '700429', Message: 'rate limit' } },
      Result: null
    })
    await expect(searchDoubao('k', { query: 'q' })).rejects.toMatchObject({
      code: 'WEB_SEARCH_RATE_LIMITED'
    })
  })

  it('额度耗尽 / 密钥无效 / 合规拒绝分别归一', async () => {
    for (const [code, expected] of [
      ['10406', 'WEB_SEARCH_QUOTA_EXHAUSTED'],
      ['700901', 'WEB_SEARCH_AUTH_INVALID'],
      ['10413', 'WEB_SEARCH_COMPLIANCE_BLOCKED']
    ] as const) {
      mockFetchOnce({ ResponseMetadata: { Error: { Code: code } }, Result: null })
      await expect(searchDoubao('k', { query: 'q' })).rejects.toMatchObject({ code: expected })
    }
  })

  it('HTTP 非 2xx 归一 WEB_SEARCH_HTTP_ERROR', async () => {
    mockFetchOnce({}, 500)
    await expect(searchDoubao('k', { query: 'q' })).rejects.toMatchObject({
      code: 'WEB_SEARCH_HTTP_ERROR'
    })
  })

  it('空查询 / 缺密钥前置拒绝，不发请求', async () => {
    const fetchMock = mockFetchOnce({})
    await expect(searchDoubao('k', { query: '   ' })).rejects.toBeInstanceOf(GatewayError)
    await expect(searchDoubao('', { query: 'q' })).rejects.toMatchObject({
      code: 'WEB_SEARCH_NO_KEY'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('查询超过 100 字符截断；Count 钳制到 1~50', async () => {
    const fetchMock = mockFetchOnce({ Result: { ResultCount: 0, WebResults: [] } })
    await searchDoubao('k', { query: 'x'.repeat(200), count: 999 })
    const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(sent.Query).toHaveLength(100)
    expect(sent.Count).toBe(50)
  })
})