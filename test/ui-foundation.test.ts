import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const foundation = readFileSync(resolve(root, 'src/renderer/src/assets/ui-foundation.css'), 'utf8')
const legacy = readFileSync(resolve(root, 'src/renderer/src/assets/app.css'), 'utf8')

describe('统一画布视觉基础', () => {
  it('连线和端口只保留低噪声的基础样式来源', () => {
    expect(foundation).toContain('.conn-main-path')
    expect(foundation).toContain('.port-dot')
    expect(foundation).toMatch(/stroke-dasharray\s*:\s*7\s+7/)
    expect(legacy).not.toContain('.conn-main-path')
    expect(legacy).not.toContain('.conn-glow-path')
  })

  it('常用下拉框与悬浮提示有统一组件样式', () => {
    expect(foundation).toContain('.app-select')
    expect(
      readFileSync(resolve(root, 'src/renderer/src/assets/ui-surfaces.css'), 'utf8')
    ).toContain('.app-tooltip')
  })
})
