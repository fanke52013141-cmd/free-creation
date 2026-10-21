// 即梦 CLI 真实冒烟：会真实调用本机 CLI 并消耗会员额度。
//
// 默认跳过，只有显式设置 DREAMINA_LIVE_SMOKE=1 才运行：
//   $env:DREAMINA_LIVE_SMOKE='1'; npm test -- test/dreamina-live-smoke.test.ts
//
// 覆盖的是「纯协议层组装出来的 argv 能否在真实 CLI 上跑通」以及「真实 stdout
// 能否被 classifyDreaminaTask 正确归一化」——这两点是 mock 测不到的部分。
//
// 成本控制：图片用 3.0 + 1k + 1:1（最便宜组合），视频用 seedance2.0fast + 720p + 4 秒
// （该模型只开放 720p，时长取允许的最短值）。4 秒被拒时按用户要求回退到 5 秒。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildImageArgs,
  buildVideoArgs,
  classifyDreaminaTask
} from '@shared/dreamina-cli'

const LIVE = process.env.DREAMINA_LIVE_SMOKE === '1'
const liveDescribe = LIVE ? describe : describe.skip

function dreaminaBinary(): string {
  const override = process.env.CANVAS_STUDIO_DREAMINA_PATH?.trim()
  if (override) return override
  const exe = process.platform === 'win32' ? 'dreamina.exe' : 'dreamina'
  const home = process.env.USERPROFILE?.trim() || process.env.HOME?.trim()
  const installed = home ? join(home, 'bin', exe) : ''
  if (installed && existsSync(installed)) return installed
  return 'dreamina'
}

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function runDreamina(args: string[], timeoutMs = 180_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(dreaminaBinary(), args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`即梦 CLI 调用超时：${args[0]}`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function parseJson(stdout: string): Record<string, unknown> {
  const text = stdout.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return JSON.parse(start >= 0 ? text.slice(start, end + 1) : text) as Record<string, unknown>
}

/** 提交后按 2s 间隔轮询，直到终态或超时；返回最后一次 JSON。 */
async function pollUntilTerminal(
  submitId: string,
  timeoutMs = 1_200_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> = {}
  let transient = 0
  let lastLog = ''
  let lastLogAt = 0
  for (;;) {
    const result = await runDreamina([`query_result`, `--submit_id=${submitId}`], 120_000)
    if (result.code !== 0) {
      // 刚提交后记录可能还没可查（ret=1015）：属于瞬时错误，继续等。
      if (/ret=1015|get_history_by_ids failed/.test(`${result.stderr}${result.stdout}`)) {
        transient += 1
        if (transient > 120) throw new Error(`记录持续不可查：${submitId}`)
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        continue
      }
      throw new Error(`query_result 失败：${result.stderr || result.stdout}`)
    }
    transient = 0
    last = parseJson(result.stdout)
    const state = classifyDreaminaTask(last)
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled')
      return last
    const queue = last.queue_info as Record<string, unknown> | undefined
    if (queue?.queue_status) {
      // 视频排队可能持续数分钟，日志按 30s 或状态变化节流，避免刷屏。
      const line = `${String(queue.queue_status)}/${String(queue.queue_length)}/${String(last.estimated_remaining_seconds ?? '?')}`
      if (line !== lastLog || Date.now() - lastLogAt > 30_000) {
        lastLog = line
        lastLogAt = Date.now()
        console.log(
          `[smoke] 排队中 ${String(queue.queue_status)}，队列长度 ${String(queue.queue_length)}，预计 ${String(last.estimated_remaining_seconds ?? '?')}s`
        )
      }
    }
    if (Date.now() > deadline) throw new Error(`任务等待超时：${submitId}`)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

liveDescribe('即梦 CLI 真实冒烟', () => {
  it('探测：二进制可执行且已登录', async () => {
    const version = await runDreamina(['--version'], 30_000)
    expect(version.code).toBe(0)
    expect(parseJson(version.stdout).version).toBeTruthy()

    const credit = await runDreamina(['user_credit'], 30_000)
    expect(credit.code).toBe(0)
    const info = parseJson(credit.stdout)
    expect(typeof info.total_credit).toBe('number')
    console.log(
      `[smoke] 即梦 CLI ${String(parseJson(version.stdout).version)} · 额度 ${String(info.total_credit)}`
    )
  })

  it(
    '文生图：3.0 + 1k + 1:1（最便宜组合）能出图',
    async () => {
      const args = buildImageArgs({
        modelId: '3.0',
        prompt: '一只戴宇航员头盔的橘猫，霓虹街道背景，电影感光影',
        ratio: '1:1',
        resolution: '1k',
        referencePaths: []
      })
      console.log(`[smoke] text2image 参数：${args.join(' ')}`)
      const submitted = await runDreamina(args, 300_000)
      expect(submitted.code, submitted.stderr || submitted.stdout).toBe(0)
      const payload = parseJson(submitted.stdout)
      const submitId = String(payload.submit_id ?? '')
      expect(submitId).toBeTruthy()

      const final = await pollUntilTerminal(submitId)
      const state = classifyDreaminaTask(final)
      console.log(`[smoke] submit_id=${submitId} status=${state.status} url=${state.url ?? ''}`)
      expect(state.status).toBe('succeeded')
      expect(state.url).toBeTruthy()
    },
    600_000
  )

  it(
    '文生视频：seedance2.5 + 480p + 4 秒（4 秒被拒时回退 5 秒）',
    async () => {
      const attempt = async (duration: number): Promise<{ submitId: string; code: number; stderr: string }> => {
        const args = buildVideoArgs({
          modelId: 'seedance2.5',
          mode: 'text',
          prompt: '一只橘猫在霓虹街道上向前跑，镜头跟随',
          // 2.5 的三档里 480p 最便宜，且该模型的排队队列明显短于 2.0fast。
          resolution: '480p',
          ratio: '16:9',
          duration
        })
        console.log(`[smoke] text2video ${duration}s 参数：${args.join(' ')}`)
        const submitted = await runDreamina(args, 300_000)
        const payload = submitted.code === 0 ? parseJson(submitted.stdout) : {}
        return {
          submitId: String(payload.submit_id ?? ''),
          code: submitted.code ?? -1,
          stderr: submitted.stderr || submitted.stdout
        }
      }

      let first = await attempt(4)
      if (first.code !== 0 || !first.submitId) {
        console.log(`[smoke] 4 秒未被接受（${first.stderr.slice(-160)}），按预算回退到 5 秒`)
        first = await attempt(5)
      }
      expect(first.code, first.stderr).toBe(0)
      expect(first.submitId).toBeTruthy()

      const final = await pollUntilTerminal(first.submitId)
      const state = classifyDreaminaTask(final)
      console.log(`[smoke] submit_id=${first.submitId} status=${state.status} url=${state.url ?? ''}`)
      expect(state.status).toBe('succeeded')
      expect(state.url).toBeTruthy()
    },
    1_500_000
  )
})
