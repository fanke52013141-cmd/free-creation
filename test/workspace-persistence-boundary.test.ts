// 创作数据不能退回浏览器 localStorage；模板与历史版本必须通过主进程 workspace IPC。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(process.cwd(), 'src/renderer/src')

describe('本地工作区持久化边界', () => {
  it('模板和历史版本 store 不使用 localStorage，且调用主进程 workspace API', () => {
    for (const relativePath of ['stores/workflow.ts', 'stores/history-snapshots.ts']) {
      const source = readFileSync(resolve(rendererRoot, relativePath), 'utf8')
      expect(source).not.toContain('localStorage')
      expect(source).toContain('window.api.workspace')
    }
  })
})
