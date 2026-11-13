// C2 外部 op webSearch.run 边界测试：双确认默认拒绝、密钥只从设备密钥库读取、
// 成功返回结构化结果、上游错误归一为稳定码（不暴露报文/密钥）。
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/main/gateway/providers.repo', () => ({
  getProvider: vi.fn()
}))
vi.mock('../src/main/gateway/doubao-search', () => ({
  searchDoubao: vi.fn()
}))

import { getProvider } from '../src/main/gateway/providers.repo'
import { searchDoubao } from '../src/main/gateway/doubao-search'
import { GatewayError } from '../src/main/gateway/factory'
import { runWebSearchOperation } from '../src/main/agent-access/web-search-ops'
import { WEB_SEARCH_OPERATIONS, WEB_SEARCH_OUTPUTS } from '../src/shared/agent-access/ops/web-search'
import { ACCESS_OPERATIONS, ACCESS_OUTPUTS } from '../src/shared/agent-access/registry'

const mockedGetProvider = vi.mocked(getProvider)
const mockedSearch = vi.mocked(searchDoubao)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('webSearch.run 契约登记', () => {
  it('注册表含 webSearch.run 且输入输出 Schema 一致', () => {
    expect(ACCESS_OPERATIONS['webSearch.run']).toBe(WEB_SEARCH_OPERATIONS['webSearch.run'])
    expect(ACCESS_OUTPUTS['webSearch.run']).toBe(WEB_SEARCH_OUTPUTS['webSearch.run'])
    expect(WEB_SEARCH_OPERATIONS['webSearch.run'].effect).toBe('execute')
  })

  it('输入 schema 拒绝未知字段与空查询', () => {
    const schema = WEB_SEARCH_OPERATIONS['webSearch.run'].input
    expect(schema.safeParse({ query: '测试', apiKey: 'x' }).success).toBe(false)
    expect(schema.safeParse({ query: '' }).success).toBe(false)
    expect(schema.safeParse({ query: '测试', count: 21 }).success).toBe(false)
    expect(schema.safeParse({ query: '测试', count: 5, confirmNetwork: true, confirmCost: true }).success).toBe(true)
  })
})

describe('webSearch.run 确认边界', () => {
  it('缺 confirmNetwork 拒绝且不发任何请求', async () => {
    await expect(runWebSearchOperation('webSearch.run', { query: '测试' })).rejects.toMatchObject({
      code: 'NETWORK_CONFIRM_REQUIRED'
    })
    expect(mockedSearch).not.toHaveBeenCalled()
    expect(mockedGetProvider).not.toHaveBeenCalled()
  })

  it('缺 confirmCost 拒绝且不发任何请求', async () => {
    await expect(
      runWebSearchOperation('webSearch.run', { query: '测试', confirmNetwork: true })
    ).rejects.toMatchObject({ code: 'COST_CONFIRM_REQUIRED' })
    expect(mockedSearch).not.toHaveBeenCalled()
  })

  it('未配置搜索连接密钥拒绝（WEB_SEARCH_NO_KEY）', async () => {
    mockedGetProvider.mockResolvedValue(undefined as never)
    await expect(
      runWebSearchOperation('webSearch.run', { query: '测试', confirmNetwork: true, confirmCost: true })
    ).rejects.toMatchObject({ code: 'WEB_SEARCH_NO_KEY' })
    expect(mockedSearch).not.toHaveBeenCalled()
  })
})

describe('webSearch.run 执行与归一', () => {
  it('成功返回结构化结果且输出符合契约 Schema', async () => {
    mockedGetProvider.mockResolvedValue({ id: 'doubao-search', apiKey: 'vault-key' } as never)
    mockedSearch.mockResolvedValue({
      resultCount: 1,
      items: [
        {
          title: '标题',
          url: 'https://example.com/a',
          summary: '摘要',
          siteName: 'example',
          publishTime: '2026-11-13',
          authInfoLevel: 2
        }
      ]
    })
    const result = await runWebSearchOperation('webSearch.run', {
      query: '测试',
      count: 5,
      confirmNetwork: true,
      confirmCost: true
    })
    expect(WEB_SEARCH_OUTPUTS['webSearch.run'].safeParse(result).success).toBe(true)
    // 密钥只按 well-known id 从设备密钥库读取，外部输入不参与。
    expect(mockedGetProvider).toHaveBeenCalledWith('doubao-search')
    expect(mockedSearch).toHaveBeenCalledWith('vault-key', {
      query: '测试',
      count: 5,
      connectionId: 'doubao-search'
    })
  })

  it('上游 GatewayError 归一为稳定码', async () => {
    mockedGetProvider.mockResolvedValue({ id: 'doubao-search', apiKey: 'vault-key' } as never)
    mockedSearch.mockRejectedValue(new GatewayError('WEB_SEARCH_RATE_LIMITED', 'rate limited'))
    await expect(
      runWebSearchOperation('webSearch.run', { query: '测试', confirmNetwork: true, confirmCost: true })
    ).rejects.toMatchObject({ code: 'WEB_SEARCH_RATE_LIMITED' })
  })

  it('未知上游错误归一为 WEB_SEARCH_FAILED', async () => {
    mockedGetProvider.mockResolvedValue({ id: 'doubao-search', apiKey: 'vault-key' } as never)
    mockedSearch.mockRejectedValue(new Error('raw upstream body with secret'))
    await expect(
      runWebSearchOperation('webSearch.run', { query: '测试', confirmNetwork: true, confirmCost: true })
    ).rejects.toMatchObject({ code: 'WEB_SEARCH_FAILED' })
  })
})