import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexHtml = readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8')

describe('渲染进程 CSP', () => {
  it('模型请求不从渲染进程直连网络，代码 Worker 只允许本地 blob 来源', () => {
    expect(indexHtml).toContain("worker-src 'self' blob:")
    expect(indexHtml).toContain("script-src 'self' blob: 'unsafe-eval'")
    expect(indexHtml).toContain("connect-src 'self' ws://localhost:*")
    expect(indexHtml).not.toContain("connect-src 'self' https: http: ws: wss:")
  })
})
