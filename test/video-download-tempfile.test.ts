// 成片下载落盘的真跑回归：本地 HTTP 服务 + 真 fetch + 真文件。
//
// 这条链路只在真实字节面前才会红：上一版用 FileHandle.createWriteStream() 写盘，
// pipeline 结束时 fd 已被流关掉，紧接着的 fh.sync() 必然抛 EBADF「file closed」，
// 于是成片明明完整落盘、任务却被标成 failed（2026-09-19 真实计费跑出来的缺陷）。
// 这里不起供应商，也不 mock fetch，只把 URL 换成本机服务。
import { createServer, type ServerResponse } from 'http'
import { existsSync, readdirSync, rmSync } from 'fs'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayError } from '../src/main/gateway/factory'
import { saveFileAsset } from '../src/main/store/media.repo'
import type { GatewayEvent } from '../src/shared/contracts'
import type { MediaAsset } from '../src/shared/types'

const h = vi.hoisted(() => ({ dataDir: '', payload: Buffer.alloc(0) }))

vi.mock('../src/main/store/db', () => ({
  getDataDir: () => h.dataDir,
  getDb: () => ({ prepare: () => ({ get: () => undefined, run: () => undefined }) })
}))

// finalizeVideo 的入库路径只验证交接行为；真实落库/搬移由 media.repo 自己的测试负责
const h2 = vi.hoisted(() => ({ saveFileAsset: vi.fn(), readMediaBuffer: vi.fn() }))
vi.mock('../src/main/store/media.repo', () => h2)

const tmpVideoResidue = (): string[] =>
  readdirSync(h.dataDir).filter((name) => name.startsWith('tmp-video-'))

// 首个成功用例合法地留下一个已下载完成、等待入库交接的临时文件；
// 断言「失败路径零残留」前先清场，避免用例间互相污染。
function clearTmpVideoResidue(): void {
  for (const name of tmpVideoResidue()) rmSync(join(h.dataDir, name), { force: true })
}

/** 起一个只听 127.0.0.1 随机端口的一次性服务，返回 baseUrl 与关闭函数。 */
async function serve(onRequest: (res: ServerResponse) => void) {
  const server = createServer((_req, res) => onRequest(res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/out.mp4`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

let okServer: Awaited<ReturnType<typeof serve>>

beforeAll(async () => {
  h.dataDir = await mkdtemp(join(tmpdir(), 'video-download-'))
  // 4 MB 伪随机字节：足以让响应分成多个 chunk 流过 pipeline。
  h.payload = Buffer.alloc(4 * 1024 * 1024)
  for (let i = 0; i < h.payload.length; i += 4096) h.payload[i] = i % 251
  okServer = await serve((res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(h.payload.length) })
    let offset = 0
    // 64 KB 一片、写完一片再写下一片：走的是真背压，不是一次性灌进 socket 缓冲。
    const tick = (): void => {
      const next = h.payload.subarray(offset, offset + 64 * 1024)
      if (!next.length) {
        res.end()
        return
      }
      offset += next.length
      res.write(next, tick)
    }
    tick()
  })
})

afterAll(async () => {
  await okServer.close()
  await rm(h.dataDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('视频成片的流式下载', () => {
  it('写满字节且不抛「file closed」，返回的临时文件可以原样读回', async () => {
    const { downloadToTempFile } = await import('../src/main/gateway/video')
    const tmp = await downloadToTempFile(okServer.url)
    expect(tmp.startsWith(h.dataDir)).toBe(true)
    const got = await readFile(tmp)
    expect(got.length).toBe(h.payload.length)
    expect(got.equals(h.payload)).toBe(true)
  })

  it('HTTP 非 2xx 时报的是带状态码的下载失败', async () => {
    const { downloadToTempFile } = await import('../src/main/gateway/video')
    const bad = await serve((res) => {
      res.writeHead(403)
      res.end('forbidden')
    })
    await expect(downloadToTempFile(bad.url)).rejects.toThrow(/下载成片失败：HTTP 403/)
    await bad.close()
  })

  it('中途断流不留下半截 tmp-video-* 文件', async () => {
    clearTmpVideoResidue()
    const { downloadToTempFile } = await import('../src/main/gateway/video')
    const partial = await serve((res) => {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(h.payload.length)
      })
      // 只发一小片就掐断连接：客户端 pipeline 必然失败
      res.write(h.payload.subarray(0, 64 * 1024), () => {
        res.destroy(new Error('connection reset'))
      })
    })
    await expect(downloadToTempFile(partial.url)).rejects.toThrow()
    expect(tmpVideoResidue()).toEqual([])
    await partial.close()
  })
})

describe('成片下载失败的成本兜底（R-05c/R-30）', () => {
  beforeEach(clearTmpVideoResidue)

  it('下载重试耗尽后判 DOWNLOAD_FAILED，错误信息保留 taskId 与成片 URL', async () => {
    const { finalizeVideo } = await import('../src/main/gateway/video')
    const bad = await serve((res) => {
      res.writeHead(500)
      res.end('boom')
    })
    const events: GatewayEvent[] = []
    // retryDelays 注入 [1,1]：共 3 次尝试，测试不等真实退避
    const error = await finalizeVideo(
      (e) => events.push(e),
      'task-x',
      'project-x',
      bad.url,
      [1, 1]
    ).then(
      () => undefined,
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(GatewayError)
    const message = (error as Error).message
    expect(message).toContain('task-x')
    expect(message).toContain(bad.url)
    expect(message).toContain('人工取回')
    // 失败不发 video-done，也不入库
    expect(events).toEqual([])
    expect(h2.saveFileAsset).not.toHaveBeenCalled()
    expect(tmpVideoResidue()).toEqual([])
    await bad.close()
  })

  it('入库失败时 best-effort 删除临时文件，不泄漏 tmp-video-*', async () => {
    const { finalizeVideo } = await import('../src/main/gateway/video')
    h2.saveFileAsset.mockImplementationOnce(
      async (_projectId: string, tmp: string): Promise<MediaAsset> => {
        expect(existsSync(tmp)).toBe(true) // 下载已完整落盘
        throw new Error('disk full')
      }
    )
    await expect(
      finalizeVideo(() => undefined, 'task-y', 'project-y', okServer.url, [1, 1])
    ).rejects.toThrow('disk full')
    expect(tmpVideoResidue()).toEqual([])
  })

  it('下载成功路径行为不变：入库并发 video-done', async () => {
    const { finalizeVideo } = await import('../src/main/gateway/video')
    h2.saveFileAsset.mockImplementationOnce(
      async (_projectId: string, tmp: string): Promise<MediaAsset> => {
        const got = await readFile(tmp)
        expect(got.equals(h.payload)).toBe(true)
        // 真实 saveFileAsset 登记后会把临时文件移走，这里模拟同一契约
        await rm(tmp, { force: true })
        return {
          id: 'm-1',
          kind: 'video',
          mime: 'video/mp4',
          path: 'projects/project-z/m-1.mp4',
          sizeBytes: got.length,
          createdAt: 0
        }
      }
    )
    const events: GatewayEvent[] = []
    await finalizeVideo((e) => events.push(e), 'task-z', 'project-z', okServer.url, [1, 1])
    expect(events).toEqual([
      {
        kind: 'video-done',
        taskId: 'task-z',
        mediaId: 'm-1',
        mediaPath: 'projects/project-z/m-1.mp4',
        name: 'm-1',
        mime: 'video/mp4'
      }
    ])
    expect(tmpVideoResidue()).toEqual([])
  })
})
