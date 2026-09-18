// 生成链路的成本安全收口：错误归一化 + 供应商连接漂移保护 + 只在 429 重发提交。
// 这三条都是「花了钱不能重复花、报错了看得懂」的守卫，全部可离线断言。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describeUpstreamHttpError,
  extractUpstreamMessage,
  isResubmitSafeStatus,
  upstreamErrorCode
} from '../src/shared/upstream-error'
import {
  normalizeBaseURL,
  providerDriftMessage,
  snapshotProviderConnection
} from '../src/shared/provider-connection'

const read = (relative: string) =>
  readFileSync(join(__dirname, '..', relative), 'utf8').replace(/\r\n/g, '\n')

const HTML_BODY =
  '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><center>nginx</center></body></html>'

describe('上游 HTTP 错误归一化', () => {
  it('HTML 错误页不会变成节点上的一段 markup', () => {
    const error = describeUpstreamHttpError(502, HTML_BODY, '视频任务提交失败')
    expect(error.message).not.toContain('<')
    expect(error.message).not.toContain('nginx')
    expect(error.message).toContain('上游服务异常')
    expect(error.message).toContain('HTTP 502')
    expect(error.message).toContain('视频任务提交失败')
  })

  it('状态码语义化：密钥、权限、地址、额度各自可行动', () => {
    expect(describeUpstreamHttpError(401, '', '配音失败').message).toContain('API Key')
    expect(describeUpstreamHttpError(403, '', '配音失败').message).toContain('模型权限')
    expect(describeUpstreamHttpError(404, '', '配音失败').message).toContain('Base URL')
    expect(describeUpstreamHttpError(429, '', '配音失败').message).toContain('频率或额度')
    expect(describeUpstreamHttpError(400, '', '配音失败').message).toContain('上游拒绝请求')
  })

  it('嵌套 JSON 错误体只留下最具体的一句原因', () => {
    const error = describeUpstreamHttpError(
      400,
      JSON.stringify({ error: { code: 'rate_limit', message: 'quota exceeded for this key' } }),
      'MiniMax 提交视频任务失败'
    )
    expect(error.message).toContain('quota exceeded for this key')
    expect(error.message).not.toContain('rate_limit')
    expect(
      extractUpstreamMessage({ base_resp: { status_code: 1004, status_msg: '余额不足' } })
    ).toBe('余额不足')
  })

  it('非 JSON 的纯文本错误体原样保留', () => {
    const error = describeUpstreamHttpError(402, 'insufficient credit', '生图失败')
    expect(error.message).toContain('insufficient credit')
  })

  it('错误码分类供重试策略判定', () => {
    expect(upstreamErrorCode(401)).toBe('UPSTREAM_AUTH')
    expect(upstreamErrorCode(429)).toBe('UPSTREAM_RATE_LIMIT')
    expect(upstreamErrorCode(500)).toBe('UPSTREAM_ERROR')
  })

  it('只有 429 允许重发提交', () => {
    expect(isResubmitSafeStatus(429)).toBe(true)
    expect(isResubmitSafeStatus(500)).toBe(false)
    expect(isResubmitSafeStatus(504)).toBe(false)
    expect(isResubmitSafeStatus(400)).toBe(false)
  })
})

describe('供应商连接漂移保护', () => {
  const minimax = { specId: 'minimax', baseURL: 'https://api.minimaxi.com/v1' }

  it('尾斜杠与大小写不算漂移', () => {
    expect(normalizeBaseURL('https://API.minimaxi.com/v1///')).toBe('https://api.minimaxi.com/v1')
    const snapshot = snapshotProviderConnection(minimax)
    expect(
      providerDriftMessage(
        snapshot,
        { specId: 'minimax', baseURL: 'https://api.minimaxi.com/v1/' },
        'up-1'
      )
    ).toBeNull()
  })

  it('换协议与换 Base URL 都会拒绝续查，并带上上游任务号', () => {
    const snapshot = snapshotProviderConnection(minimax)
    const specDrift = providerDriftMessage(
      snapshot,
      { specId: 'seedance', baseURL: minimax.baseURL },
      'up-1'
    )
    expect(specDrift).toContain('协议从 minimax 变成 seedance')
    expect(specDrift).toContain('up-1')
    const urlDrift = providerDriftMessage(
      snapshot,
      { ...minimax, baseURL: 'https://evil.example' },
      'up-1'
    )
    expect(urlDrift).toContain('Base URL 从 https://api.minimaxi.com/v1 变成 https://evil.example')
    expect(urlDrift).toContain('已停止查询')
  })

  it('改动前提交的历史任务没有快照，不被倒推成漂移', () => {
    expect(providerDriftMessage(undefined, minimax, 'up-1')).toBeNull()
  })
})

describe('视频任务链路的接线', () => {
  const video = read('src/main/gateway/video.ts')

  it('提交时把连接快照写进任务，重启续跑才不会查错服务商', () => {
    expect(video).toContain('connection: snapshotProviderConnection(p)')
    expect(video).toMatch(
      /const st = await pollUpstream\(\s*poll,\s*requireLiveProvider\(input\.providerId\),\s*state\.connection,\s*upstreamId\s*\)/
    )
  })

  it('重启用任务同样先过漂移检查', () => {
    expect(video).toMatch(
      /void resumeLoop\(send, row, p, state\.upstreamTaskId, state\.connection\)/
    )
    expect(video).toMatch(/const st = await pollUpstream\(poll, p, connection, upstreamId\)/)
  })

  it('重发只认 UPSTREAM_RATE_LIMIT，其它错误原样抛出', () => {
    const retry = video.slice(
      video.indexOf('async function submitWithBackoff'),
      video.indexOf('/**\n * 单次续查')
    )
    expect(retry.length).toBeGreaterThan(100)
    expect(retry).toContain("error.code !== 'UPSTREAM_RATE_LIMIT'")
    expect(retry).toContain('await sleep(delay)')
    expect(retry).toContain('SUBMIT_RETRY_DELAYS_MS[attempt]')
  })

  it('轮询被限流不算任务失败：避免用户重新提交再扣一次费', () => {
    const guard = video.slice(
      video.indexOf('async function pollUpstream'),
      video.indexOf('export function submitVideoTask')
    )
    expect(guard.length).toBeGreaterThan(100)
    expect(guard).toContain(
      "if (error instanceof GatewayError && error.code === 'UPSTREAM_RATE_LIMIT')"
    )
    expect(guard).toContain("return { status: 'running' }")
    expect(guard).toContain('PROVIDER_DRIFTED')
  })
})

describe('网关错误出口统一', () => {
  it('音频与音色网关不再各自截断响应体', () => {
    for (const file of ['audio', 'voice']) {
      const source = read(`src/main/gateway/${file}.ts`)
      expect(source).not.toContain('slice(0, 200)')
      expect(source).not.toContain('slice(0, 180)')
      expect(source).toContain('describeUpstreamHttpError')
    }
  })

  it('图片网关的错误出口也走同一份归一化', () => {
    const image = read('src/main/gateway/image.ts')
    expect(image).toContain('describeUpstreamHttpError(res.status, body, context)')
    expect(image).not.toContain('slice(0, 180)')
  })
})
