// 生成链路的成本安全收口：错误归一化 + 供应商连接漂移保护 + 只在 429 重发提交。
// 这三条都是「花了钱不能重复花、报错了看得懂」的守卫，全部可离线断言。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
import { GatewayError } from '../src/main/gateway/factory'
import { UpstreamStatusError } from '../src/main/gateway/upstream-fetch'
import type { UpstreamState } from '../src/main/gateway/video'

// pollUpstream 的行为测试只需要注入 poll；video.ts 顶层的 store 依赖一律 mock 掉
vi.mock('../src/main/store/db', () => ({
  getDataDir: () => '',
  getDb: () => ({ prepare: () => ({ get: () => undefined, run: () => undefined }) })
}))

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
      /const st = await pollUpstream\(\s*poll,\s*requireLiveProvider\(input\.providerId\),\s*state\.connection,\s*upstreamId,\s*pollFailures\s*\)/
    )
  })

  it('重启用任务同样先过漂移检查', () => {
    expect(video).toMatch(
      /void resumeLoop\(send, row, p, state\.upstreamTaskId, state\.connection\)/
    )
    expect(video).toMatch(
      /const st = await pollUpstream\(poll, p, connection, upstreamId, pollFailures\)/
    )
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

  it('提交/轮询/下载全部走有界 fetch，不再有裸 fetch', () => {
    expect(video).toContain('fetchUpstream(url, init, CONTROL_TIMEOUT_MS, context)')
    expect(video).toContain('fetchUpstream(url, {}, DOWNLOAD_TIMEOUT_MS')
    // 唯一允许的 'await fetch(' 字样只出现在历史注释里，不能出现在代码行上
    const codeLines = video
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain('await fetch(')
  })

  it('提交前拒绝同节点在途任务，错误里带在途 taskId', () => {
    expect(video).toContain("status IN ('submitted', 'running')")
    expect(video).toContain('TASK_IN_FLIGHT')
    expect(video).toContain('等待其完成或先取消')
  })

  it('恢复轮询的超时基准从恢复时刻起算，不再用库中旧 updated_at', () => {
    const resume = video.slice(video.indexOf('async function resumeLoop'))
    expect(resume).toContain('const deadline = Date.now() + VIDEO_TIMEOUT_MS')
    expect(resume).not.toContain('row.updated_at + VIDEO_TIMEOUT_MS')
  })

  it('成片下载失败要重试且错误信息保留 URL 与 taskId', () => {
    expect(video).toContain('DOWNLOAD_RETRY_DELAYS_MS')
    expect(video).toContain('可用该地址人工取回')
    expect(video).toMatch(/taskId=\$\{taskId\} 成片地址=\$\{url\}/)
  })
})

describe('轮询连续瞬时错误容错', () => {
  const provider = {
    id: 'provider-a',
    name: 'MiniMax',
    specId: 'minimax',
    baseURL: 'https://api.minimaxi.com/v1',
    apiKey: 'k',
    createdAt: 0,
    models: []
  }

  const httpError = (status: number): GatewayError => {
    const e = describeUpstreamHttpError(status, '', '查询失败')
    return new UpstreamStatusError(e.code, e.message, status)
  }

  it('断网连续 4 次只继续轮询，第 5 次才把已计费任务判死', async () => {
    const { pollUpstream } = await import('../src/main/gateway/video')
    const failures = { count: 0 }
    let calls = 0
    const poll = async (): Promise<UpstreamState> => {
      calls += 1
      throw new TypeError('fetch failed')
    }
    for (let i = 1; i <= 4; i++) {
      await expect(pollUpstream(poll, provider, undefined, 'up-1', failures)).resolves.toEqual({
        status: 'running'
      })
      expect(failures.count).toBe(i)
    }
    await expect(pollUpstream(poll, provider, undefined, 'up-1', failures)).rejects.toThrow(
      'fetch failed'
    )
    expect(calls).toBe(5)
  })

  it('任何成功响应都会把连续失败计数清零', async () => {
    const { pollUpstream } = await import('../src/main/gateway/video')
    const failures = { count: 0 }
    let broken = true
    const poll = async (): Promise<UpstreamState> => {
      if (broken) throw new TypeError('fetch failed')
      return { status: 'running' }
    }
    for (let i = 0; i < 4; i++) {
      await pollUpstream(poll, provider, undefined, 'up-1', failures)
    }
    broken = false
    await pollUpstream(poll, provider, undefined, 'up-1', failures)
    expect(failures.count).toBe(0)
    broken = true
    // 清零后又可以再容忍整一轮连续瞬时错误
    for (let i = 0; i < 4; i++) {
      await expect(pollUpstream(poll, provider, undefined, 'up-1', failures)).resolves.toEqual({
        status: 'running'
      })
    }
    await expect(pollUpstream(poll, provider, undefined, 'up-1', failures)).rejects.toThrow(
      'fetch failed'
    )
  })

  it('查询超时按瞬时处理，不把仍在运行的任务判死', async () => {
    const { pollUpstream } = await import('../src/main/gateway/video')
    const failures = { count: 0 }
    const poll = async (): Promise<UpstreamState> => {
      throw new GatewayError('TIMEOUT', '上游 60 秒内没有响应')
    }
    for (let i = 0; i < 4; i++) {
      await expect(pollUpstream(poll, provider, undefined, 'up-1', failures)).resolves.toEqual({
        status: 'running'
      })
    }
    await expect(pollUpstream(poll, provider, undefined, 'up-1', failures)).rejects.toBeInstanceOf(
      GatewayError
    )
  })

  it('401/403/404 是确定性错误，第一次就立即失败', async () => {
    const { pollUpstream } = await import('../src/main/gateway/video')
    for (const status of [401, 403, 404]) {
      const failures = { count: 0 }
      const poll = async (): Promise<UpstreamState> => {
        throw httpError(status)
      }
      await expect(pollUpstream(poll, provider, undefined, 'up-1', failures)).rejects.toThrow(
        new RegExp(`HTTP ${status}`)
      )
      expect(failures.count).toBe(0)
    }
  })

  it('5xx 计入容错，429 仍是无条件容忍且不占容错计数', async () => {
    const { pollUpstream } = await import('../src/main/gateway/video')
    const failures = { count: 0 }
    let mode: 'rate' | 'server' = 'rate'
    const poll = async (): Promise<UpstreamState> => {
      throw httpError(mode === 'rate' ? 429 : 500)
    }
    for (let i = 0; i < 10; i++) {
      await expect(pollUpstream(poll, provider, undefined, 'up-1', failures)).resolves.toEqual({
        status: 'running'
      })
    }
    expect(failures.count).toBe(0)
    mode = 'server'
    for (let i = 1; i <= 4; i++) {
      await pollUpstream(poll, provider, undefined, 'up-1', failures)
      expect(failures.count).toBe(i)
    }
    await expect(pollUpstream(poll, provider, undefined, 'up-1', failures)).rejects.toThrow(
      'HTTP 500'
    )
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
