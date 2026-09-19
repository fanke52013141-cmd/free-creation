// 成片下载落盘的真跑回归：本地 HTTP 服务 + 真 fetch + 真文件。
//
// 这条链路只在真实字节面前才会红：上一版用 FileHandle.createWriteStream() 写盘，
// pipeline 结束时 fd 已被流关掉，紧接着的 fh.sync() 必然抛 EBADF「file closed」，
// 于是成片明明完整落盘、任务却被标成 failed（2026-09-19 真实计费跑出来的缺陷）。
// 这里不起供应商，也不 mock fetch，只把 URL 换成本机服务。
import { createServer, type ServerResponse } from 'http'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ dataDir: '', payload: Buffer.alloc(0) }))

vi.mock('../src/main/store/db', () => ({
  getDataDir: () => h.dataDir,
  getDb: () => ({ prepare: () => ({ get: () => undefined, run: () => undefined }) })
}))

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
})
